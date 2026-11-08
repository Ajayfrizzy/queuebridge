import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AssignCoordinatorRequestSchema,
  DeviceHeartbeatRequestSchema,
  FailoverCoordinatorRequestSchema,
  RegisterDeviceRequestSchema,
  RenewCoordinatorRequestSchema,
  ResolveConflictRequestSchema,
  RevokeCoordinatorRequestSchema,
  RevokeDeviceRequestSchema,
  SyncBatchTransportSchema,
} from '@queuebridge/contracts';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { parseInput, problems } from '../errors.js';
import { coordinatorCommand, type CoordinatorKind } from '../queue/coordinator.js';
import { resolveConflict, listConflicts } from '../queue/conflicts.js';
import { recordHeartbeat, registerDevice, revokeDevice } from '../queue/devices.js';
import { operationsHealth } from '../queue/health.js';
import { buildSnapshot } from '../queue/snapshot.js';
import { processSyncBatch } from '../queue/sync.js';
import { queueFacility } from '../queue/views.js';
import { uuidParam, type RouteDeps } from './deps.js';

const SnapshotQuerySchema = z
  .object({
    device_id: z.string().uuid().optional(),
    since_sequence: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/** Continuity engine routes (M3): devices, sync, snapshots, coordinator authority, review, health. */
export async function syncRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate, env } = deps;
  const limited = { rateLimit: { max: env.COMMAND_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  // ---- Devices ---------------------------------------------------------------------------------

  /** POST /devices — register this browser profile for a facility. */
  app.post('/devices', { preHandler: authenticate, config: limited }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = parseInput(RegisterDeviceRequestSchema, req.body);
    return reply.status(201).send({ device: await registerDevice(db, auth, body) });
  });

  /** POST /devices/:id/heartbeat — self-reported health (display only). */
  app.post<{ Params: { id: string } }>(
    '/devices/:id/heartbeat',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = parseInput(DeviceHeartbeatRequestSchema, req.body);
      await recordHeartbeat(db, auth, uuidParam(req.params.id), body);
      return reply.status(204).send();
    },
  );

  /** POST /devices/:id/revoke — supervisor / facility admin. Also strips coordinator authority. */
  app.post<{ Params: { id: string } }>(
    '/devices/:id/revoke',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = parseInput(RevokeDeviceRequestSchema, req.body);
      return reply.send({ device: await revokeDevice(db, auth, uuidParam(req.params.id), body) });
    },
  );

  // ---- Sync ------------------------------------------------------------------------------------

  /** POST /sync/batches — apply offline commands; per-command dispositions. */
  app.post(
    '/sync/batches',
    { preHandler: authenticate, bodyLimit: 512 * 1024, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const transport = parseInput(SyncBatchTransportSchema, req.body);
      return reply.send(await processSyncBatch(db, env, auth, transport, req.log));
    },
  );

  /** GET /sync/queues/:id/snapshot — consistent queue state + events after a cursor + authority. */
  app.get<{ Params: { id: string } }>(
    '/sync/queues/:id/snapshot',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const queueId = uuidParam(req.params.id);
      const facilityId = await queueFacility(db, auth.organizationId, queueId);
      if (!facilityId) throw problems.notFound();
      await requireFacilityPermission(db, auth, facilityId, 'QUEUE_VIEW');
      const q = parseInput(SnapshotQuerySchema, req.query);
      return reply.send({
        snapshot: await buildSnapshot(
          db,
          env,
          auth,
          queueId,
          q.device_id ?? null,
          q.since_sequence ?? null,
        ),
      });
    },
  );

  // ---- Coordinator authority (supervisor / facility admin) ------------------------------------

  const coordinatorRoute = (
    path: string,
    kind: CoordinatorKind,
    schema: z.ZodType<Record<string, unknown>>,
  ): void => {
    app.post<{ Params: { id: string } }>(
      `/queues/:id/coordinator${path}`,
      { preHandler: authenticate, config: limited },
      async (req, reply) => {
        const auth = requireAuth(req);
        const queueId = uuidParam(req.params.id);
        const facilityId = await queueFacility(db, auth.organizationId, queueId);
        if (!facilityId) throw problems.notFound();
        await requireFacilityPermission(db, auth, facilityId, 'QUEUE_MANAGE');
        const body = parseInput(schema, req.body) as {
          operation_id: string;
          device_id?: string;
          ttl_minutes?: number;
          allowed_actions?: string[];
          reason_code?: string;
        };
        const result = await coordinatorCommand(db, {
          auth,
          queueId,
          facilityId,
          kind,
          operationId: body.operation_id,
          ...(body.device_id ? { deviceId: body.device_id } : {}),
          ...(body.ttl_minutes ? { ttlMinutes: body.ttl_minutes } : {}),
          ...(body.allowed_actions ? { allowedActions: body.allowed_actions } : {}),
          ...(body.reason_code ? { reasonCode: body.reason_code } : {}),
        });
        return reply.send(result);
      },
    );
  };
  coordinatorRoute('', 'assign', AssignCoordinatorRequestSchema);
  coordinatorRoute('/failover', 'failover', FailoverCoordinatorRequestSchema);
  coordinatorRoute('/renew', 'renew', RenewCoordinatorRequestSchema);
  coordinatorRoute('/revoke', 'revoke', RevokeCoordinatorRequestSchema);

  // ---- Dashboard and review -------------------------------------------------------------------

  /** GET /facilities/:id/operations/health — device sync health (supervisor, admin, auditor). */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/operations/health',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const f = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'OPERATIONS_VIEW',
      );
      return reply.send({ health: await operationsHealth(db, auth.organizationId, f.id) });
    },
  );

  /** GET /facilities/:id/sync/conflicts — operations awaiting (or having had) supervisor review. */
  app.get<{ Params: { id: string }; Querystring: { include?: string } }>(
    '/facilities/:id/sync/conflicts',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const f = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'OPERATIONS_VIEW',
      );
      return reply.send({
        conflicts: await listConflicts(db, auth.organizationId, f.id, req.query.include === 'all'),
      });
    },
  );

  /** POST /sync/conflicts/:operationId/resolve — supervisor decision (apply or dismiss). */
  app.post<{ Params: { operationId: string } }>(
    '/sync/conflicts/:operationId/resolve',
    { preHandler: authenticate, config: limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = parseInput(ResolveConflictRequestSchema, req.body);
      return reply.send({
        result: await resolveConflict(db, auth, uuidParam(req.params.operationId), body),
      });
    },
  );
}
