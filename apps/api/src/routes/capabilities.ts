import type { FastifyInstance } from 'fastify';
import { CounterServiceCapabilityRequestSchema } from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { parseInput, problems } from '../errors.js';
import { loadCounters } from './counters.js';
import { uuidParam, type RouteDeps } from './deps.js';

export async function capabilityRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate } = deps;

  /**
   * Resolve the counter inside the caller's organization, then authorize against the
   * counter's facility. A counter in another organization is a 404.
   */
  async function authorizeCounter(
    organizationId: string,
    counterId: string,
    req: Parameters<typeof requireAuth>[0],
  ): Promise<{ facilityId: string }> {
    const auth = requireAuth(req);
    const rows = await db<{ facility_id: string }[]>`
      SELECT facility_id FROM counters
       WHERE id = ${counterId} AND organization_id = ${organizationId}`;
    const counter = rows[0];
    if (!counter) throw problems.notFound();
    const facility = await requireFacilityPermission(
      db,
      auth,
      counter.facility_id,
      'FACILITY_CONFIGURE',
    );
    return { facilityId: facility.id };
  }

  /** POST /api/v1/counter_service_capabilities — idempotent: 201 when created, 200 if present. */
  app.post('/counter_service_capabilities', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = parseInput(CounterServiceCapabilityRequestSchema, req.body);
    const { facilityId } = await authorizeCounter(auth.organizationId, body.counter_id, req);

    // The service must live in the same facility (and organization) as the counter
    const svc = await db<{ id: string }[]>`
      SELECT id FROM services
       WHERE id = ${body.service_id} AND facility_id = ${facilityId}
         AND organization_id = ${auth.organizationId}`;
    if (svc.length === 0) throw problems.notFound();

    const created = await db.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO counter_service_capabilities (counter_id, service_id)
        VALUES (${body.counter_id}, ${body.service_id})
        ON CONFLICT DO NOTHING
        RETURNING counter_id`;
      if (inserted.length > 0) {
        await recordAdminEvent(tx, {
          organizationId: auth.organizationId,
          facilityId,
          actorId: auth.staffUserId,
          eventType: 'counter_capability.assigned',
          targetType: 'counter',
          targetId: body.counter_id,
          details: { service_id: body.service_id },
        });
      }
      return inserted.length > 0;
    });

    const [counter] = await loadCounters(db, auth.organizationId, facilityId, body.counter_id);
    return reply.status(created ? 201 : 200).send({ counter });
  });

  /** DELETE /api/v1/counter_service_capabilities/:counterId/:serviceId */
  app.delete<{ Params: { counterId: string; serviceId: string } }>(
    '/counter_service_capabilities/:counterId/:serviceId',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const counterId = uuidParam(req.params.counterId);
      const serviceId = uuidParam(req.params.serviceId);
      const { facilityId } = await authorizeCounter(auth.organizationId, counterId, req);

      const removed = await db.begin(async (tx) => {
        const rows = await tx`
          DELETE FROM counter_service_capabilities csc
                USING counters c
                WHERE csc.counter_id = c.id AND c.id = ${counterId}
                  AND c.organization_id = ${auth.organizationId}
                  AND csc.service_id = ${serviceId}
          RETURNING csc.counter_id`;
        if (rows.length > 0) {
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId,
            actorId: auth.staffUserId,
            eventType: 'counter_capability.removed',
            targetType: 'counter',
            targetId: counterId,
            details: { service_id: serviceId },
          });
        }
        return rows.length > 0;
      });
      if (!removed) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
