import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SMS_WEBHOOK_HEADERS } from '@queuebridge/channels';
import {
  FacilitySmsSettingsUpdateSchema,
  SecretTokenSchema,
  TicketCodeSchema,
} from '@queuebridge/contracts';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput, problems } from '../errors.js';
import { queueFacility, resolveStatusToken, type ResolvedStatusTicket } from '../queue/views.js';
import {
  applyDeliveryReceipt,
  applyInboundMessage,
  facilitySmsSettings,
  optOutTicket,
  smsDeployment,
  smsStateForTicket,
  updateFacilitySmsSettings,
} from '../sms/service.js';
import { uuidParam, type RouteDeps } from './deps.js';
import { TICKET_TOKEN_HEADER } from './public.js';

/**
 * M6.1 SMS routes (design §13): facility setting (API only; the channel screen is M6.3), visitor
 * and staff opt-out, and the provider webhook. No route returns, logs or audits a phone number.
 */
export async function smsRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;
  const dep = smsDeployment(env);
  const limited = {
    config: { rateLimit: { max: env.SMS_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };

  /** GET /facilities/:id/sms — the facility's SMS setting and today's usage (readers). */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/sms',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      return reply.send({
        sms: await facilitySmsSettings(db, dep, auth.organizationId, facility.id),
      });
    },
  );

  /** PUT /facilities/:id/sms — turn SMS on or off with a per-facility daily cap (admins). */
  app.put<{ Params: { id: string } }>(
    '/facilities/:id/sms',
    { preHandler: authenticate, ...limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const body = parseInput(FacilitySmsSettingsUpdateSchema, req.body);
      await updateFacilitySmsSettings(db, {
        organizationId: auth.organizationId,
        facilityId: facility.id,
        actorId: auth.staffUserId,
        enabled: body.enabled,
        dailyCap: body.daily_cap,
        deploymentAvailable: dep.available,
      });
      return reply.send({
        sms: await facilitySmsSettings(db, dep, auth.organizationId, facility.id),
      });
    },
  );

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

  /**
   * POST /tickets/:code/sms/opt-out — the visitor stops SMS for this ticket (status token).
   * Never refused for a valid token and idempotent; the number is erased at once.
   */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/sms/opt-out',
    limited,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      await optOutTicket(db, {
        organizationId: resolved.ticket.organization_id,
        facilityId: resolved.facilityId,
        ticketId: resolved.ticket.id,
        source: 'visitor',
        actorId: null,
      });
      return reply.send({
        sms_alert: await smsStateForTicket(db, resolved.ticket.organization_id, resolved.ticket.id),
      });
    },
  );

  /**
   * POST /queues/:queueId/tickets/:ticketId/sms/opt-out — staff stop SMS for a visitor at the
   * desk (`WALK_IN` roles at the queue's facility; audited, without the number).
   */
  app.post<{ Params: { queueId: string; ticketId: string } }>(
    '/queues/:queueId/tickets/:ticketId/sms/opt-out',
    { preHandler: authenticate, ...limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const queueId = uuidParam(req.params.queueId);
      const ticketId = uuidParam(req.params.ticketId);
      const facilityId = await queueFacility(db, auth.organizationId, queueId);
      if (!facilityId) throw problems.notFound();
      await requireFacilityPermission(db, auth, facilityId, 'WALK_IN');
      const [t] = await db<{ id: string }[]>`
        SELECT id FROM tickets
         WHERE id = ${ticketId} AND queue_session_id = ${queueId} AND organization_id = ${auth.organizationId}`;
      if (!t) throw problems.notFound();
      await optOutTicket(db, {
        organizationId: auth.organizationId,
        facilityId,
        ticketId: t.id,
        source: 'staff',
        actorId: auth.staffUserId,
      });
      return reply.send({ sms_alert: await smsStateForTicket(db, auth.organizationId, t.id) });
    },
  );
}

/**
 * POST /webhooks/sms/:provider — provider receipts and inbound replies (REQ-F11.12; security
 * steering "Webhook security"). Registered in its own plugin so the raw-body parser (the
 * signature covers the exact bytes) applies to this route only. No cookie or session is used.
 *
 * Order: provider must be the configured one (else 404) → structure (JSON, signature headers)
 * → signature and timestamp window (401) → nonce, once per provider (409) → apply.
 * The response never says whether a message id exists. Rejections log provider and source
 * address only, never the payload.
 */
export async function smsWebhookRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env } = deps;
  const dep = smsDeployment(env);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { provider: string } }>(
    '/webhooks/sms/:provider',
    {
      bodyLimit: 16 * 1024,
      config: { rateLimit: { max: env.SMS_WEBHOOK_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const adapter = dep.adapter;
      if (!adapter || req.params.provider !== adapter.provider) throw problems.notFound();
      const raw = typeof req.body === 'string' ? req.body : null;
      let payload: unknown;
      try {
        payload = raw === null ? undefined : JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      const headers: Record<string, string> = {};
      for (const h of Object.values(SMS_WEBHOOK_HEADERS)) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      if (raw === null || payload === undefined || Object.keys(headers).length !== 3) {
        throw new ApiProblem(400, 'sms-webhook-malformed', 'Malformed webhook');
      }
      if (!adapter.verifyWebhook(headers, raw)) {
        req.log.warn(
          { provider: adapter.provider, source: req.ip },
          'SMS webhook rejected: invalid signature',
        );
        throw new ApiProblem(401, 'sms-webhook-signature', 'Invalid webhook signature');
      }
      const fresh = await db<{ nonce: string }[]>`
        INSERT INTO sms_webhook_nonces (provider, nonce)
        VALUES (${adapter.provider}, ${headers[SMS_WEBHOOK_HEADERS.nonce] ?? ''})
        ON CONFLICT (provider, nonce) DO NOTHING
        RETURNING nonce`;
      if (fresh.length === 0) {
        req.log.warn(
          { provider: adapter.provider, source: req.ip },
          'SMS webhook rejected: replay',
        );
        throw new ApiProblem(409, 'sms-webhook-replay', 'Webhook already received');
      }
      const inbound = adapter.parseInboundMessage(payload);
      if (inbound) {
        // Tenant-scoped: applied only to the one organization this number's messages came from
        const r = await applyInboundMessage(db, dep.cipher, adapter.provider, inbound);
        req.log.info(
          {
            provider: adapter.provider,
            sandbox: adapter.sandbox,
            stop: r.stop,
            opted_out: r.optedOut,
            attribution: r.attribution,
          },
          adapter.sandbox ? '[SANDBOX] SMS inbound reply' : 'SMS inbound reply',
        );
        return reply.send({ ok: true });
      }
      let receipt;
      try {
        receipt = adapter.parseDeliveryReceipt(payload);
      } catch {
        throw new ApiProblem(422, 'sms-webhook-unrecognized', 'Unrecognized webhook event');
      }
      const outcome = await applyDeliveryReceipt(db, adapter.provider, adapter.sandbox, receipt);
      req.log.info(
        { provider: adapter.provider, sandbox: adapter.sandbox, outcome },
        adapter.sandbox ? '[SANDBOX] SMS delivery receipt' : 'SMS delivery receipt',
      );
      return reply.send({ ok: true });
    },
  );
}
