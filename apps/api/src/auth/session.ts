import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RoleGrant, SessionUser } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { problems } from '../errors.js';
import type { AuthContext } from './rbac.js';
import { generateToken, hashToken } from './tokens.js';

export const SESSION_COOKIE = 'qb_session';
/** Absolute session lifetime. Sessions are also invalidated on logout/deactivation. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LAST_USED_REFRESH_MS = 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Create a server-side session and return the raw token (shown to the browser only once). */
export async function createSession(
  db: Db,
  staffUserId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db`
    INSERT INTO staff_sessions (staff_user_id, token_hash, expires_at)
    VALUES (${staffUserId}, ${hashToken(token)}, ${expiresAt})`;
  return { token, expiresAt };
}

export function setSessionCookie(
  reply: FastifyReply,
  env: Env,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Browsers treat http://localhost as a secure context, so Secure is safe outside `development`.
    secure: env.NODE_ENV !== 'development',
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: Env): void {
  void reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'strict',
    path: '/',
  });
}

interface SessionRow {
  session_id: string;
  last_used_at: Date;
  staff_user_id: string;
  organization_id: string;
  email: string;
  display_name: string;
  org_name: string;
  org_slug: string;
}

/** Resolve a raw session token to an AuthContext, or null if invalid/expired/deactivated. */
export async function resolveSession(db: Db, token: string): Promise<AuthContext | null> {
  const rows = await db<SessionRow[]>`
    SELECT s.id AS session_id, s.last_used_at, u.id AS staff_user_id, u.organization_id,
           u.email, u.display_name, o.name AS org_name, o.slug AS org_slug
      FROM staff_sessions s
      JOIN staff_users u ON u.id = s.staff_user_id AND u.status = 'active'
      JOIN organizations o ON o.id = u.organization_id
     WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > NOW()`;
  const row = rows[0];
  if (!row) return null;

  const roles = await loadRoles(db, row.staff_user_id, row.organization_id);

  if (Date.now() - row.last_used_at.getTime() > LAST_USED_REFRESH_MS) {
    await db`UPDATE staff_sessions SET last_used_at = NOW() WHERE id = ${row.session_id}`;
  }

  return {
    sessionId: row.session_id,
    staffUserId: row.staff_user_id,
    organizationId: row.organization_id,
    organizationName: row.org_name,
    organizationSlug: row.org_slug,
    email: row.email,
    displayName: row.display_name,
    roles,
  };
}

export async function loadRoles(
  db: Db,
  staffUserId: string,
  organizationId: string,
): Promise<RoleGrant[]> {
  return db<RoleGrant[]>`
    SELECT role, facility_id
      FROM role_assignments
     WHERE staff_user_id = ${staffUserId} AND organization_id = ${organizationId}
     ORDER BY role, facility_id`;
}

export function toSessionUser(auth: AuthContext): SessionUser {
  return {
    id: auth.staffUserId,
    email: auth.email,
    display_name: auth.displayName,
    organization: {
      id: auth.organizationId,
      name: auth.organizationName,
      slug: auth.organizationSlug,
    },
    roles: auth.roles,
  };
}

/** Build the preHandler that authenticates a request from the session cookie. */
export function makeAuthenticate(
  db: Db,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token || token.length > 256) throw problems.unauthenticated();
    const auth = await resolveSession(db, token);
    if (!auth) throw problems.unauthenticated();
    req.auth = auth;
  };
}

/** Narrow `req.auth` after the authenticate preHandler has run. */
export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw problems.unauthenticated();
  return req.auth;
}
