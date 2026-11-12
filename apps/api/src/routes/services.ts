import type { FastifyInstance } from 'fastify';
import {
  CreateServiceRequestSchema,
  ServicePolicySchema,
  UpdateServiceRequestSchema,
  type Service,
  type ServicePolicy,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import { recordInitialPolicy, recordPolicyChange, samePolicy } from '../queue/policies.js';
import { uuidParam, type RouteDeps } from './deps.js';

interface ServiceRow {
  id: string;
  facility_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  policy: ServicePolicy;
  ticket_prefix: string | null;
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
    ticket_prefix: row.ticket_prefix,
    created_at: row.created_at.toISOString(),
  };
}

const COLUMNS = 'id, facility_id, name, description, status, policy, ticket_prefix, created_at';

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
          const created = rows[0];
          if (!created) throw new Error('service insert returned no row');
          // The server assigns the version label and keeps an immutable snapshot of it
          const policy = await recordInitialPolicy(
            tx,
            {
              organizationId: auth.organizationId,
              facilityId: facility.id,
              serviceId: created.id,
              actorId: auth.staffUserId,
            },
            body.policy,
          );
          const service = (
            await tx<ServiceRow[]>`
              UPDATE services SET policy = ${tx.json(policy)} WHERE id = ${created.id}
              RETURNING ${tx.unsafe(COLUMNS)}`
          )[0];
          if (!service) throw new Error('service update returned no row');
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'service.created',
            targetType: 'service',
            targetId: service.id,
            details: { policy_version: policy.version },
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

          // PATCH semantics for the policy: fields the client did not send keep their CURRENT
          // value (never a schema default — e.g. a service pinned to `end_of_queue` must not flip
          // to `by_original_join_time` because a client only changed the classes). The merged
          // policy is validated as a whole. A real change creates the next server-assigned
          // version (client labels are ignored); re-sending the same rules creates nothing.
          const sent = (req.body as { policy?: Record<string, unknown> } | null)?.policy;
          const requested =
            body.policy && sent
              ? parseInput(ServicePolicySchema, { ...current.policy, ...sent })
              : undefined;
          let policy = current.policy;
          if (requested && !samePolicy(requested, current.policy)) {
            policy = await recordPolicyChange(
              tx,
              {
                organizationId: auth.organizationId,
                facilityId: facility.id,
                serviceId,
                actorId: auth.staffUserId,
              },
              current.policy,
              requested,
            );
          }
          const next = {
            name: body.name ?? current.name,
            description: body.description === undefined ? current.description : body.description,
            status: body.status ?? current.status,
            policy,
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
            details: {
              fields: Object.keys(body).join(','),
              policy_version: policy.version,
            },
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

  /** GET /api/v1/facilities/:id/services/:serviceId/policy-versions — full policy history. */
  app.get<{ Params: { id: string; serviceId: string } }>(
    '/facilities/:id/services/:serviceId/policy-versions',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      const rows = await db<
        {
          version_label: string;
          version_number: number;
          policy: Record<string, unknown>;
          created_by_name: string | null;
          created_at: Date;
        }[]
      >`
        SELECT v.version_label, v.version_number, v.policy, u.display_name AS created_by_name, v.created_at
          FROM service_policy_versions v LEFT JOIN staff_users u ON u.id = v.created_by
         WHERE v.service_id = ${uuidParam(req.params.serviceId)} AND v.facility_id = ${facility.id}
           AND v.organization_id = ${auth.organizationId}
         ORDER BY v.version_number DESC`;
      if (rows.length === 0) throw problems.notFound();
      return reply.send({
        versions: rows.map((r) => ({
          version: r.version_label,
          version_number: r.version_number,
          policy: r.policy,
          created_by_name: r.created_by_name,
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );
}
