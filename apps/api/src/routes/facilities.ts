import type { FastifyInstance } from 'fastify';
import {
  CreateFacilityRequestSchema,
  type Facility,
  type FacilityJoinLink,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import {
  isOrgAdmin,
  requireFacilityPermission,
  requireOrgAdmin,
  type FacilityRow,
} from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import { loadReadiness } from '../readiness.js';
import { uuidParam, type RouteDeps } from './deps.js';

export function toFacilityDto(row: FacilityRow): Facility {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

export async function facilityRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;

  /** POST /api/v1/facilities — create a facility under the caller's organization (org_admin). */
  app.post('/facilities', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    requireOrgAdmin(auth);
    // Note: organization_id is never read from the body (schema is strict) — session only.
    const body = parseInput(CreateFacilityRequestSchema, req.body);

    try {
      const row = await db.begin(async (tx) => {
        const rows = await tx<FacilityRow[]>`
          INSERT INTO facilities (organization_id, name, slug, timezone)
          VALUES (${auth.organizationId}, ${body.name}, ${body.slug}, ${body.timezone})
          RETURNING id, organization_id, name, slug, timezone, status, created_at`;
        const facility = rows[0];
        if (!facility) throw new Error('facility insert returned no row');
        await recordAdminEvent(tx, {
          organizationId: auth.organizationId,
          facilityId: facility.id,
          actorId: auth.staffUserId,
          eventType: 'facility.created',
          targetType: 'facility',
          targetId: facility.id,
        });
        return facility;
      });
      return await reply.status(201).send({ facility: toFacilityDto(row) });
    } catch (err) {
      if (isUniqueViolation(err, 'facilities_org_slug_idx')) {
        throw problems.conflict('A facility with that address already exists.');
      }
      throw err;
    }
  });

  /** GET /api/v1/facilities — facilities the caller may see (all for org_admin). */
  app.get('/facilities', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    const all = isOrgAdmin(auth);
    const rows = await db<FacilityRow[]>`
      SELECT f.id, f.organization_id, f.name, f.slug, f.timezone, f.status, f.created_at
        FROM facilities f
       WHERE f.organization_id = ${auth.organizationId}
         AND (${all} OR f.id IN (
               SELECT facility_id FROM role_assignments
                WHERE staff_user_id = ${auth.staffUserId} AND facility_id IS NOT NULL))
       ORDER BY f.created_at, f.name`;
    return reply.send({ facilities: rows.map(toFacilityDto) });
  });

  /** GET /api/v1/facilities/:id */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      return reply.send({ facility: toFacilityDto(facility) });
    },
  );

  /** GET /api/v1/facilities/:id/join-link — visitor join URL (F10 QR/join link). */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/join-link',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      const path = `/join/${auth.organizationSlug}/${facility.slug}`;
      const readiness = await loadReadiness(db, auth.organizationId, facility.id, facility.status);
      const link: FacilityJoinLink = {
        path,
        url: new URL(path, env.WEB_BASE_URL).toString(),
        operational: readiness.visitor_join.operational,
      };
      return reply.send({ join_link: link });
    },
  );

  /**
   * GET /api/v1/facilities/:id/readiness — derived configuration readiness.
   * An active counter must be set to serve an active service; counts alone prove nothing.
   */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/readiness',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      const readiness = await loadReadiness(db, auth.organizationId, facility.id, facility.status);
      return reply.send({ readiness });
    },
  );
}
