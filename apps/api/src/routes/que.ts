import type { FastifyInstance } from 'fastify';
import { buildCapabilityManifest, capabilityFlags } from '../que/capabilities.js';
import type { RouteDeps } from './deps.js';

/**
 * Ask Que (F13) API — MQ.1 scope only.
 *
 * `GET /api/v1/que/capabilities` is public (visitor help needs no staff authentication) and
 * returns the server-authoritative capability manifest (decision D1). It is read-only: it
 * reads no tenant data, touches no database table and has no session-dependent output.
 * Restricted KB delivery (MQ.2) and the AI endpoint (MQ.4) are not implemented here.
 */
export async function queRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { env } = deps;
  // Configuration is read once at start-up; a configuration change needs a restart, exactly
  // like the features it describes (`GET /push/capability` follows the same rule).
  const flags = capabilityFlags(env);

  app.get(
    '/que/capabilities',
    { config: { rateLimit: { max: env.PUBLIC_READ_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      // Caching follows the API-wide security headers (no-store); offline copies are MQ.2
      return reply.send(buildCapabilityManifest(flags, new Date()));
    },
  );
}
