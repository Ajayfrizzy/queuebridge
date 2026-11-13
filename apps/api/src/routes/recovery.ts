import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  RecoverTicketRequestSchema,
  RecoveryApproveRequestSchema,
  RecoveryAssistRequestSchema,
  RecoveryRevokeAllRequestSchema,
  RejoinRequestSchema,
  Role,
  SecretTokenSchema,
  TicketCodeSchema,
} from '@queuebridge/contracts';
import { queueActorRoles, requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { parseInput, problems } from '../errors.js';
import { sourceOf } from '../recovery/crypto.js';
import {
  approveRecovery,
  listRecoveryRequests,
  recoverWithGrant,
  recoverWithKey,
  recoveryRequestStatus,
  recoveryUnavailable,
  regenerateRecoveryKey,
  rejoin,
  revokeOtherDevices,
  staffAssist,
  staffRevokeAll,
  type StaffTicketRef,
} from '../recovery/service.js';
import { VerificationGate, admitSource } from '../recovery/throttle.js';
import { queueFacility, resolveStatusToken, type ResolvedStatusTicket } from '../queue/views.js';
import { TICKET_TOKEN_HEADER } from './public.js';
import { uuidParam, type RouteDeps } from './deps.js';

/**
 * M5.1 ticket recovery routes (design §15.9). All are Zod-strict, CSRF-protected by the global
 * hook (state-changing /api routes), tenant-scoped and answer with RFC 9457 problems.
 *
 * Visitor routes never reveal whether a ticket exists: every failed recovery is the same 404.
 * Staff routes are permission-checked against the queue's facility and never return a secret
 * other than the single-use grant the visitor's own device redeems.
 */
export async function recoveryRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate, recovery } = deps;
  const limits = { perSourcePerMinute: env.RECOVERY_RATE_LIMIT_MAX };
  // L5: per-process cap on concurrent verifications
  const gate = new VerificationGate(32);
  // Coarse in-memory guard in front of the shared DB throttle (protects the DB itself)
  const coarse = {
    config: {
      rateLimit: { max: Math.max(env.RECOVERY_RATE_LIMIT_MAX * 6, 60), timeWindow: '1 minute' },
    },
  };
  const tokenRoute = {
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

  /** POST /tickets/recover — recovery key (with public identifiers) or a staff grant. */
  app.post('/tickets/recover', coarse, async (req, reply) => {
    if (!recovery) throw recoveryUnavailable();
    const source = sourceOf(req.ip);
    const parsed = RecoverTicketRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Malformed requests still count against the source (L1) before being refused
      await admitSource(db, recovery.throttleKey('source', source), limits);
      parseInput(RecoverTicketRequestSchema, req.body); // throws the validation problem
      throw problems.notFound();
    }
    const body = parsed.data;
    const ticket = await gate.run(() =>
      'grant' in body
        ? recoverWithGrant(db, recovery, limits, { rawGrant: body.grant, source })
        : recoverWithKey(db, recovery, limits, {
            orgSlug: body.org_slug,
            facilitySlug: body.facility_slug,
            ticketCode: body.ticket_code,
            rawKey: body.recovery_key,
            source,
          }),
    );
    return reply.send({ ticket });
  });

  /** POST /tickets/:code/recovery-key — a new key; the old one stops working. */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/recovery-key',
    tokenRoute,
    async (req, reply) => {
      if (!recovery) throw recoveryUnavailable();
      const resolved = await resolveTicket(req);
      return reply.send(await regenerateRecoveryKey(db, recovery, resolved));
    },
  );

  /** POST /tickets/:code/sessions/revoke-others — sign out every other device. */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/sessions/revoke-others',
    tokenRoute,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      return reply.send(await revokeOtherDevices(db, recovery, resolved));
    },
  );

  /** POST /tickets/:code/rejoin — `self_resume` only, inside the grace window. */
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/rejoin',
    tokenRoute,
    async (req, reply) => {
      const resolved = await resolveTicket(req);
      const body = parseInput(RejoinRequestSchema, req.body);
      const outcome = await rejoin(db, resolved, body.operation_id);
      return reply.status(outcome.disposition === 'rejected' ? 409 : 200).send({
        outcome: {
          disposition: outcome.disposition,
          reason_code: outcome.reason_code,
          message: outcome.message,
        },
      });
    },
  );

  // ---- Staff-assisted recovery ----------------------------------------------------------------

  async function staffRef(
    req: FastifyRequest<{ Params: { id: string; ticketId: string } }>,
    permission: 'WALK_IN' | 'QUEUE_MANAGE',
  ): Promise<StaffTicketRef> {
    const auth = requireAuth(req);
    const queueId = uuidParam(req.params.id);
    const ticketId = uuidParam(req.params.ticketId);
    const facilityId = await queueFacility(db, auth.organizationId, queueId);
    if (!facilityId) throw problems.notFound();
    await requireFacilityPermission(db, auth, facilityId, permission);
    return { queueId, facilityId, ticketId };
  }
  const staffRoute = {
    preHandler: authenticate,
    config: { rateLimit: { max: env.COMMAND_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };

  /** POST /queues/:id/tickets/:ticketId/recovery/assist — WALK_IN roles (never auditors). */
  app.post<{ Params: { id: string; ticketId: string } }>(
    '/queues/:id/tickets/:ticketId/recovery/assist',
    staffRoute,
    async (req, reply) => {
      const ref = await staffRef(req, 'WALK_IN');
      const body = parseInput(RecoveryAssistRequestSchema, req.body);
      return reply.send(await staffAssist(db, recovery, requireAuth(req), ref, body));
    },
  );

  /** POST /queues/:id/tickets/:ticketId/recovery/approve — QUEUE_MANAGE, a different person. */
  app.post<{ Params: { id: string; ticketId: string } }>(
    '/queues/:id/tickets/:ticketId/recovery/approve',
    staffRoute,
    async (req, reply) => {
      const ref = await staffRef(req, 'QUEUE_MANAGE');
      const body = parseInput(RecoveryApproveRequestSchema, req.body);
      return reply.send(await approveRecovery(db, requireAuth(req), ref, body.request_id));
    },
  );

  /** GET /queues/:id/tickets/:ticketId/recovery/requests/:requestId — requester or manager. */
  app.get<{ Params: { id: string; ticketId: string; requestId: string } }>(
    '/queues/:id/tickets/:ticketId/recovery/requests/:requestId',
    staffRoute,
    async (req, reply) => {
      const ref = await staffRef(req, 'WALK_IN');
      const auth = requireAuth(req);
      const roles = queueActorRoles(auth, ref.facilityId);
      const canManage = roles.includes(Role.SUPERVISOR) || roles.includes(Role.FACILITY_ADMIN);
      return reply.send(
        await recoveryRequestStatus(db, auth, ref, uuidParam(req.params.requestId), canManage),
      );
    },
  );

  /** POST /queues/:id/tickets/:ticketId/recovery/revoke-all — lost or stolen phone. */
  app.post<{ Params: { id: string; ticketId: string } }>(
    '/queues/:id/tickets/:ticketId/recovery/revoke-all',
    staffRoute,
    async (req, reply) => {
      const ref = await staffRef(req, 'WALK_IN');
      const body = parseInput(RecoveryRevokeAllRequestSchema, req.body);
      return reply.send(await staffRevokeAll(db, requireAuth(req), ref, body));
    },
  );

  /** GET /queues/:id/recovery/requests — approval queue for supervisors and admins. */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/recovery/requests',
    staffRoute,
    async (req, reply) => {
      const auth = requireAuth(req);
      const queueId = uuidParam(req.params.id);
      const facilityId = await queueFacility(db, auth.organizationId, queueId);
      if (!facilityId) throw problems.notFound();
      await requireFacilityPermission(db, auth, facilityId, 'QUEUE_MANAGE');
      return reply.send({ requests: await listRecoveryRequests(db, auth, facilityId) });
    },
  );
}
