import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  KbKnownParamSchema,
  RestrictedKbResponseSchema,
  type Audience,
  type PublicKbResponse,
  type RestrictedKbResponse,
} from '@queuebridge/contracts';
import { audiencesFor, restrictedArticles } from '@queuebridge/assist';
import { roleDigest } from '../auth/role-digest.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput } from '../errors.js';
import { buildCapabilityManifest, capabilityFlags } from '../que/capabilities.js';
import { loadKnowledgeBase, type LoadedKnowledgeBase } from '../que/kb.js';
import type { RouteDeps } from './deps.js';

/**
 * Ask Que (F13) API — MQ.1 and MQ.2 scope. Read-only: every route is a GET, reads no tenant
 * table and writes nothing.
 *
 * - `GET /que/capabilities` (public): server-authoritative capability manifest (D1).
 * - `GET /que/kb/public` (public): the compiled visitor bundle only.
 * - `GET /que/kb` (authenticated): restricted articles for the session's audiences, with the
 *   server-issued role fingerprint (D2) and offline authorization metadata (design §11.5.2).
 *
 * The AI endpoint (MQ.4) is not implemented.
 */

const RestrictedQuerySchema = z.object({ known: KbKnownParamSchema.optional() }).strict();

const helpUnavailable = (): ApiProblem =>
  new ApiProblem(503, 'help-unavailable', 'Built-in help is unavailable', {
    detail: 'Built-in help could not be loaded on the server. Try again later.',
    retryable: true,
  });

export async function queRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { env, authenticate } = deps;
  // Configuration is read once at start-up; a configuration change needs a restart, exactly
  // like the features it describes (`GET /push/capability` follows the same rule).
  const flags = capabilityFlags(env);
  const rateLimit = { max: env.PUBLIC_READ_RATE_LIMIT_MAX, timeWindow: '1 minute' };

  let kb: LoadedKnowledgeBase | null = null;
  try {
    kb = loadKnowledgeBase();
  } catch (e) {
    app.log.error(
      { err: e },
      'Ask Que knowledge base could not be loaded; help endpoints answer 503',
    );
  }

  app.get('/que/capabilities', { config: { rateLimit } }, async (_req, reply) => {
    // Caching follows the API-wide security headers (no-store); the service worker keeps an
    // offline copy (stale-while-revalidate, apps/web vite.config.ts)
    return reply.send(buildCapabilityManifest(flags, new Date()));
  });

  app.get('/que/kb/public', { config: { rateLimit } }, async (_req, reply) => {
    if (!kb) throw helpUnavailable();
    const body: PublicKbResponse = {
      kbVersion: kb.kbVersion,
      audience: 'visitor',
      articles: kb.bundles.visitor.articles,
    };
    return reply.send(body);
  });

  app.get('/que/kb', { preHandler: authenticate, config: { rateLimit } }, async (req, reply) => {
    const auth = requireAuth(req);
    const query = parseInput(RestrictedQuerySchema, req.query);
    if (!kb) throw helpUnavailable();

    // Audiences come only from the server-loaded grants of this session (never from the client)
    const audiences = audiencesFor(auth.roles).filter(
      (a): a is Exclude<Audience, 'visitor'> => a !== 'visitor',
    );
    const authorized = restrictedArticles(kb.bundles, audiences);

    const now = Date.now();
    const authorizedUntil = Math.min(
      auth.sessionExpiresAt.getTime(),
      now + env.QUE_OFFLINE_HELP_TTL_SECONDS * 1000,
    );
    const known = new Map((query.known ?? []).map((k) => [k.id, k.version]));

    const body: RestrictedKbResponse = RestrictedKbResponseSchema.parse({
      userId: auth.staffUserId,
      roleDigest: roleDigest(auth),
      audiences,
      kbVersion: kb.kbVersion,
      issuedAt: new Date(now).toISOString(),
      authorizedUntil: new Date(authorizedUntil).toISOString(),
      validForMs: Math.max(0, authorizedUntil - now),
      index: authorized.map((a) => ({ id: a.id, version: a.version })),
      // Incremental update: articles the client already holds at this version are not resent
      articles: authorized.filter((a) => known.get(a.id) !== a.version),
    });
    return reply.send(body);
  });
}
