import type { FastifyInstance } from 'fastify';
import { LoginRequestSchema } from '@queuebridge/contracts';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { requireAuth } from '../auth/session.js';
import {
  clearSessionCookie,
  createSession,
  resolveSession,
  setSessionCookie,
  toSessionInfo,
  toSessionUser,
} from '../auth/session.js';
import { parseInput, problems } from '../errors.js';
import type { RouteDeps } from './deps.js';

interface LoginRow {
  id: string;
  password_hash: string;
}

export async function authRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;

  /** POST /api/v1/auth/login — organization slug + email + password. */
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseInput(LoginRequestSchema, req.body);

      const rows = await db<LoginRow[]>`
        SELECT u.id, u.password_hash
          FROM staff_users u
          JOIN organizations o ON o.id = u.organization_id
         WHERE o.slug = ${body.organization_slug}
           AND u.email = ${body.email}
           AND u.status = 'active'`;
      const user = rows[0];

      // Uniform failure: same status, body and (approximately) the same CPU cost for
      // unknown org, unknown email, inactive user and wrong password.
      if (!user) {
        await verifyAgainstDummy(body.password);
        throw problems.invalidCredentials();
      }
      if (!(await verifyPassword(user.password_hash, body.password))) {
        throw problems.invalidCredentials();
      }

      const session = await createSession(db, user.id);
      const auth = await resolveSession(db, session.token);
      if (!auth) throw problems.invalidCredentials();
      setSessionCookie(reply, env, session.token, session.expiresAt);
      return reply.send({ user: toSessionUser(auth), session: toSessionInfo(auth) });
    },
  );

  /** POST /api/v1/auth/logout — destroys the server-side session. */
  app.post('/auth/logout', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    await db`DELETE FROM staff_sessions WHERE id = ${auth.sessionId}`;
    clearSessionCookie(reply, env);
    return reply.status(204).send();
  });

  /** GET /api/v1/auth/me — the current principal (roles are advisory for UI only). */
  app.get('/auth/me', { preHandler: authenticate }, async (req, reply) => {
    return reply.send({
      user: toSessionUser(requireAuth(req)),
      session: toSessionInfo(requireAuth(req)),
    });
  });
}
