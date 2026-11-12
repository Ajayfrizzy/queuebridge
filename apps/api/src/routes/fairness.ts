import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CallOutOfOrderRequestSchema,
  CounterAvailabilityRequestSchema,
  CounterTransferRequestSchema,
  PriorityOverrideRequestSchema,
  QueueAction,
  type CommandOutcome,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission, type AuthContext } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput, problems } from '../errors.js';
import { auditExport, auditPage, verifyAudit } from '../queue/audit.js';
import { executeCommand, type InternalCommand } from '../queue/commands.js';
import { setCounterAvailability } from '../queue/counters.js';
import { queueFacility } from '../queue/views.js';
import { uuidParam, type RouteDeps } from './deps.js';

const AuditQuerySchema = z
  .object({
    after_sequence: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/**
 * M4 routes: supervisor priority overrides, routing overrides, counter transfers, counter
 * availability, and the read-only audit view / export / verification.
 * Every route: authenticate → tenant-scoped resolve (404 across tenants) → RBAC → validate.
 */
export async function fairnessRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate, env } = deps;
  const limited = { rateLimit: { max: env.COMMAND_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  /** Resolve a ticket to its queue + facility inside the caller's tenant (404 otherwise). */
  async function resolveTicket(
    auth: AuthContext,
    rawId: unknown,
  ): Promise<{ ticketId: string; queueId: string; facilityId: string }> {
    const ticketId = uuidParam(rawId);
    const rows = await db<{ queue_session_id: string; facility_id: string }[]>`
      SELECT t.queue_session_id, qs.facility_id FROM tickets t
        JOIN queue_sessions qs ON qs.id = t.queue_session_id
       WHERE t.id = ${ticketId} AND t.organization_id = ${auth.organizationId}`;
    const r = rows[0];
    if (!r) throw problems.notFound();
    // Must hold SOME role at the facility before anything about the ticket is revealed
    await requireFacilityPermission(db, auth, r.facility_id, 'QUEUE_VIEW');
    return { ticketId, queueId: r.queue_session_id, facilityId: r.facility_id };
  }

  function send(req: FastifyRequest, reply: FastifyReply, outcome: CommandOutcome): FastifyReply {
    if (outcome.disposition === 'rejected') {
      return reply
        .status(409)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://queuebridge.dev/problems/command-rejected',
          title: 'Command rejected',
          status: 409,
          detail: outcome.message ?? 'The command could not be applied.',
          instance: req.id,
          retryable: false,
          outcome,
        });
    }
    return reply.send({ outcome });
  }

  /**
   * Run a supervisor-only command; an unauthorized attempt is REJECTED (403) AND LOGGED
   * (REQ-F3.5) as an append-only admin event naming who tried what — never the explanation text.
   */
  async function runGuarded(
    auth: AuthContext,
    target: { ticketId: string; queueId: string; facilityId: string },
    command: InternalCommand,
  ): Promise<CommandOutcome> {
    try {
      return await executeCommand(db, {
        auth,
        queueId: target.queueId,
        facilityId: target.facilityId,
        command,
      });
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 403) {
        await recordAdminEvent(db, {
          organizationId: auth.organizationId,
          facilityId: target.facilityId,
          actorId: auth.staffUserId,
          eventType: `${command.action}.denied`,
          targetType: 'ticket',
          targetId: target.ticketId,
          details: { reason: 'role_not_permitted', queue_id: target.queueId },
        });
      }
      throw err;
    }
  }

  /** POST /tickets/:id/priority-override — supervisor changes a waiting ticket's class. */
  app.post<{ Params: { id: string } }>(
    '/tickets/:id/priority-override',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const target = await resolveTicket(auth, req.params.id);
      const body = parseInput(PriorityOverrideRequestSchema, req.body);
      const outcome = await runGuarded(auth, target, {
        operation_id: body.operation_id,
        action: QueueAction.TICKET_PRIORITY_OVERRIDE,
        ticket_id: target.ticketId,
        to_class: body.to_class,
        override_reason: { code: body.reason_code, text: body.reason_text },
      });
      return send(req, reply, outcome);
    },
  );

  /** POST /tickets/:id/call-out-of-order — supervisor routing override with recorded rationale. */
  app.post<{ Params: { id: string } }>(
    '/tickets/:id/call-out-of-order',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const target = await resolveTicket(auth, req.params.id);
      const body = parseInput(CallOutOfOrderRequestSchema, req.body);
      const outcome = await runGuarded(auth, target, {
        operation_id: body.operation_id,
        action: QueueAction.TICKET_CALL_SPECIFIC,
        ticket_id: target.ticketId,
        counter_id: body.counter_id,
        override_reason: { code: body.reason_code, text: body.reason_text },
      });
      return send(req, reply, outcome);
    },
  );

  /** POST /tickets/:id/counter-transfer — hand a called/serving ticket to another counter. */
  app.post<{ Params: { id: string } }>(
    '/tickets/:id/counter-transfer',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const target = await resolveTicket(auth, req.params.id);
      const body = parseInput(CounterTransferRequestSchema, req.body);
      const outcome = await runGuarded(auth, target, {
        operation_id: body.operation_id,
        action: QueueAction.TICKET_COUNTER_TRANSFER,
        ticket_id: target.ticketId,
        to_counter_id: body.to_counter_id,
        counter_reason_code: body.reason_code,
      });
      return send(req, reply, outcome);
    },
  );

  /** POST /counters/:id/availability — open or close a counter for the day. */
  app.post<{ Params: { id: string } }>(
    '/counters/:id/availability',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = parseInput(CounterAvailabilityRequestSchema, req.body);
      return reply.send({
        result: await setCounterAvailability(db, auth, uuidParam(req.params.id), body),
      });
    },
  );

  // ---- Audit (read-only; auditor, supervisor, facility admin) -------------------------------

  async function authorizeAudit(
    req: FastifyRequest,
    rawId: unknown,
  ): Promise<{ auth: AuthContext; queueId: string }> {
    const auth = requireAuth(req);
    const queueId = uuidParam(rawId);
    const facilityId = await queueFacility(db, auth.organizationId, queueId);
    if (!facilityId) throw problems.notFound();
    await requireFacilityPermission(db, auth, facilityId, 'AUDIT_VIEW');
    return { auth, queueId };
  }

  /** GET /queues/:id/audit — paginated immutable event sequence. */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/audit',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const { auth, queueId } = await authorizeAudit(req, req.params.id);
      const q = parseInput(AuditQuerySchema, req.query);
      const page = await auditPage(db, auth.organizationId, queueId, q.after_sequence, q.limit);
      if (!page) throw problems.notFound();
      return reply.send({ audit: page });
    },
  );

  /** GET /queues/:id/audit/export — redacted export (no names, no free text). */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/audit/export',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const { auth, queueId } = await authorizeAudit(req, req.params.id);
      const data = await auditExport(db, auth.organizationId, queueId);
      if (!data) throw problems.notFound();
      return reply
        .header('Content-Disposition', `attachment; filename="queue-${queueId}-audit.json"`)
        .send(data);
    },
  );

  /** GET /queues/:id/audit/verify — chain, checkpoints, decision replay, alerts. */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/audit/verify',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const { auth, queueId } = await authorizeAudit(req, req.params.id);
      const result = await verifyAudit(db, env, auth.organizationId, queueId);
      if (!result) throw problems.notFound();
      if (result.status !== 'verified') {
        req.log.warn(
          { queue_session_id: queueId, status: result.status },
          'Audit verification not successful',
        );
      }
      return reply.send({ verification: result });
    },
  );
}
