import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  KbKnownParamSchema,
  QUE_AI_CONSENT_VERSION,
  QueAiSettingsUpdateSchema,
  QueAnswerSchema,
  QueAskRequestSchema,
  RestrictedKbResponseSchema,
  type Audience,
  type QueAiSettings,
  type PublicKbResponse,
  type RestrictedKbResponse,
} from '@queuebridge/contracts';
import { audiencesFor, restrictedArticles } from '@queuebridge/assist';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission } from '../auth/rbac.js';
import { roleDigest } from '../auth/role-digest.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput } from '../errors.js';
import { buildCapabilityManifest, capabilityFlags } from '../que/capabilities.js';
import { PerUserLimiter, askQue } from '../que/ask.js';
import { aiDeploymentAvailable, createInferenceAdapter } from '../que/inference.js';
import { loadKnowledgeBase, type LoadedKnowledgeBase } from '../que/kb.js';
import { uuidParam, type RouteDeps } from './deps.js';

/**
 * Ask Que (F13) API — MQ.1, MQ.2 and MQ.4 scope. Que is read-only with respect to queues,
 * tickets, staff and facility operations: no route here can change any of them.
 *
 * - `GET /que/capabilities` (public): server-authoritative capability manifest (D1).
 * - `GET /que/kb/public` (public): the compiled visitor bundle only.
 * - `GET /que/kb` (authenticated): restricted articles for the session's audiences, with the
 *   server-issued role fingerprint (D2) and offline authorization metadata (design §11.5.2).
 *
 * - `POST /que/ask` (staff session, facility-scoped; MQ.4): optional AI explanation of the
 *   deterministic answer, or the deterministic answer with a `fallbackReason`. Its only write is
 *   the aggregate daily-cap counter.
 * - `GET|PUT /facilities/:id/que-ai` (MQ.4): the facility's audited AI opt-in. PUT needs
 *   FACILITY_CONFIGURE (facility admin or org admin) and the current disclosure acknowledgement.
 *
 * AI is disabled by default; no provider is selected.
 */

const RestrictedQuerySchema = z.object({ known: KbKnownParamSchema.optional() }).strict();

const aiRateLimited = (): ApiProblem =>
  new ApiProblem(429, 'que-ask-rate-limited', 'Too many questions', {
    detail: 'Wait a minute before asking again. Built-in help remains available.',
    retryable: true,
  });

const helpUnavailable = (): ApiProblem =>
  new ApiProblem(503, 'help-unavailable', 'Built-in help is unavailable', {
    detail: 'Built-in help could not be loaded on the server. Try again later.',
    retryable: true,
  });

