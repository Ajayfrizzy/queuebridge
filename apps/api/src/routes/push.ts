import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import {
  AlertAckRequestSchema,
  PushSubscribeRequestSchema,
  PushUnsubscribeRequestSchema,
  SecretTokenSchema,
  TicketCodeSchema,
  TicketState,
  TURN_ALERT_DEFAULTS,
  type PushCapability,
  type StaffTicketAlerts,
} from '@queuebridge/contracts';
import {
  DEFAULT_PUSH_HOSTS,
  createSubscriptionCipher,
  endpointHash,
  validatePushEndpoint,
} from '@queuebridge/channels';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput, problems } from '../errors.js';
import { queueFacility, resolveStatusToken, type ResolvedStatusTicket } from '../queue/views.js';
import { TICKET_TOKEN_HEADER } from './public.js';
import { uuidParam, type RouteDeps } from './deps.js';

/** Ticket states from which a future call is still possible (push is pointless otherwise). */
const PUSHABLE = new Set<string>([
  TicketState.WAITING,
  TicketState.CALLED,
  TicketState.PAUSED,
  TicketState.MISSED,
]);

/** Uncompressed P-256 public key, base64url, 65 bytes starting 0x04. */
function validVapidPublicKey(k: string | undefined): k is string {
  if (!k) return false;
  try {
    const b = Buffer.from(k, 'base64url');
    return b.length === 65 && b[0] === 4;
  } catch {
    return false;
  }
}

/**
 * Whether this deployment can offer Web Push: a valid VAPID public key AND CONTACT_ENCRYPTION_KEY
 * (subscriptions are stored encrypted). The single check behind `GET /push/capability` and the
 * Ask Que capability manifest's `turn_alert_web_push` availability (MQ.1, decision D1).
 */
export function webPushAvailable(
  env: Pick<RouteDeps['env'], 'CONTACT_ENCRYPTION_KEY' | 'VAPID_PUBLIC_KEY'>,
): boolean {
  return Boolean(
    createSubscriptionCipher(env.CONTACT_ENCRYPTION_KEY) &&
      validVapidPublicKey(env.VAPID_PUBLIC_KEY),
  );
}
/** Subscription changes (subscribe or turn off) allowed per ticket per minute, across instances. */
export const PUSH_CHANGES_PER_TICKET_PER_MINUTE = 20;

/**
 * Count one subscription change for a ticket in PostgreSQL (one atomic upsert, so every API
 * instance shares the limit) and say whether it is within the limit. The window resets itself
 * after a minute: there is no lock-out and nothing to unlock. Committed on its own, so a refused
 * request still counts.
 */
async function allowSubscriptionChange(db: Db, ticketId: string): Promise<boolean> {
  const [r] = await db<{ changes: number }[]>`
    INSERT INTO push_subscription_throttle AS t (ticket_id, window_started_at, changes)
    VALUES (${ticketId}, NOW(), 1)
    ON CONFLICT (ticket_id) DO UPDATE SET
      changes = CASE WHEN t.window_started_at <= NOW() - INTERVAL '1 minute' THEN 1
                     ELSE t.changes + 1 END,
      window_started_at = CASE WHEN t.window_started_at <= NOW() - INTERVAL '1 minute' THEN NOW()
                               ELSE t.window_started_at END
    RETURNING changes`;
  return (r?.changes ?? 0) <= PUSH_CHANGES_PER_TICKET_PER_MINUTE;
}

function tooManyChanges(): ApiProblem {
  return new ApiProblem(429, 'too-many-requests', 'Too many requests', {
    detail: 'Too many changes to push alerts for this ticket. Wait a minute and try again.',
  });
}

/**
 * M5.4 Web Push routes (design §12.5.2). Visitor routes require the ticket's status token (the
 * public code in the path is only a consistency check, exactly as for ticket status); every
 * failure to resolve is the same 404. A `subscription_ref` that does not belong to the token's
 * ticket is a 404. Endpoint URLs and keys are accepted once, stored encrypted, and never
 * returned or logged. CSRF and Origin are enforced by the global hook for state-changing routes.
 */
