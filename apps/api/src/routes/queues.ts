import type { FastifyInstance } from 'fastify';
import {
  OpenQueueSessionRequestSchema,
  QueueCommandRequestSchema,
  WalkInRequestSchema,
} from '@queuebridge/contracts';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { problems, parseInput } from '../errors.js';
import { executeCommand } from '../queue/commands.js';
import { joinQueue } from '../queue/joins.js';
import { openTodaysSession } from '../queue/sessions.js';
import { openSse } from '../queue/sse.js';
import { facilityQueueSummaries, queueFacility, staffQueueView } from '../queue/views.js';
import { uuidParam, type RouteDeps } from './deps.js';

/** Staff-facing queue routes. Every route: authenticate → tenant-scoped resolve → RBAC → validate. */
export async function queueRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate, notifier, env } = deps;

  /** Resolve a queue to its facility inside the caller's organization, then authorize. */
  async function authorizeQueue(
    req: Parameters<typeof requireAuth>[0],
    rawId: unknown,
    permission: 'QUEUE_VIEW' | 'WALK_IN',
  ): Promise<{ queueId: string; facilityId: string }> {
    const auth = requireAuth(req);
    const queueId = uuidParam(rawId);
    const facilityId = await queueFacility(db, auth.organizationId, queueId);
    if (!facilityId) throw problems.notFound();
    await requireFacilityPermission(db, auth, facilityId, permission);
    return { queueId, facilityId };
  }

  /** GET /facilities/:id/queues — today's queue per service. */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/queues',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const f = await requireFacilityPermission(db, auth, uuidParam(req.params.id), 'QUEUE_VIEW');
      return reply.send({ queues: await facilityQueueSummaries(db, auth.organizationId, f.id) });
    },
  );

  /** POST /facilities/:id/queues — open today's session for a service (supervisor/admin). */
  app.post<{ Params: { id: string } }>(
    '/facilities/:id/queues',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const f = await requireFacilityPermission(db, auth, uuidParam(req.params.id), 'QUEUE_MANAGE');
      const body = parseInput(OpenQueueSessionRequestSchema, req.body);
      const result = await openTodaysSession(db, {
        organizationId: auth.organizationId,
        facilityId: f.id,
        serviceId: body.service_id,
        actorId: auth.staffUserId,
      });
      const view = await staffQueueView(db, auth.organizationId, result.queueId);
      return reply.status(result.created ? 201 : 200).send({ queue: view });
    },
  );

  /** GET /queues/:id — staff console projection. */
  app.get<{ Params: { id: string } }>(
    '/queues/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { queueId } = await authorizeQueue(req, req.params.id, 'QUEUE_VIEW');
      const view = await staffQueueView(db, auth.organizationId, queueId);
      if (!view) throw problems.notFound();
      return reply.send({ queue: view });
    },
  );

  /** POST /queues/:id/commands — authorized, idempotent online state transition. */
  app.post<{ Params: { id: string } }>(
    '/queues/:id/commands',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: env.COMMAND_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      // Must hold some role at the facility before anything about the queue is revealed
      const { queueId, facilityId } = await authorizeQueue(req, req.params.id, 'QUEUE_VIEW');
      const command = parseInput(QueueCommandRequestSchema, req.body);
      const outcome = await executeCommand(db, { auth, queueId, facilityId, command });
      if (outcome.disposition === 'rejected') {
        return reply
          .status(409)
          .header('Content-Type', 'application/problem+json')
          .send({
            type: `https://queuebridge.dev/problems/command-rejected`,
            title: 'Command rejected',
            status: 409,
            detail: outcome.message ?? 'The command could not be applied.',
            instance: req.id,
            retryable: outcome.reason_code === 'stale_revision',
            outcome,
          });
      }
      return reply.send({ outcome });
    },
  );

  /** POST /queues/:id/walk-ins — staff-assisted registration (visitor needs no phone). */
  app.post<{ Params: { id: string } }>(
    '/queues/:id/walk-ins',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: env.COMMAND_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { queueId } = await authorizeQueue(req, req.params.id, 'WALK_IN');
      const body = parseInput(WalkInRequestSchema, req.body);
      const result = await joinQueue(db, {
        organizationId: auth.organizationId,
        queueId,
        operationId: body.operation_id,
        proofHash: null,
        staffUserId: auth.staffUserId,
      });
      return reply.status(result.disposition === 'committed' ? 201 : 200).send({ ticket: result });
    },
  );

  /** GET /queues/:id/stream — staff live change signals (SSE). */
  app.get<{ Params: { id: string } }>(
    '/queues/:id/stream',
    { preHandler: authenticate },
    async (req, reply) => {
      const { queueId } = await authorizeQueue(req, req.params.id, 'QUEUE_VIEW');
      const view = await db<
        { revision: number }[]
      >`SELECT revision FROM queue_sessions WHERE id = ${queueId}`;
      await openSse(req, reply, {
        notifier,
        filter: (s) => s.s === queueId,
        initialRevision: view[0]?.revision ?? 0,
      });
    },
  );
}
