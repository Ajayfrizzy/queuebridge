import type { FastifyInstance } from 'fastify';
import {
  CreateCounterRequestSchema,
  UpdateCounterRequestSchema,
  type Counter,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import type { Db } from '../db.js';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import { uuidParam, type RouteDeps } from './deps.js';

interface CounterRow {
  id: string;
  facility_id: string;
  name: string;
  active: boolean;
  service_ids: string[];
  created_at: Date;
}

function toDto(row: CounterRow): Counter {
  return {
    id: row.id,
    facility_id: row.facility_id,
    name: row.name,
    active: row.active,
    service_ids: row.service_ids,
    created_at: row.created_at.toISOString(),
  };
}

/** Load counters (with capability service ids) strictly within one organization + facility. */
export async function loadCounters(
  db: Db,
  organizationId: string,
  facilityId: string,
  counterId?: string,
): Promise<CounterRow[]> {
  return db<CounterRow[]>`
    SELECT c.id, c.facility_id, c.name, c.active, c.created_at,
           COALESCE(array_agg(csc.service_id::text ORDER BY csc.service_id)
                    FILTER (WHERE csc.service_id IS NOT NULL), '{}') AS service_ids
      FROM counters c
      LEFT JOIN counter_service_capabilities csc ON csc.counter_id = c.id
     WHERE c.organization_id = ${organizationId}
       AND c.facility_id = ${facilityId}
       AND (${counterId ?? null}::uuid IS NULL OR c.id = ${counterId ?? null}::uuid)
     GROUP BY c.id
     ORDER BY c.created_at, c.name`;
}

export async function counterRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate } = deps;

  /** POST /api/v1/facilities/:id/counters */
  app.post<{ Params: { id: string } }>(
    '/facilities/:id/counters',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const body = parseInput(CreateCounterRequestSchema, req.body);

      try {
        const id = await db.begin(async (tx) => {
          const rows = await tx<{ id: string }[]>`
            INSERT INTO counters (facility_id, organization_id, name)
            VALUES (${facility.id}, ${auth.organizationId}, ${body.name})
            RETURNING id`;
          const counterId = rows[0]?.id;
          if (!counterId) throw new Error('counter insert returned no row');
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'counter.created',
            targetType: 'counter',
            targetId: counterId,
          });
          return counterId;
        });
        const [row] = await loadCounters(db, auth.organizationId, facility.id, id);
        if (!row) throw new Error('created counter not found');
        return await reply.status(201).send({ counter: toDto(row) });
      } catch (err) {
        if (isUniqueViolation(err, 'counters_facility_name_idx')) {
          throw problems.conflict('A counter with that name already exists in this facility.');
        }
        throw err;
      }
    },
  );

  /** GET /api/v1/facilities/:id/counters */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/counters',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      const rows = await loadCounters(db, auth.organizationId, facility.id);
      return reply.send({ counters: rows.map(toDto) });
    },
  );

  /** PATCH /api/v1/facilities/:id/counters/:counterId */
  app.patch<{ Params: { id: string; counterId: string } }>(
    '/facilities/:id/counters/:counterId',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const counterId = uuidParam(req.params.counterId);
      const body = parseInput(UpdateCounterRequestSchema, req.body);

      try {
        await db.begin(async (tx) => {
          const current = (
            await tx<{ name: string; active: boolean }[]>`
              SELECT name, active FROM counters
               WHERE id = ${counterId} AND facility_id = ${facility.id}
                 AND organization_id = ${auth.organizationId}
               FOR UPDATE`
          )[0];
          if (!current) throw problems.notFound();
          await tx`
            UPDATE counters
               SET name = ${body.name ?? current.name}, active = ${body.active ?? current.active},
                   updated_at = NOW()
             WHERE id = ${counterId}`;
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'counter.updated',
            targetType: 'counter',
            targetId: counterId,
            details: { fields: Object.keys(body).join(',') },
          });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'counters_facility_name_idx')) {
          throw problems.conflict('A counter with that name already exists in this facility.');
        }
        throw err;
      }
      const [row] = await loadCounters(db, auth.organizationId, facility.id, counterId);
      if (!row) throw problems.notFound();
      return reply.send({ counter: toDto(row) });
    },
  );
}
