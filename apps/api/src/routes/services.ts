import type { FastifyInstance } from 'fastify';
import {
  CreateServiceRequestSchema,
  UpdateServiceRequestSchema,
  type Service,
  type ServicePolicy,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import { uuidParam, type RouteDeps } from './deps.js';

interface ServiceRow {
  id: string;
  facility_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  policy: ServicePolicy;
  created_at: Date;
}

function toDto(row: ServiceRow): Service {
  return {
    id: row.id,
    facility_id: row.facility_id,
    name: row.name,
    description: row.description,
    status: row.status,
    policy: row.policy,
    created_at: row.created_at.toISOString(),
  };
}

const COLUMNS = 'id, facility_id, name, description, status, policy, created_at';

export async function serviceRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, authenticate } = deps;

  /** POST /api/v1/facilities/:id/services */
  app.post<{ Params: { id: string } }>(
    '/facilities/:id/services',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const body = parseInput(CreateServiceRequestSchema, req.body);

      try {
        const row = await db.begin(async (tx) => {
          const rows = await tx<ServiceRow[]>`
            INSERT INTO services (facility_id, organization_id, name, description, policy)
            VALUES (${facility.id}, ${auth.organizationId}, ${body.name},
                    ${body.description ?? null}, ${tx.json(body.policy)})
            RETURNING ${tx.unsafe(COLUMNS)}`;
          const service = rows[0];
          if (!service) throw new Error('service insert returned no row');
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'service.created',
            targetType: 'service',
            targetId: service.id,
            details: { policy_version: body.policy.version },
          });
          return service;
        });
        return await reply.status(201).send({ service: toDto(row) });
      } catch (err) {
        if (isUniqueViolation(err, 'services_facility_name_idx')) {
          throw problems.conflict('A service with that name already exists in this facility.');
        }
        throw err;
      }
    },
  );

  /** GET /api/v1/facilities/:id/services */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/services',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      const rows = await db<ServiceRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM services
         WHERE facility_id = ${facility.id} AND organization_id = ${auth.organizationId}
         ORDER BY created_at, name`;
      return reply.send({ services: rows.map(toDto) });
    },
  );

  /** PATCH /api/v1/facilities/:id/services/:serviceId */
  app.patch<{ Params: { id: string; serviceId: string } }>(
    '/facilities/:id/services/:serviceId',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const serviceId = uuidParam(req.params.serviceId);
      const body = parseInput(UpdateServiceRequestSchema, req.body);

      try {
        const row = await db.begin(async (tx) => {
          const current = (
            await tx<ServiceRow[]>`
              SELECT ${tx.unsafe(COLUMNS)} FROM services
               WHERE id = ${serviceId} AND facility_id = ${facility.id}
                 AND organization_id = ${auth.organizationId}
               FOR UPDATE`
          )[0];
          if (!current) throw problems.notFound();

          const next = {
            name: body.name ?? current.name,
            description: body.description === undefined ? current.description : body.description,
            status: body.status ?? current.status,
            policy: body.policy ?? current.policy,
          };
          const updated = (
            await tx<ServiceRow[]>`
              UPDATE services
                 SET name = ${next.name}, description = ${next.description},
                     status = ${next.status}, policy = ${tx.json(next.policy)}, updated_at = NOW()
               WHERE id = ${serviceId}
               RETURNING ${tx.unsafe(COLUMNS)}`
          )[0];
          if (!updated) throw problems.notFound();

          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'service.updated',
            targetType: 'service',
            targetId: serviceId,
            details: { fields: Object.keys(body).join(',') },
          });
          return updated;
        });
        return await reply.send({ service: toDto(row) });
      } catch (err) {
        if (isUniqueViolation(err, 'services_facility_name_idx')) {
          throw problems.conflict('A service with that name already exists in this facility.');
        }
        throw err;
      }
    },
  );
}