export async function pushRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;
  const cipher = createSubscriptionCipher(env.CONTACT_ENCRYPTION_KEY);
  const live = webPushAvailable(env);
  if (env.VAPID_PUBLIC_KEY && !validVapidPublicKey(env.VAPID_PUBLIC_KEY)) {
    app.log.warn('VAPID_PUBLIC_KEY is not a valid P-256 public key: Web Push is disabled');
  }
  const hosts = [...DEFAULT_PUSH_HOSTS, ...env.PUSH_ENDPOINT_HOSTS];
  const max = env.PUSH_MAX_SUBSCRIPTIONS_PER_TICKET;
  const visitorRoute = {
    config: { rateLimit: { max: env.JOIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };

  async function resolveTicket(
    req: FastifyRequest<{ Params: { code: string } }>,
  ): Promise<ResolvedStatusTicket> {
    const code = TicketCodeSchema.safeParse(req.params.code);
    const token = SecretTokenSchema.safeParse(req.headers[TICKET_TOKEN_HEADER]);
    if (!code.success || !token.success) throw problems.notFound();
    const resolved = await resolveStatusToken(db, token.data, code.data);
    if (!resolved) throw problems.notFound();
    return resolved;
  }

  /** GET /push/capability — public; whether this deployment can send Web Push. */
  app.get(
    '/push/capability',
    { config: { rateLimit: { max: env.PUBLIC_READ_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const body: PushCapability = {
        web_push: live ? 'live' : 'disabled',
        ...(live ? { public_key: env.VAPID_PUBLIC_KEY } : {}),
        ttl_seconds: env.TURN_ALERT_TTL_SECONDS,
        max_subscriptions_per_ticket: max,
      };
      return reply.send(body);
    },
  );

  /** POST /tickets/:code/push-subscription — opt in this device (idempotent per endpoint). */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/push-subscription',
    visitorRoute,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      if (!live || !cipher) {
        throw new ApiProblem(503, 'push-disabled', 'Push alerts are not available', {
          detail:
            'Push alerts are not set up here. The ticket page and the public board still show your turn.',
        });
      }
      const body = parseInput(PushSubscribeRequestSchema, req.body);
      if (!validatePushEndpoint(body.endpoint, hosts)) {
        throw new ApiProblem(400, 'push-endpoint-not-allowed', 'Push service not supported', {
          detail: 'This browser’s push service is not supported here.',
        });
      }
      const t = resolved.ticket;
      if (!PUSHABLE.has(t.state)) {
        throw new ApiProblem(409, 'ticket-ended', 'Ticket ended', {
          detail: 'This ticket can no longer be called, so push alerts are not needed.',
        });
      }
      if (!(await allowSubscriptionChange(db, t.id))) throw tooManyChanges();
      const hash = endpointHash(body.endpoint);
      const endpointCt = cipher.seal(body.endpoint);
      const keysCt = cipher.seal(JSON.stringify(body.keys));
      const result = await db.begin(async (tx) => {
        // Serialize subscribe/unsubscribe for ONE ticket (the cap must hold under concurrency).
        // An advisory lock, not the ticket row, so queue commands are never delayed by it.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`qb:push:${t.id}`}, 0))`;
        const [existing] = await tx<{ id: string; active: boolean }[]>`
          SELECT id, (revoked_at IS NULL AND expires_at > NOW()) AS active FROM push_subscriptions
           WHERE ticket_id = ${t.id} AND endpoint_hash = ${hash}`;
        if (!existing?.active) {
          const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM push_subscriptions
             WHERE ticket_id = ${t.id} AND revoked_at IS NULL AND expires_at > NOW()`;
          if (n >= max) {
            throw new ApiProblem(
              409,
              'push-subscription-limit',
              'Push is on for too many devices',
              {
                detail: `Push is already on for ${max} devices. Turn it off on one first.`,
              },
            );
          }
        }
        const expires = `${TURN_ALERT_DEFAULTS.subscriptionLifetimeHours} hours`;
        if (existing) {
          // Same device, same ticket: the SAME subscription_id (stable under re-subscription)
          const [row] = await tx<{ id: string; expires_at: Date }[]>`
            UPDATE push_subscriptions
               SET endpoint_ct = ${endpointCt}, keys_ct = ${keysCt}, revoked_at = NULL,
                   revoke_reason = NULL, credential_id = ${resolved.tokenId}, failure_count = 0,
                   expires_at = CASE WHEN revoked_at IS NULL AND expires_at > NOW() THEN expires_at
                                     ELSE NOW() + ${expires}::interval END
             WHERE id = ${existing.id}
            RETURNING id, expires_at`;
          return { row, created: false };
        }
        const [row] = await tx<{ id: string; expires_at: Date }[]>`
          INSERT INTO push_subscriptions
            (organization_id, facility_id, ticket_id, credential_id, endpoint_hash, endpoint_ct,
             keys_ct, expires_at)
          VALUES (${t.organization_id}, ${resolved.facilityId}, ${t.id}, ${resolved.tokenId}, ${hash},
                  ${endpointCt}, ${keysCt}, NOW() + ${expires}::interval)
          RETURNING id, expires_at`;
        return { row, created: true };
      });
      if (!result.row) throw new Error('push subscription write returned no row');
      return reply.status(result.created ? 201 : 200).send({
        subscription_ref: result.row.id,
        expires_at: result.row.expires_at.toISOString(),
      });
    },
  );

  /** DELETE /tickets/:code/push-subscription — turn push off (revoked at once; idempotent). */
  app.delete<{ Params: { code: string } }>(
    '/tickets/:code/push-subscription',
    visitorRoute,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      const body = parseInput(PushUnsubscribeRequestSchema, req.body);
      // Counted (it is churn) but never refused: turning push off is a privacy action
      await allowSubscriptionChange(db, resolved.ticket.id);
      const [row] = await db<{ id: string }[]>`
        SELECT id FROM push_subscriptions
         WHERE id = ${body.subscription_ref} AND ticket_id = ${resolved.ticket.id}
           AND organization_id = ${resolved.ticket.organization_id}`;
      if (!row) throw problems.notFound();
      await db`
        UPDATE push_subscriptions
           SET revoked_at = NOW(), revoke_reason = 'visitor', endpoint_ct = NULL, keys_ct = NULL
         WHERE id = ${row.id} AND revoked_at IS NULL`;
      return reply.status(204).send();
    },
  );

  /**
   * POST /tickets/:code/alerts/ack — the visitor's PAGE (it holds the status token; the service
   * worker holds none) confirms it showed the push. Only this, or a provider receipt, may turn
   * `sent` into `delivered` (REQ-F14.6.2). Always 204 for an owned ref (no oracle).
   */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/alerts/ack',
    visitorRoute,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      const body = parseInput(AlertAckRequestSchema, req.body);
      const [owned] = await db<{ id: string }[]>`
        SELECT id FROM push_subscriptions
         WHERE id = ${body.subscription_ref} AND ticket_id = ${resolved.ticket.id}
           AND organization_id = ${resolved.ticket.organization_id}`;
      if (!owned) throw problems.notFound();
      await db.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE notifications SET status = 'delivered', detail_code = 'client_ack', updated_at = NOW()
           WHERE push_subscription_id = ${owned.id} AND event_sequence = ${body.event_sequence}
             AND channel = 'web_push' AND status IN ('pending', 'sent', 'unknown')
          RETURNING id`;
        for (const r of rows) {
          await tx`
            INSERT INTO notification_deliveries (notification_id, provider, receipt_status, detail_code)
            VALUES (${r.id}, 'web_push', 'delivered', 'client_ack')`;
        }
      });
      return reply.status(204).send();
    },
  );

  /** GET /queues/:id/alerts — staff: per called ticket, per device, plain states only. */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/alerts',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const queueId = uuidParam(req.params.id);
      const facilityId = await queueFacility(db, auth.organizationId, queueId);
      if (!facilityId) throw problems.notFound();
      await requireFacilityPermission(db, auth, facilityId, 'QUEUE_VIEW');
      const rows = await db<
        {
          ticket_id: string;
          public_code: string;
          subscription_ref: string | null;
          state: string | null;
          detail_code: string | null;
          updated_at: Date | null;
        }[]
      >`
        WITH called AS (
          SELECT t.id, t.public_code,
                 (SELECT e.sequence FROM ticket_transitions tt JOIN queue_events e ON e.id = tt.queue_event_id
                   WHERE tt.ticket_id = t.id AND tt.to_state = 'called' ORDER BY e.sequence DESC LIMIT 1) AS seq
            FROM tickets t
           WHERE t.queue_session_id = ${queueId} AND t.organization_id = ${auth.organizationId}
             AND t.state = 'called')
        SELECT c.id AS ticket_id, c.public_code, n.push_subscription_id AS subscription_ref,
               n.status AS state, n.detail_code, n.updated_at
          FROM called c
          LEFT JOIN notifications n ON n.ticket_id = c.id AND n.channel = 'web_push'
                                   AND n.event_sequence = c.seq AND n.push_subscription_id IS NOT NULL
         ORDER BY c.public_code, n.push_subscription_id`;
      const byTicket = new Map<string, StaffTicketAlerts>();
      for (const r of rows) {
        const entry = byTicket.get(r.ticket_id) ?? {
          ticket_id: r.ticket_id,
          public_code: r.public_code,
          devices: [],
        };
        if (r.subscription_ref && r.state && r.updated_at) {
          entry.devices.push({
            subscription_ref: r.subscription_ref,
            state: r.state as StaffTicketAlerts['devices'][number]['state'],
            detail_code: r.detail_code,
            updated_at: r.updated_at.toISOString(),
          });
        }
        byTicket.set(r.ticket_id, entry);
      }
      // M6.1: the SMS alert for the same call (no number, no text), and whether staff can stop it
      const ids = [...byTicket.keys()];
      if (ids.length > 0) {
        const sms = await db<
          {
            ticket_id: string;
            state: string | null;
            detail_code: string | null;
            provider: string | null;
            updated_at: Date | null;
            active: boolean;
          }[]
        >`
          SELECT t.id AS ticket_id, n.status AS state, n.detail_code, n.provider, n.updated_at,
                 (vc.phone_ciphertext IS NOT NULL) AS active
            FROM tickets t
            LEFT JOIN visitor_contacts vc ON vc.ticket_id = t.id AND vc.organization_id = t.organization_id
            LEFT JOIN LATERAL (
              SELECT n.status, n.detail_code, n.provider, n.updated_at FROM notifications n
               WHERE n.ticket_id = t.id AND n.channel = 'sms'
                 AND n.event_sequence = (
                   SELECT e.sequence FROM ticket_transitions tt JOIN queue_events e ON e.id = tt.queue_event_id
                    WHERE tt.ticket_id = t.id AND tt.to_state = 'called' ORDER BY e.sequence DESC LIMIT 1)
               ORDER BY n.created_at DESC LIMIT 1) n ON TRUE
           WHERE t.id = ANY(${ids}::uuid[]) AND t.organization_id = ${auth.organizationId}`;
        for (const s of sms) {
          const entry = byTicket.get(s.ticket_id);
          if (!entry) continue;
          entry.sms_active = s.active;
          entry.sms =
            s.state && s.updated_at
              ? {
                  state: s.state as NonNullable<StaffTicketAlerts['sms']>['state'],
                  detail_code: s.detail_code,
                  // pending rows have no provider yet: this build can only send through the sandbox
                  sandbox: s.provider === null || s.provider === 'sandbox',
                  updated_at: s.updated_at.toISOString(),
                }
              : null;
        }
      }
      return reply.send({ alerts: [...byTicket.values()] });
    },
  );
}
