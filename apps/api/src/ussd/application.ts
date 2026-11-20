import type {
  UssdApplication,
  UssdFacilityRef,
  UssdJoinResult,
  UssdTicketResult,
  UssdTicketState,
} from '@queuebridge/channels';
import type { WaitEstimate } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { ApiProblem } from '../errors.js';
import { hashJoinProof, joinQueue } from '../queue/joins.js';
import {
  findPublicFacility,
  publicFacilityView,
  resolveVerifiedTicket,
  ticketStatusView,
} from '../queue/views.js';
import type { RecoveryCrypto } from '../recovery/crypto.js';
import { verifyRecoveryKey } from '../recovery/service.js';
import type { ThrottleLimits } from '../recovery/throttle.js';
import type { UssdCrypto } from './crypto.js';

/**
 * M6.2: the queue operations the USSD menu drives, implemented with the EXISTING services only:
 * - discovery: the public catalog (`findPublicFacility`, `publicFacilityView`; only queues
 *   accepting visitors), for facilities that opted in to USSD (`facility_ussd_settings`);
 * - joining: `joinQueue` (same session lock, acceptance checks, idempotency by operation id and
 *   a session-bound join proof), channel `ussd`; never an offline or provisional ticket;
 * - status and recovery: the recovery-key check (`verifyRecoveryKey`: same throttles, uniform
 *   failure) and the token-free resolution of the verified ticket, then `ticketStatusView`.
 * A public ticket code or a phone number alone never opens anything. Every lookup is scoped to
 * the facility the session is bound to and that facility's organization.
 */
export interface UssdApplicationDeps {
  db: Db;
  crypto: UssdCrypto;
  recovery: RecoveryCrypto | null;
  limits: ThrottleLimits;
  joinsPerPhonePerHour: number;
}

/** "10-20 min", or null when there is not enough data (an estimate is never a promise). */
export function estimateText(e: WaitEstimate | null | undefined): string | null {
  if (!e || e.confidence === 'insufficient_data') return null;
  const lo = Math.max(1, Math.round(e.low_seconds / 60));
  const hi = Math.max(lo, Math.round(e.high_seconds / 60));
  return lo === hi ? `${lo} min` : `${lo}-${hi} min`;
}

const STATES: ReadonlySet<string> = new Set([
  'waiting',
  'called',
  'serving',
  'paused',
  'missed',
  'transferred',
]);

