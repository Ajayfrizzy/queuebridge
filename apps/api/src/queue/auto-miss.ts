import { createHash } from 'node:crypto';
import { QueueAction, SystemActor, TicketState, recoveryPolicyOf } from '@queuebridge/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db.js';
import { ApiProblem } from '../errors.js';
import { executeSystemTransition, SystemTransitionSkipped } from './commands.js';

/**
 * M5.1 automatic no-show (REQ-F4.14, design §15.8). OFF unless a service enables it.
 *
 * - Executes only through the authoritative command machinery (`executeSystemTransition`):
 *   session then ticket lock, the domain transition table (`system` actor, `called → missed`
 *   only), the hash-chained event and a `client_operations` record.
 * - Idempotent across API instances: the operation id is derived from the ticket and the call it
 *   acts on, so concurrent sweepers produce one miss and the rest a `duplicate` (or a skip).
 * - Never bypasses M3 fencing: refused while a coordinator is assigned, and the clock restarts
 *   after the latest coordinator event, so a visitor the coordinator served offline is not missed
 *   before that coordinator's actions can arrive.
 * - Stateless: every pass recomputes from the database (restarts lose nothing); a late pass only
 *   delays a miss ("not before" the deadline, never earlier); after a detected outage (no pass for
 *   3 intervals) the clock restarts for every called ticket.
 * - Reads no notification, push, SMS, outbox or delivery data: alert outcomes are never evidence.
 */

export interface SweepOptions {
  intervalSeconds: number;
  batchSize?: number;
  /**
   * TESTS ONLY: shift "now" forward. Queue events are append-only, so tests cannot backdate a
   * call; they move the sweep's clock instead. Production always uses the database clock.
   */
  testClockOffsetSeconds?: number;
}

export interface SweepResult {
  candidates: number;
  missed: number;
  skipped: number;
  outageDetected: boolean;
}

/** Deterministic UUID v7-layout id: timestamp = the call's commit time, rest = SHA-256 of the call. */
export function autoMissOperationId(
  ticketId: string,
  callSequence: number,
  calledAt: Date,
): string {
  const h = createHash('sha256')
    .update(`queuebridge:auto-miss:v1|${ticketId}|${callSequence}`)
    .digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(calledAt.getTime(), 0, 6);
  h.copy(b, 6, 0, 10);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f); // version 7
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f); // RFC 4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

interface Candidate {
  ticket_id: string;
  organization_id: string;
  queue_session_id: string;
  call_sequence: number;
  called_at: Date;
}

/** The call a ticket is currently answering: its latest transition INTO `called`. */
const CURRENT_CALL = `
  SELECT e.sequence, e.committed_at FROM ticket_transitions tt
    JOIN queue_events e ON e.id = tt.queue_event_id
   WHERE tt.ticket_id = t.id AND tt.to_state = 'called'
   ORDER BY e.sequence DESC LIMIT 1`;

/**
 * Heartbeat and outage detection. Returns the end of the latest detected outage (or null).
 * A pass that finds the previous one older than 3 intervals records an outage ending now.
 */
async function heartbeat(
  db: Db,
  intervalSeconds: number,
  offset: number,
): Promise<{
  outageEnd: Date | null;
  detected: boolean;
}> {
  const [r] = await db<{ outage_end_at: Date | null; detected: boolean }[]>`
    INSERT INTO auto_miss_sweeps AS s (id, last_pass_at, outage_end_at)
    VALUES (TRUE, NOW() + make_interval(secs => ${offset}), NOW() + make_interval(secs => ${offset}))
    ON CONFLICT (id) DO UPDATE SET
      outage_end_at = CASE
        WHEN s.last_pass_at < NOW() + make_interval(secs => ${offset})
                            - make_interval(secs => ${3 * intervalSeconds})
        THEN NOW() + make_interval(secs => ${offset}) ELSE s.outage_end_at END
    RETURNING outage_end_at,
              (xmax = 0 OR outage_end_at = NOW() + make_interval(secs => ${offset})) AS detected`;
  return { outageEnd: r?.outage_end_at ?? null, detected: Boolean(r?.detected) };
}

