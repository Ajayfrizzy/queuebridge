import type { FastifyInstance } from 'fastify';
import { CreateOrganizationRequestSchema, Role } from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { hashPassword } from '../auth/password.js';
import {
  createSession,
  resolveSession,
  setSessionCookie,
  toSessionInfo,
  toSessionUser,
} from '../auth/session.js';
import { isUniqueViolation, parseInput, problems } from '../errors.js';
import type { RouteDeps } from './deps.js';

export async function organizationRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env } = deps;

  /**
   * POST /api/v1/organizations — public self-service signup (F10).
   * Creates the organization, its first administrator (org_admin) and signs them in.
   */
  app.post(
    '/organizations',
    { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseInput(CreateOrganizationRequestSchema, req.body);
      const passwordHash = await hashPassword(body.admin_password);

      let created: { userId: string; token: string; expiresAt: Date };
      try {
        created = await db.begin(async (tx) => {
          const orgRows = await tx<{ id: string }[]>`
            INSERT INTO organizations (name, slug)
            VALUES (${body.organization_name}, ${body.organization_slug})
            RETURNING id`;
          const orgId = orgRows[0]?.id;
          if (!orgId) throw new Error('organization insert returned no row');

          const userRows = await tx<{ id: string }[]>`
            INSERT INTO staff_users (organization_id, email, password_hash, display_name)
            VALUES (${orgId}, ${body.admin_email}, ${passwordHash}, ${body.admin_display_name})
            RETURNING id`;
          const userId = userRows[0]?.id;
          if (!userId) throw new Error('staff user insert returned no row');

          await tx`
            INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role, assigned_by)
            VALUES (${userId}, ${orgId}, NULL, ${Role.ORG_ADMIN}, ${userId})`;

          await recordAdminEvent(tx, {
            organizationId: orgId,
            facilityId: null,
            actorId: userId,
            eventType: 'organization.created',
            targetType: 'organization',
            targetId: orgId,
          });

          const session = await createSession(tx, userId);
          return { userId, token: session.token, expiresAt: session.expiresAt };
        });
      } catch (err) {
        if (isUniqueViolation(err, 'organizations_slug_idx')) {
          throw problems.conflict('That organization address is already taken.');
        }
        throw err;
      }

      const auth = await resolveSession(db, created.token);
      if (!auth) throw new Error('session not resolvable immediately after creation');
      setSessionCookie(reply, env, created.token, created.expiresAt);
      return reply.status(201).send({ user: toSessionUser(auth), session: toSessionInfo(auth) });
    },
  );
}
