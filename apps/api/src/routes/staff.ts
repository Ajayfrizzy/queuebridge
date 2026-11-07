import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AssignRoleRequestSchema,
  FacilityRoleSchema,
  InviteStaffRequestSchema,
  Role,
  type FacilityRole,
  type Invitation,
  type StaffMember,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { isOrgAdmin, requireFacilityPermission, requireOrgAdmin } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import { uuidParam, type RouteDeps } from './deps.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface InvitationRow {
  id: string;
  email: string;
  role: FacilityRole;
  status: Invitation['status'];
  expires_at: Date;
  created_at: Date;
}

function toInvitationDto(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

const UpdateStaffStatusSchema = z.object({ status: z.enum(['active', 'inactive']) }).strict();

export async function staffRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;

  /** GET /api/v1/facilities/:id/staff — staff holding a role at this facility. */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/staff',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const rows = await db<(Omit<StaffMember, 'roles'> & { roles: FacilityRole[] })[]>`
        SELECT u.id, u.email, u.display_name, u.status,
               array_agg(ra.role ORDER BY ra.role) AS roles
          FROM role_assignments ra
          JOIN staff_users u ON u.id = ra.staff_user_id AND u.organization_id = ra.organization_id
         WHERE ra.facility_id = ${facility.id} AND ra.organization_id = ${auth.organizationId}
         GROUP BY u.id
         ORDER BY u.display_name, u.email`;
      // Organization-wide administrators have authority here too; list them read-only so the
      // facility's real access picture is visible (they are managed at organization level).
      const orgAdmins = await db<Omit<StaffMember, 'roles'>[]>`
        SELECT u.id, u.email, u.display_name, u.status
          FROM role_assignments ra
          JOIN staff_users u ON u.id = ra.staff_user_id AND u.organization_id = ra.organization_id
         WHERE ra.organization_id = ${auth.organizationId} AND ra.role = ${Role.ORG_ADMIN}
         ORDER BY u.display_name, u.email`;
      return reply.send({ staff: rows, org_admins: orgAdmins });
    },
  );

  /** POST /api/v1/facilities/:id/staff/:staffUserId/roles — grant a facility role. */
  app.post<{ Params: { id: string; staffUserId: string } }>(
    '/facilities/:id/staff/:staffUserId/roles',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const staffUserId = uuidParam(req.params.staffUserId);
      const body = parseInput(AssignRoleRequestSchema, req.body);

      const target = await db<{ id: string }[]>`
        SELECT id FROM staff_users
         WHERE id = ${staffUserId} AND organization_id = ${auth.organizationId} AND status = 'active'`;
      if (target.length === 0) throw problems.notFound();

      const created = await db.begin(async (tx) => {
        const inserted = await tx`
          INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role, assigned_by)
          VALUES (${staffUserId}, ${auth.organizationId}, ${facility.id}, ${body.role}, ${auth.staffUserId})
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (inserted.length > 0) {
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'role.granted',
            targetType: 'staff_user',
            targetId: staffUserId,
            details: { role: body.role },
          });
        }
        return inserted.length > 0;
      });
      return reply.status(created ? 201 : 200).send({ granted: true, role: body.role });
    },
  );

  /** DELETE /api/v1/facilities/:id/staff/:staffUserId/roles/:role — revoke a facility role. */
  app.delete<{ Params: { id: string; staffUserId: string; role: string } }>(
    '/facilities/:id/staff/:staffUserId/roles/:role',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const staffUserId = uuidParam(req.params.staffUserId);
      const roleParsed = FacilityRoleSchema.safeParse(req.params.role);
      if (!roleParsed.success) throw problems.notFound();
      const role = roleParsed.data;

      await db.begin(async (tx) => {
        // Serialize concurrent revocations at this facility so the last-admin check is race-free
        await tx`SELECT id FROM facilities WHERE id = ${facility.id} FOR UPDATE`;

        const existing = await tx`
          SELECT 1 FROM role_assignments
           WHERE staff_user_id = ${staffUserId} AND facility_id = ${facility.id}
             AND organization_id = ${auth.organizationId} AND role = ${role}`;
        if (existing.length === 0) throw problems.notFound();

        if (role === Role.FACILITY_ADMIN && !isOrgAdmin(auth)) {
          const others = await tx`
            SELECT 1 FROM role_assignments
             WHERE facility_id = ${facility.id} AND organization_id = ${auth.organizationId}
               AND role = ${Role.FACILITY_ADMIN} AND staff_user_id <> ${staffUserId}`;
          if (others.length === 0) {
            throw problems.conflict(
              'A facility must keep at least one facility administrator. Ask an organization administrator to change this.',
            );
          }
        }

        await tx`
          DELETE FROM role_assignments
           WHERE staff_user_id = ${staffUserId} AND facility_id = ${facility.id}
             AND organization_id = ${auth.organizationId} AND role = ${role}`;
        await recordAdminEvent(tx, {
          organizationId: auth.organizationId,
          facilityId: facility.id,
          actorId: auth.staffUserId,
          eventType: 'role.revoked',
          targetType: 'staff_user',
          targetId: staffUserId,
          details: { role },
        });
      });
      return reply.status(204).send();
    },
  );

  /** POST /api/v1/facilities/:id/invitations — invite by email with a role. */
  app.post<{ Params: { id: string } }>(
    '/facilities/:id/invitations',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const body = parseInput(InviteStaffRequestSchema, req.body);

      const alreadyHolds = await db`
        SELECT 1 FROM role_assignments ra
          JOIN staff_users u ON u.id = ra.staff_user_id
         WHERE ra.facility_id = ${facility.id} AND ra.organization_id = ${auth.organizationId}
           AND ra.role = ${body.role} AND u.email = ${body.email}`;
      if (alreadyHolds.length > 0) {
        throw problems.conflict('That person already holds this role at this facility.');
      }

      const token = generateToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      try {
        const row = await db.begin(async (tx) => {
          // Retire EXPIRED, never-accepted invitations for the same facility + email + role so
          // they cannot block a replacement via the "one open invitation" unique index. Their
          // tokens were already unusable (expires_at is enforced on preview/accept); marking
          // them revoked just frees the slot. Scoped by organization AND facility. Genuinely
          // pending (unexpired) invitations are untouched, so they still dedupe (409).
          const retired = await tx<{ id: string }[]>`
            UPDATE staff_invitations SET revoked_at = NOW()
             WHERE facility_id = ${facility.id} AND organization_id = ${auth.organizationId}
               AND lower(email) = ${body.email} AND role = ${body.role}
               AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()
            RETURNING id`;
          for (const old of retired) {
            await recordAdminEvent(tx, {
              organizationId: auth.organizationId,
              facilityId: facility.id,
              actorId: auth.staffUserId,
              eventType: 'invitation.expired_retired',
              targetType: 'invitation',
              targetId: old.id,
              details: { role: body.role },
            });
          }
          const rows = await tx<InvitationRow[]>`
            INSERT INTO staff_invitations
              (organization_id, facility_id, email, role, token_hash, invited_by, expires_at)
            VALUES (${auth.organizationId}, ${facility.id}, ${body.email}, ${body.role},
                    ${hashToken(token)}, ${auth.staffUserId}, ${expiresAt})
            RETURNING id, email, role, 'pending' AS status, expires_at, created_at`;
          const inv = rows[0];
          if (!inv) throw new Error('invitation insert returned no row');
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: 'invitation.created',
            targetType: 'invitation',
            targetId: inv.id,
            details: { role: body.role },
          });
          return inv;
        });

        // No email provider is configured (paid services are out of scope). The raw secret is
        // returned exactly once so the administrator can share the link; it is never logged.
        req.log.info(
          { invitationId: row.id, delivery: 'manual' },
          '[SANDBOX] invitation created; no email sent',
        );
        const acceptUrl = new URL('/accept-invite', env.WEB_BASE_URL);
        acceptUrl.hash = `token=${token}`;
        return await reply.status(201).send({
          invitation: toInvitationDto(row),
          delivery: 'manual',
          token,
          accept_url: acceptUrl.toString(),
        });
      } catch (err) {
        if (isUniqueViolation(err, 'staff_invitations_open_idx')) {
          throw problems.conflict('A pending invitation for that email and role already exists.');
        }
        throw err;
      }
    },
  );

  /** GET /api/v1/facilities/:id/invitations */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/invitations',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const rows = await db<InvitationRow[]>`
        SELECT id, email, role, expires_at, created_at,
               CASE WHEN accepted_at IS NOT NULL THEN 'accepted'
                    WHEN revoked_at IS NOT NULL THEN 'revoked'
                    WHEN expires_at <= NOW() THEN 'expired'
                    ELSE 'pending' END AS status
          FROM staff_invitations
         WHERE facility_id = ${facility.id} AND organization_id = ${auth.organizationId}
         ORDER BY created_at DESC`;
      return reply.send({ invitations: rows.map(toInvitationDto) });
    },
  );

  /** DELETE /api/v1/facilities/:id/invitations/:invitationId — revoke a pending invitation. */
  app.delete<{ Params: { id: string; invitationId: string } }>(
    '/facilities/:id/invitations/:invitationId',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'STAFF_MANAGE',
      );
      const invitationId = uuidParam(req.params.invitationId);
      await db.begin(async (tx) => {
        const rows = await tx`
          UPDATE staff_invitations SET revoked_at = NOW()
           WHERE id = ${invitationId} AND facility_id = ${facility.id}
             AND organization_id = ${auth.organizationId}
             AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING id`;
        if (rows.length === 0) throw problems.notFound();
        await recordAdminEvent(tx, {
          organizationId: auth.organizationId,
          facilityId: facility.id,
          actorId: auth.staffUserId,
          eventType: 'invitation.revoked',
          targetType: 'invitation',
          targetId: invitationId,
        });
      });
      return reply.status(204).send();
    },
  );

  /**
   * PATCH /api/v1/staff/:staffUserId — activate/deactivate a staff account (org_admin).
   * Deactivation destroys all of the user's sessions immediately.
   */
  app.patch<{ Params: { staffUserId: string } }>(
    '/staff/:staffUserId',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      requireOrgAdmin(auth);
      const staffUserId = uuidParam(req.params.staffUserId);
      const body = parseInput(UpdateStaffStatusSchema, req.body);
      if (staffUserId === auth.staffUserId) {
        throw problems.conflict('You cannot change the status of your own account.');
      }

      await db.begin(async (tx) => {
        // Serialize all org-admin status changes in this organization (ordered locks, no deadlock)
        // so the "never leave zero active organization administrators" rule is race-free,
        // including two admins deactivating each other at the same moment.
        await tx`
          SELECT u.id FROM staff_users u
            JOIN role_assignments ra ON ra.staff_user_id = u.id AND ra.role = ${Role.ORG_ADMIN}
           WHERE u.organization_id = ${auth.organizationId}
           ORDER BY u.id
             FOR UPDATE OF u`;
        const actor = await tx`
          SELECT 1 FROM staff_users WHERE id = ${auth.staffUserId} AND status = 'active'`;
        if (actor.length === 0) throw problems.unauthenticated();
        if (body.status === 'inactive') {
          const remaining = await tx`
            SELECT 1 FROM role_assignments ra
              JOIN staff_users u ON u.id = ra.staff_user_id
             WHERE ra.organization_id = ${auth.organizationId} AND ra.role = ${Role.ORG_ADMIN}
               AND u.status = 'active' AND u.id <> ${staffUserId}`;
          if (remaining.length === 0) {
            throw problems.conflict(
              'An organization must keep at least one active organization administrator.',
            );
          }
        }
        const rows = await tx`
          UPDATE staff_users SET status = ${body.status}, updated_at = NOW()
           WHERE id = ${staffUserId} AND organization_id = ${auth.organizationId}
          RETURNING id`;
        if (rows.length === 0) throw problems.notFound();
        if (body.status === 'inactive') {
          await tx`DELETE FROM staff_sessions WHERE staff_user_id = ${staffUserId}`;
        }
        await recordAdminEvent(tx, {
          organizationId: auth.organizationId,
          facilityId: null,
          actorId: auth.staffUserId,
          eventType: body.status === 'inactive' ? 'staff.deactivated' : 'staff.activated',
          targetType: 'staff_user',
          targetId: staffUserId,
        });
      });
      return reply.send({ id: staffUserId, status: body.status });
    },
  );
}
