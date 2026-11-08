import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  JoinQueueRequestSchema,
  SecretTokenSchema,
  TicketCodeSchema,
} from '@queuebridge/contracts';
import { SlugSchema } from '@queuebridge/contracts';
import { parseInput, problems } from '../errors.js';
import { hashJoinProof, joinQueue } from '../queue/joins.js';
import { openSse } from '../queue/sse.js';
import {
  boardView,
  findPublicFacility,
  publicFacilityView,
  resolveStatusToken,
  ticketStatusView,
  type ResolvedStatusTicket,
} from '../queue/views.js';
import { uuidParam, type RouteDeps } from './deps.js';

/** Header carrying a visitor's ticket status token (never a URL parameter, so never logged). */
export const TICKET_TOKEN_HEADER = 'x-qb-ticket-token';

const SlugParams = z.object({ orgSlug: SlugSchema, facilitySlug: SlugSchema });

/**
 * Public, unauthenticated routes. Data minimization:
 *  - catalog: service names, queue ids (to join), counts, published policy, estimates
 *  - board: ticket codes + counter names only
 *  - ticket status: only with the ticket's status token; no internal ids, no personal data
 * Unknown, malformed and unauthorized lookups all return the same 404.
 */
export async function publicRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, notifier, env } = deps;

  async function facilityFromParams(
    params: unknown,
  ): Promise<NonNullable<Awaited<ReturnType<typeof findPublicFacility>>>> {
    const parsed = SlugParams.safeParse(params);
    if (!parsed.success) throw problems.notFound();
    const f = await findPublicFacility(db, parsed.data.orgSlug, parsed.data.facilitySlug);
    if (!f) throw problems.notFound();
    return f;
  }

  async function resolveTicket(
    req: FastifyRequest<{ Params: { code: string } }>,
  ): Promise<ResolvedStatusTicket> {
    const code = TicketCodeSchema.safeParse(req.params.code);
    const token = SecretTokenSchema.safeParse(req.headers[TICKET_TOKEN_HEADER]);
    if (!code.success || !token.success) throw problems.notFound();
    const resolved = await resolveStatusToken(db, token.data, code.data);
    if (!resolved) throw problems.notFound();
    return resolved;
  }

  const publicRead = {
    config: { rateLimit: { max: env.PUBLIC_READ_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };

  app.get('/public/facilities/:orgSlug/:facilitySlug', publicRead, async (req, reply) => {
    const f = await facilityFromParams(req.params);
    return reply.send({ facility: await publicFacilityView(db, f) });
  });

  app.get('/public/facilities/:orgSlug/:facilitySlug/board', publicRead, async (req, reply) => {
    const f = await facilityFromParams(req.params);
    return reply.send({ board: await boardView(db, f) });
  });

  app.get('/public/facilities/:orgSlug/:facilitySlug/stream', publicRead, async (req, reply) => {
    const f = await facilityFromParams(req.params);
    await openSse(req, reply, { notifier, filter: (s) => s.f === f.id, initialRevision: 0 });
  });

  /** POST /queues/:id/join — anonymous visitor join (no account). */
  app.post<{ Params: { id: string } }>(
    '/queues/:id/join',
    { config: { rateLimit: { max: env.JOIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const queueId = uuidParam(req.params.id);
      const body = parseInput(JoinQueueRequestSchema, req.body);
      const owner = await db<{ organization_id: string }[]>`
        SELECT organization_id FROM queue_sessions WHERE id = ${queueId}`;
      if (!owner[0]) throw problems.notFound();
      const result = await joinQueue(db, {
        organizationId: owner[0].organization_id,
        queueId,
        operationId: body.operation_id,
        proofHash: hashJoinProof(body.join_proof),
        staffUserId: null,
      });
      return reply.status(result.disposition === 'committed' ? 201 : 200).send({ ticket: result });
    },
  );

  app.get<{ Params: { code: string } }>('/tickets/:code/status', publicRead, async (req, reply) => {
    const resolved = await resolveTicket(req);
    return reply.send({ status: await ticketStatusView(db, resolved) });
  });

  app.get<{ Params: { code: string } }>('/tickets/:code/stream', publicRead, async (req, reply) => {
    const resolved = await resolveTicket(req);
    await openSse(req, reply, {
      notifier,
      filter: (s) => s.f === resolved.facilityId,
      initialRevision: 0,
    });
  });
}