export function createUssdApplication(deps: UssdApplicationDeps): UssdApplication {
  const { db } = deps;

  /** The facility, still public (active) and still offering USSD; null otherwise. */
  async function liveFacility(f: { facilityId: string; organizationId: string }): Promise<{
    row: NonNullable<Awaited<ReturnType<typeof findPublicFacility>>>;
    orgSlug: string;
    facilitySlug: string;
  } | null> {
    const [s] = await db<{ org_slug: string; facility_slug: string }[]>`
      SELECT o.slug AS org_slug, f.slug AS facility_slug
        FROM facility_ussd_settings u
        JOIN facilities f ON f.id = u.facility_id AND f.organization_id = u.organization_id
        JOIN organizations o ON o.id = f.organization_id
       WHERE u.facility_id = ${f.facilityId} AND u.organization_id = ${f.organizationId} AND u.enabled`;
    if (!s) return null;
    const row = await findPublicFacility(db, s.org_slug, s.facility_slug);
    if (!row || row.id !== f.facilityId || row.organization_id !== f.organizationId) return null;
    return { row, orgSlug: s.org_slug, facilitySlug: s.facility_slug };
  }

  return {
    async findFacility(_caller, accessCode): Promise<UssdFacilityRef | null> {
      const [u] = await db<{ facility_id: string; organization_id: string }[]>`
        SELECT facility_id, organization_id FROM facility_ussd_settings
         WHERE access_code = ${accessCode} AND enabled`;
      if (!u) return null;
      const live = await liveFacility({
        facilityId: u.facility_id,
        organizationId: u.organization_id,
      });
      if (!live) return null;
      return {
        facilityId: live.row.id,
        organizationId: live.row.organization_id,
        name: live.row.name,
      };
    },

    async listServices(_caller, facility) {
      const live = await liveFacility(facility);
      if (!live) return [];
      const view = await publicFacilityView(db, live.row);
      return view.queues
        .filter((q) => q.accepting_visitors)
        .map((q) => ({
          queueId: q.queue_id,
          name: q.service_name,
          waiting: q.waiting_count,
          estimate: estimateText(q.estimate),
        }));
    },

    async join(caller, facility, queueId, operationId): Promise<UssdJoinResult> {
      const live = await liveFacility(facility);
      if (!live) return { ok: false, reason: 'not_accepting' };
      const [queue] = await db<{ id: string }[]>`
        SELECT id FROM queue_sessions
         WHERE id = ${queueId} AND facility_id = ${facility.facilityId}
           AND organization_id = ${facility.organizationId}`;
      if (!queue) return { ok: false, reason: 'not_accepting' };
      // The USSD counterpart of the per-address web join limit (all USSD traffic shares the
      // provider's address). A replay of this session's own join is never counted against it.
      const [prior] = await db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM client_operations
         WHERE organization_id = ${facility.organizationId} AND operation_id = ${operationId}`;
      if ((prior?.n ?? 0) === 0) {
        const [recent] = await db<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM ussd_sessions
           WHERE msisdn_hash = ${caller.msisdnHash} AND joined_at > NOW() - INTERVAL '1 hour'
             AND provider_session_key_hash <> ${caller.sessionKeyHash}`;
        if ((recent?.n ?? 0) >= deps.joinsPerPhonePerHour) return { ok: false, reason: 'limit' };
      }
      try {
        const r = await joinQueue(db, {
          organizationId: facility.organizationId,
          queueId,
          operationId,
          proofHash: hashJoinProof(deps.crypto.joinProof(caller.sessionKeyHash, operationId)),
          staffUserId: null,
          recovery: deps.recovery,
          channel: 'ussd',
        });
        return {
          ok: true,
          code: r.public_code,
          service: r.service_name,
          recoveryKey: r.recovery_key ?? null,
        };
      } catch (err) {
        if (err instanceof ApiProblem && (err.status === 409 || err.status === 404)) {
          const detail = err.detail ?? '';
          if (/paused/i.test(detail)) return { ok: false, reason: 'paused' };
          if (/closed/i.test(detail)) return { ok: false, reason: 'closed' };
          return { ok: false, reason: 'not_accepting' };
        }
        throw err;
      }
    },

    async checkTicket(caller, facility, ticketCode, rawKey): Promise<UssdTicketResult> {
      if (!deps.recovery) return { ok: false, reason: 'unavailable' };
      const live = await liveFacility(facility);
      if (!live) return { ok: false, reason: 'unavailable' };
      let verified;
      try {
        verified = await verifyRecoveryKey(db, deps.recovery, deps.limits, {
          orgSlug: live.orgSlug,
          facilitySlug: live.facilitySlug,
          ticketCode,
          rawKey,
          // One phone is one source (never the provider's address, never the guess)
          source: `ussd:${caller.msisdnHash}`,
        });
      } catch (err) {
        if (err instanceof ApiProblem && err.status === 429)
          return { ok: false, reason: 'throttled' };
        if (err instanceof ApiProblem && err.status === 404) return { ok: false, reason: 'failed' };
        throw err;
      }
      const resolved = await resolveVerifiedTicket(
        db,
        { organizationId: facility.organizationId, facilityId: facility.facilityId },
        verified.rootId,
        ticketCode,
      );
      if (!resolved) return { ok: false, reason: 'failed' };
      const status = await ticketStatusView(db, resolved, { recoveryEnabled: true });
      return {
        ok: true,
        code: status.public_code,
        service: status.service_name,
        state: (STATES.has(status.state) ? status.state : 'other') as UssdTicketState,
        ahead: status.position ?? null,
        counter: status.counter_name ?? null,
        estimate: estimateText(status.estimate),
        movedFrom: status.public_code !== ticketCode ? ticketCode : null,
      };
    },
  };
}
