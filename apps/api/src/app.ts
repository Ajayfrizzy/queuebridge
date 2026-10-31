import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiError } from '@queuebridge/contracts';
import type { Env } from './env.js';

/**
 * Build the Fastify application instance.
 * Separated from server.ts so it can be used in tests without binding a port.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          }
        : {}),
    },
    genReqId: () => crypto.randomUUID(),
  });

  // ---------------------------------------------------------------------------
  // Health endpoints (no auth required)
  // ---------------------------------------------------------------------------

  app.get('/health', async (_req, reply) => {
    await reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/health/ready', async (_req, reply) => {
    // TODO (M1): check database connectivity here
    // For M0 we just confirm the process is running
    await reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'not_yet_implemented',
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Global error handler — RFC 9457 problem detail responses
  // ---------------------------------------------------------------------------

  app.setErrorHandler(async (error, req, reply) => {
    const status = reply.statusCode >= 400 ? reply.statusCode : 500;

    const problem: ApiError = {
      title: status >= 500 ? 'Internal server error' : error.message,
      status,
      instance: req.id,
      retryable: status >= 500,
      // Never expose stack traces to clients
      detail: env.NODE_ENV === 'development' ? error.message : undefined,
    };

    req.log.error({ err: error, reqId: req.id, path: req.url }, 'Request error');

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

  return app;
}
