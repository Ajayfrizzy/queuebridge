import type { FastifyInstance } from 'fastify';
import {
  AcceptInvitationRequestSchema,
  PreviewInvitationRequestSchema,
  type FacilityRole,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { createSession, resolveSession, setSessionCookie, toSessionUser } from '../auth/session.js';
import { hashToken } from '../auth/tokens.js';
import { parseInput, problems } from '../errors.js';
import type { RouteDeps } from './deps.js';

interface InvitationLookup {
  id: string;
  organization_id: string;
  facility_id: string;
  email: string;
  role: FacilityRole;
  organization_name: string;
  facility_name: string;
}

export async function invitationRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env } = deps;
  const rateLimit = { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' };

  /**
   * POST /api/v1/invitations/preview — what is this invitation for?
   * Token travels in the body (not the URL) so it never lands in access logs.
   */
  app.post('/invitations/preview', { config: { rateLimit } }, async (req, reply) => {
    const body = parseInput(PreviewInvitationRequestSchema, req.body);
    const rows = await db<InvitationLookup[]>`
      SELECT i.id, i.organization_id, i.facility_id, i.email, i.role,
             o.name AS organization_name, f.name AS facility_name
        FROM staff_invitations i
        JOIN organizations o ON o.id = i.organization_id
        JOIN facilities f ON f.id = i.facility_id
       WHERE i.token_hash = ${hashToken(body.token)}
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`;
    const inv = rows[0];
    if (!inv) throw problems.invalidInvitation();
    return reply.send({
      invitation: {
        organization_name: inv.organization_name,
        facility_name: inv.facility_name,
        email: inv.email,
        role: inv.role,
      },
    });
  });

  /**
   * POST /api/v1/invitations/accept — redeem an invitation (staff signup).
   * - New email in the organization: creates the account with the supplied password.
   * - Existing account: the supplied password must match; the role is simply added.
   * The invitation is single-use and consumed under a row lock.
   */
  app.post('/invitations/accept', { config: { rateLimit } }, async (req, reply) => {
    const body = parseInput(AcceptInvitationRequestSchema, req.body);
    const tokenHash = hashToken(body.token);

    const result = await db.begin(async (tx) => {
      const rows = await tx<InvitationLookup[]>`
        SELECT i.id, i.organization_id, i.facility_id, i.email, i.role,
               o.name AS organization_name, f.name AS facility_name
          FROM staff_invitations i
          JOIN organizations o ON o.id = i.organization_id
          JOIN facilities f ON f.id = i.facility_id
         WHERE i.token_hash = ${tokenHash}
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
         FOR UPDATE OF i`;
      const inv = rows[0];
      if (!inv) {
        await verifyAgainstDummy(body.password);
        throw problems.invalidInvitation();
      }

      const existing = await tx<{ id: string; password_hash: string; status: string }[]>`
        SELECT id, password_hash, status FROM staff_users
         WHERE organization_id = ${inv.organization_id} AND email = ${inv.email}`;

      let userId: string;
      const found = existing[0];
      if (found) {
        if (found.status !== 'active') throw problems.invalidInvitation();
        if (!(await verifyPassword(found.password_hash, body.password))) {
          throw problems.invalidCredentials();
        }
        userId = found.id;
      } else {
        const created = await tx<{ id: string }[]>`
          INSERT INTO staff_users (organization_id, email, password_hash, display_name)
          VALUES (${inv.organization_id}, ${inv.email}, ${await hashPassword(body.password)},
                  ${body.display_name})
          RETURNING id`;
        const createdId = created[0]?.id;
        if (!createdId) throw new Error('staff user insert returned no row');
        userId = createdId;
      }

      await tx`
        INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role, assigned_by)
        VALUES (${userId}, ${inv.organization_id}, ${inv.facility_id}, ${inv.role},
                (SELECT invited_by FROM staff_invitations WHERE id = ${inv.id}))
        ON CONFLICT DO NOTHING`;
      await tx`UPDATE staff_invitations SET accepted_at = NOW() WHERE id = ${inv.id}`;
      await recordAdminEvent(tx, {
        organizationId: inv.organization_id,
        facilityId: inv.facility_id,
        actorId: userId,
        eventType: 'invitation.accepted',
        targetType: 'invitation',
        targetId: inv.id,
        details: { role: inv.role },
      });
      const session = await createSession(tx, userId);
      return { token: session.token, expiresAt: session.expiresAt };
    });

    const auth = await resolveSession(db, result.token);
    if (!auth) throw problems.invalidInvitation();
    setSessionCookie(reply, env, result.token, result.expiresAt);
    return reply.status(201).send({ user: toSessionUser(auth) });
  });
}