export async function runAutoMissSweep(
  db: Db,
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
  opts: SweepOptions,
): Promise<SweepResult> {
  const offset = opts.testClockOffsetSeconds ?? 0;
  const batch = opts.batchSize ?? 50;
  const hb = await heartbeat(db, opts.intervalSeconds, offset);
  const candidates = await db<Candidate[]>`
    SELECT t.id AS ticket_id, t.organization_id, t.queue_session_id,
           c.sequence AS call_sequence, c.committed_at AS called_at
      FROM tickets t
      JOIN queue_sessions qs ON qs.id = t.queue_session_id
      JOIN services s ON s.id = qs.service_id
      CROSS JOIN LATERAL (${db.unsafe(CURRENT_CALL)}) c
      LEFT JOIN LATERAL (
        SELECT MAX(ce.committed_at) AS at FROM queue_events ce
         WHERE ce.queue_session_id = qs.id AND ce.event_type LIKE 'coordinator.%') co ON TRUE
     WHERE t.state = 'called' AND qs.state = 'open' AND qs.coordinator_device_id IS NULL
       AND s.policy -> 'auto_miss' ->> 'enabled' = 'true'
       AND s.policy -> 'auto_miss' ? 'after_seconds'
       AND NOW() + make_interval(secs => ${offset}) >=
           GREATEST(c.committed_at, COALESCE(co.at, c.committed_at),
                    COALESCE(${hb.outageEnd}::timestamptz, c.committed_at))
           + make_interval(secs => (s.policy -> 'auto_miss' ->> 'after_seconds')::int)
     ORDER BY t.queue_session_id, t.id
     LIMIT ${batch}`;
  let missed = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      const outcome = await executeSystemTransition(db, {
        organizationId: c.organization_id,
        queueId: c.queue_session_id,
        ticketId: c.ticket_id,
        operationId: autoMissOperationId(c.ticket_id, c.call_sequence, c.called_at),
        actor: SystemActor.SYSTEM,
        action: QueueAction.TICKET_MISS,
        payload: { reason_code: 'call_window_elapsed', call_sequence: c.call_sequence },
        // Re-checked UNDER the locks with the current policy and the database clock
        preconditions: async (tx, session, ticket) => {
          if (ticket.state !== TicketState.CALLED) throw new SystemTransitionSkipped('not_called');
          if (session.state !== 'open') throw new SystemTransitionSkipped('queue_not_open');
          const am = recoveryPolicyOf(session.policy).auto_miss;
          if (!am.enabled || am.after_seconds === null) {
            throw new SystemTransitionSkipped('auto_miss_disabled');
          }
          const [due] = await tx<{ ok: boolean }[]>`
            SELECT (c.sequence = ${c.call_sequence}
                    AND NOW() + make_interval(secs => ${offset}) >=
                        GREATEST(c.committed_at,
                                 COALESCE((SELECT MAX(ce.committed_at) FROM queue_events ce
                                            WHERE ce.queue_session_id = ${session.id}
                                              AND ce.event_type LIKE 'coordinator.%'), c.committed_at),
                                 COALESCE(${hb.outageEnd}::timestamptz, c.committed_at))
                        + make_interval(secs => ${am.after_seconds})) AS ok
              FROM tickets t CROSS JOIN LATERAL (${tx.unsafe(CURRENT_CALL)}) c
             WHERE t.id = ${ticket.id}`;
          if (!due?.ok) throw new SystemTransitionSkipped('not_due_or_recalled');
          return ['auto_miss_due'];
        },
      });
      if (outcome.disposition === 'committed') missed += 1;
      else skipped += 1;
    } catch (err) {
      // A skip, a coordinator fence or a lost race leaves nothing behind; the next pass re-checks
      if (
        err instanceof SystemTransitionSkipped ||
        (err instanceof ApiProblem && (err.status === 409 || err.status === 404))
      ) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  await db`
    UPDATE auto_miss_sweeps
       SET last_pass_at = GREATEST(last_pass_at, NOW() + make_interval(secs => ${offset}))
     WHERE id`;
  if (missed > 0) log.info({ missed, skipped }, 'automatic no-show sweep');
  return { candidates: candidates.length, missed, skipped, outageDetected: hb.detected };
}

/** Run the sweep every `intervalSeconds` in this process (first pass at start-up). */
export function startAutoMissSweeper(
  db: Db,
  log: FastifyBaseLogger,
  intervalSeconds: number,
): () => void {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return; // never overlap passes in one process
    running = true;
    try {
      await runAutoMissSweep(db, log, { intervalSeconds });
    } catch (err) {
      log.warn({ err }, 'automatic no-show sweep failed; retrying next interval');
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