export async function queRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;
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

  // MQ.4 optional AI layer (no provider selected: disabled unless explicitly configured)
  const adapter = createInferenceAdapter(env);
  const deploymentAvailable = aiDeploymentAvailable(env) && adapter.id !== 'disabled';
  const perUser = new PerUserLimiter(env.QUE_AI_RATE_LIMIT_MAX);
  if (adapter.id === 'sandbox') {
    app.log.warn('[SANDBOX] Ask Que AI uses the TEST-ONLY sandbox inference adapter (no network)');
  }

  async function aiSettings(organizationId: string, facilityId: string): Promise<QueAiSettings> {
    const rows = await db<
      { enabled: boolean; consent_version: string | null; consented_at: Date | null }[]
    >`
      SELECT enabled, consent_version, consented_at FROM facility_que_ai_settings
       WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}`;
    const r = rows[0];
    const optedIn = r?.enabled === true;
    return {
      opted_in: optedIn,
      deployment_available: deploymentAvailable,
      available: optedIn && deploymentAvailable,
      consent_version: optedIn ? (r?.consent_version ?? null) : null,
      consented_at: optedIn && r?.consented_at ? r.consented_at.toISOString() : null,
    };
  }

  app.get<{ Params: { id: string } }>(
    '/facilities/:id/que-ai',
    { preHandler: authenticate, config: { rateLimit } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      return reply.send(await aiSettings(auth.organizationId, facility.id));
    },
  );

  app.put<{ Params: { id: string } }>(
    '/facilities/:id/que-ai',
    { preHandler: authenticate, config: { rateLimit } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const body = parseInput(QueAiSettingsUpdateSchema, req.body);
      await db.begin(async (tx) => {
        const [prev] = await tx<{ enabled: boolean }[]>`
          SELECT enabled FROM facility_que_ai_settings
           WHERE facility_id = ${facility.id} AND organization_id = ${auth.organizationId}
           FOR UPDATE`;
        if (body.enabled) {
          await tx`
            INSERT INTO facility_que_ai_settings
              (facility_id, organization_id, enabled, consent_version, consented_by, consented_at, updated_by, updated_at)
            VALUES (${facility.id}, ${auth.organizationId}, TRUE, ${QUE_AI_CONSENT_VERSION},
                    ${auth.staffUserId}, NOW(), ${auth.staffUserId}, NOW())
            ON CONFLICT (facility_id) DO UPDATE SET
              enabled = TRUE, consent_version = EXCLUDED.consent_version,
              consented_by = EXCLUDED.consented_by, consented_at = EXCLUDED.consented_at,
              updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
        } else {
          await tx`
            INSERT INTO facility_que_ai_settings (facility_id, organization_id, enabled, updated_by, updated_at)
            VALUES (${facility.id}, ${auth.organizationId}, FALSE, ${auth.staffUserId}, NOW())
            ON CONFLICT (facility_id) DO UPDATE SET
              enabled = FALSE, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
        }
        // Audited only when the setting actually changes (no names, no question text)
        if ((prev?.enabled ?? false) !== body.enabled) {
          await recordAdminEvent(tx, {
            organizationId: auth.organizationId,
            facilityId: facility.id,
            actorId: auth.staffUserId,
            eventType: body.enabled ? 'que_ai.enabled' : 'que_ai.disabled',
            targetType: 'facility',
            targetId: facility.id,
            details: body.enabled
              ? {
                  consent_version: QUE_AI_CONSENT_VERSION,
                  deployment_available: deploymentAvailable,
                }
              : { deployment_available: deploymentAvailable },
          });
        }
      });
      return reply.send(await aiSettings(auth.organizationId, facility.id));
    },
  );

  app.post(
    '/que/ask',
    {
      preHandler: authenticate,
      // Per IP: several staff of one facility often share an address (NAT), so the IP limit is a
      // multiple of the per-user limit applied in the handler
      config: { rateLimit: { max: env.QUE_AI_RATE_LIMIT_MAX * 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = parseInput(QueAskRequestSchema, req.body);
      // Facility-scoped: another organization's or an unassigned facility is a 404
      await requireFacilityPermission(db, auth, body.facility_id, 'FACILITY_READ');
      if (!kb) throw helpUnavailable();
      if (!perUser.allow(auth.staffUserId)) throw aiRateLimited();
      const clientGone = new AbortController();
      // The client went away before the answer was written: stop the adapter call
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) clientGone.abort();
      });
      const outcome = await askQue(
        {
          db,
          kb,
          adapter,
          manifest: buildCapabilityManifest(flags, new Date()),
          deploymentAvailable,
          dailyCap: env.QUE_AI_DAILY_CAP,
          timeoutMs: env.QUE_AI_TIMEOUT_MS,
          clientSignal: clientGone.signal,
        },
        { organizationId: auth.organizationId, roles: auth.roles },
        body,
      );
      // Logs carry no question or answer text (design §11.7)
      req.log.info(
        {
          que_ai: {
            adapter: adapter.id,
            mode: outcome.answer.mode,
            fallback_reason: outcome.answer.fallbackReason ?? null,
            attempted: outcome.attempted,
            latency_ms: outcome.latencyMs,
            redactions: outcome.redactions,
          },
        },
        adapter.id === 'sandbox' ? '[SANDBOX] que ask' : 'que ask',
      );
      return reply.send(QueAnswerSchema.parse(outcome.answer));
    },
  );

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
