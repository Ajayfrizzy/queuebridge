import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { ApiError } from '@queuebridge/contracts';
import { makeAuthenticate } from './auth/session.js';
import { createDb, type Db } from './db.js';
import { allowedOrigins, type Env } from './env.js';
import { ApiProblem, problems } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { capabilityRoutes } from './routes/capabilities.js';
import { counterRoutes } from './routes/counters.js';
import { facilityRoutes } from './routes/facilities.js';
import { invitationRoutes } from './routes/invitations.js';
import { organizationRoutes } from './routes/organizations.js';
import { publicRoutes } from './routes/public.js';
import { queueRoutes } from './routes/queues.js';
import { QueueNotifier } from './queue/notifier.js';
import { serviceRoutes } from './routes/services.js';
import { staffRoutes } from './routes/staff.js';
import { syncRoutes } from './routes/sync.js';
import { fairnessRoutes } from './routes/fairness.js';
import type { RouteDeps } from './routes/deps.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const GENERIC_TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
};

/**
 * Build the Fastify application instance.
 * Separated from server.ts so it can be used in tests without binding a port.
 *
 * @param options.db  Inject a SQL client (tests). When omitted a pool is created from env
 *                    and closed with the app.
 */
export async function buildApp(
  env: Env,
  options: { db?: Db; logStream?: NodeJS.WritableStream } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Defence in depth: never emit credentials even if a future serializer adds headers
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    genReqId: () => crypto.randomUUID(),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });

  const ownsDb = options.db === undefined;
  const db = options.db ?? createDb(env);
  // Live-update fan-out; closed before the pool so UNLISTEN can complete
  const notifier = new QueueNotifier(db, app.log);
  app.addHook('onClose', async () => {
    await notifier.close();
  });
  if (ownsDb) {
    app.addHook('onClose', async () => {
      await db.end({ timeout: 5 });
    });
  }

  const origins = allowedOrigins(env);

  await app.register(cookie);
  await app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-qb-csrf', 'x-qb-ticket-token'],
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('auth', null);

  // ---------------------------------------------------------------------------
  // Security headers
  // ---------------------------------------------------------------------------

  const applySecurityHeaders = (req: FastifyRequest, reply: FastifyReply): void => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
  };
  // Set early so hijacked responses (SSE streams copy reply.getHeaders()) carry them too, and
  // again on send so nothing set later in the lifecycle can drop them.
  app.addHook('onRequest', async (req, reply) => applySecurityHeaders(req, reply));
  app.addHook('onSend', async (req, reply) => applySecurityHeaders(req, reply));

  // ---------------------------------------------------------------------------
  // CSRF mitigation for cookie-authenticated requests.
  // SameSite=Strict is the first layer; this adds an Origin allow-list check and a
  // custom header that cross-site forms cannot send (and CORS only permits for our origins).
  // ---------------------------------------------------------------------------

  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const path = req.url.split('?')[0] ?? req.url;
    // Every state-changing API request needs the custom header (which cross-site forms cannot
    // send and CORS only permits for our origins) — including anonymous ones such as visitor
    // joins, so a third-party page cannot make browsers mass-join queues.
    if (!path.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !origins.includes(origin.replace(/\/$/, ''))) {
      throw problems.csrf();
    }
    if (req.headers['x-qb-csrf'] !== '1') {
      throw problems.csrf();
    }
  });

  // ---------------------------------------------------------------------------
  // Health endpoints (no auth required)
  // ---------------------------------------------------------------------------

  app.get('/health', async (_req, reply) => {
    await reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/health/ready', async (req, reply) => {
    let databaseOk = false;
    try {
      await db`SELECT 1`;
      databaseOk = true;
    } catch (err) {
      req.log.error({ err }, 'Readiness check: database unreachable');
    }
    await reply.status(databaseOk ? 200 : 503).send({
      status: databaseOk ? 'ok' : 'unavailable',
      timestamp: new Date().toISOString(),
      checks: { database: databaseOk ? 'ok' : 'unavailable' },
    });
  });

  // ---------------------------------------------------------------------------
  // Global error handler — RFC 9457 problem detail responses
  // ---------------------------------------------------------------------------

  app.setErrorHandler(async (error: FastifyError | ApiProblem, req, reply) => {
    let problem: ApiError;
    let status: number;

    if (error instanceof ApiProblem) {
      status = error.status;
      problem = {
        type: error.type,
        title: error.message,
        status,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
        ...(error.errors !== undefined ? { errors: error.errors } : {}),
        instance: req.id,
        retryable: false,
      };
      if (error.headers) void reply.headers(error.headers);
      req.log.warn(
        { status, problem: error.slug, path: req.url.split('?')[0] },
        'Request rejected',
      );
    } else if (
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      // Framework-level client errors (malformed JSON, oversized body, rate limit, ...)
      status = error.statusCode;
      problem = {
        title: GENERIC_TITLES[status] ?? 'Request error',
        status,
        instance: req.id,
        retryable: status === 429,
      };
      req.log.warn({ status, code: error.code, path: req.url.split('?')[0] }, 'Request rejected');
    } else {
      status = 500;
      problem = {
        title: 'Internal server error',
        status,
        instance: req.id,
        retryable: true,
      };
      // Full error is logged server-side only — never returned to the client
      req.log.error({ err: error, path: req.url.split('?')[0] }, 'Unhandled request error');
    }

    await reply.status(status).header('Content-Type', 'application/problem+json').send(problem);
  });

  // ---------------------------------------------------------------------------
  // 404 handler
  // ---------------------------------------------------------------------------

  app.setNotFoundHandler(async (req, reply) => {
    const problem: ApiError = {
      title: 'Not found',
      status: 404,
      instance: req.id,
      retryable: false,
    };

    await reply.status(404).header('Content-Type', 'application/problem+json').send(problem);
  });

  // (Error handlers must be set before child plugins are registered so they inherit them.)

  // ---------------------------------------------------------------------------
  // API routes (/api/v1)
  // ---------------------------------------------------------------------------

  const deps: RouteDeps = {
    db,
    env,
    authenticate: makeAuthenticate(db),
    notifier,
  };

  await app.register(
    async (api) => {
      await api.register(organizationRoutes, deps);
      await api.register(authRoutes, deps);
      await api.register(invitationRoutes, deps);
      await api.register(facilityRoutes, deps);
      await api.register(serviceRoutes, deps);
      await api.register(counterRoutes, deps);
      await api.register(capabilityRoutes, deps);
      await api.register(staffRoutes, deps);
      await api.register(queueRoutes, deps);
      await api.register(syncRoutes, deps);
      await api.register(fairnessRoutes, deps);
      await api.register(publicRoutes, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
