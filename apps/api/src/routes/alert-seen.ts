import type { FastifyInstance } from 'fastify';
import {
  SecretTokenSchema,
  TicketCodeSchema,
  TicketState,
  TurnAlertSeenRequestSchema,
} from '@queuebridge/contracts';
import { ApiProblem, parseInput, problems } from '../errors.js';
import { resolveStatusToken } from '../queue/views.js';
import type { RouteDeps } from './deps.js';
import { TICKET_TOKEN_HEADER } from './public.js';

/**
 * POST /tickets/:code/alerts/seen — M6.3 (design §13.4): the visitor's ticket page presented the
 * in-app "it is your turn" alert for this committed call event.
 *
 * - Authenticated by the ticket's status token (header), CSRF and Origin like every visitor write;
 *   a staff session, a push service or a service worker cannot send it.
 * - Accepted only for the ticket's CURRENT committed call event (state `called`, and the sequence
 *   of the latest committed call); anything else is 409 and records nothing.
 * - Idempotent: a repeat, a replay or a second tab is a no-op (one row per ticket and sequence).
 * - Written under the visitor contact's row lock, the lock the SMS worker holds while it decides to
 *   send: whichever commits first wins. Seen first → a DELAYED SMS is skipped; send started first →
 *   this changes nothing about that send.
 * It is used only to skip a delayed SMS. It is not proof the visitor read the alert, and its
 * absence is not proof they did not. It never changes the ticket, the queue or any timer.
 */
export async function alertSeenRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env } = deps;
  app.post<{ Params: { code: string } }>(
    '/tickets/:code/alerts/seen',
    { config: { rateLimit: { max: env.JOIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const code = TicketCodeSchema.safeParse(req.params.code);
      const token = SecretTokenSchema.safeParse(req.headers[TICKET_TOKEN_HEADER]);
      if (!code.success || !token.success) throw problems.notFound();
      const resolved = await resolveStatusToken(db, token.data, code.data);
      if (!resolved) throw problems.notFound();
      const body = parseInput(TurnAlertSeenRequestSchema, req.body);
      const t = resolved.ticket;
      const [call] = await db<{ sequence: number }[]>`
        SELECT e.sequence FROM ticket_transitions tt JOIN queue_events e ON e.id = tt.queue_event_id
         WHERE tt.ticket_id = ${t.id} AND tt.to_state = 'called'
         ORDER BY e.sequence DESC LIMIT 1`;
      if (t.state !== TicketState.CALLED || call?.sequence !== body.event_sequence) {
        throw new ApiProblem(409, 'alert-not-current', 'Not the current call', {
          detail: 'This alert is not for the current call of this ticket.',
        });
      }
      await db.begin(async (tx) => {
        await tx`
          SELECT id FROM visitor_contacts
           WHERE ticket_id = ${t.id} AND organization_id = ${t.organization_id}
             FOR UPDATE`;
        await tx`
          INSERT INTO turn_alert_seen (ticket_id, organization_id, event_sequence)
          VALUES (${t.id}, ${t.organization_id}, ${body.event_sequence})
          ON CONFLICT (ticket_id, event_sequence) DO NOTHING`;
      });
      return reply.status(204).send();
    },
  );
}
