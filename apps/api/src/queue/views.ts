import {
  QueueSessionState,
  TicketState,
  type Board,
  type FacilityQueueSummary,
  type PriorityClass,
  type PublicFacility,
  type ServicePolicy,
  type StaffQueue,
  type TicketStatus,
} from '@queuebridge/contracts';
import {
  DEFAULT_OVERRIDE_REASONS,
  recoveryPolicyOf,
  type TicketRecoveryInfo,
} from '@queuebridge/contracts';
import { describeOrderingPolicy, orderWaiting, ticketsAhead } from '@queuebridge/domain';
import { hashToken } from '../auth/tokens.js';
import type { Db } from '../db.js';
import { recoveryPath } from '../recovery/credentials.js';
import { loadEstimate } from './estimate.js';

interface SessionRow {
  id: string;
  organization_id: string;
  facility_id: string;
  service_id: string;
  service_name: string;
  service_status: 'active' | 'inactive';
  description: string | null;
  policy: ServicePolicy;
  state: QueueSessionState;
  revision: number;
  last_sequence: number;
  operational_date: string;
}

interface TicketLite {
  id: string;
  public_code: string;
  state: TicketState;
  priority_class: PriorityClass;
  issued_sequence: number;
  wait_since: Date;
}

const sessionColumns = (db: Db): ReturnType<Db['unsafe']> =>
  db.unsafe(`qs.id, qs.organization_id, qs.facility_id, qs.service_id, s.name AS service_name,
             s.status AS service_status, s.description, s.policy, qs.state, qs.revision,
             qs.last_sequence, to_char(qs.operational_date, 'YYYY-MM-DD') AS operational_date`);

async function waitingTickets(db: Db, sessionId: string): Promise<TicketLite[]> {
  return db<TicketLite[]>`
    SELECT id, public_code, state, priority_class, issued_sequence, wait_since
      FROM tickets WHERE queue_session_id = ${sessionId} AND state = 'waiting'`;
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/** Today's queue for every service of a facility (callers authorize first). */
export async function facilityQueueSummaries(
  db: Db,
  organizationId: string,
  facilityId: string,
): Promise<FacilityQueueSummary[]> {
  return db<FacilityQueueSummary[]>`
    SELECT s.id AS service_id, s.name AS service_name, s.status AS service_status,
           qs.id AS queue_id, qs.state,
           COALESCE((SELECT COUNT(*)::int FROM tickets t
                      WHERE t.queue_session_id = qs.id AND t.state = 'waiting'), 0) AS waiting_count,
           to_char((NOW() AT TIME ZONE f.timezone)::date, 'YYYY-MM-DD') AS operational_date
      FROM services s
      JOIN facilities f ON f.id = s.facility_id
      LEFT JOIN queue_sessions qs ON qs.service_id = s.id AND qs.organization_id = s.organization_id
                                 AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date
     WHERE s.organization_id = ${organizationId} AND s.facility_id = ${facilityId}
     ORDER BY s.created_at, s.name`;
}

/** Resolve a queue session's facility within an organization (null → 404 for the caller). */
export async function queueFacility(
  db: Db,
  organizationId: string,
  queueId: string,
): Promise<string | null> {
  const rows = await db<{ facility_id: string }[]>`
    SELECT facility_id FROM queue_sessions WHERE id = ${queueId} AND organization_id = ${organizationId}`;
  return rows[0]?.facility_id ?? null;
}

export async function staffQueueView(
  db: Db,
  organizationId: string,
  queueId: string,
): Promise<StaffQueue | null> {
  const sessions = await db<SessionRow[]>`
    SELECT ${sessionColumns(db)}
      FROM queue_sessions qs JOIN services s ON s.id = qs.service_id
     WHERE qs.id = ${queueId} AND qs.organization_id = ${organizationId}`;
  const session = sessions[0];
  if (!session) return null;

  const tickets = await db<
    (TicketLite & {
      counter_id: string | null;
      counter_name: string | null;
      channel: 'web' | 'staff' | 'transfer';
      joined_at: Date;
      called_at: Date | null;
      transferred_from_code: string | null;
      updated_at: Date;
    })[]
  >`
    SELECT t.id, t.public_code, t.state, t.priority_class, t.issued_sequence, t.wait_since,
           t.current_counter_id AS counter_id, c.name AS counter_name, t.created_channel AS channel,
           t.joined_at, t.called_at, src.public_code AS transferred_from_code, t.updated_at
      FROM tickets t
      LEFT JOIN counters c ON c.id = t.current_counter_id
      LEFT JOIN tickets src ON src.id = t.transferred_from_ticket_id
     WHERE t.queue_session_id = ${session.id}
     ORDER BY t.issued_sequence`;

  const order = session.policy.priority_order;
  const waitingOrder = orderWaiting(tickets, order);
  const positionById = new Map(waitingOrder.map((t, i) => [t.id, i]));
  const active = tickets.filter(
    (t) =>
      t.state !== TicketState.COMPLETED &&
      t.state !== TicketState.CANCELLED &&
      t.state !== TicketState.TRANSFERRED,
  );
  const finished = tickets
    .filter((t) => !active.includes(t))
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
    .slice(0, 10);

  const counters = await db<
    {
      id: string;
      name: string;
      active: boolean;
      availability: 'open' | 'closed';
      busy_with_code: string | null;
    }[]
  >`
    SELECT c.id, c.name, c.active, c.availability,
           (SELECT t.public_code FROM tickets t
             WHERE t.current_counter_id = c.id AND t.state IN ('called', 'serving') LIMIT 1) AS busy_with_code
      FROM counters c
      JOIN counter_service_capabilities csc ON csc.counter_id = c.id AND csc.service_id = ${session.service_id}
     WHERE c.organization_id = ${organizationId} AND c.facility_id = ${session.facility_id}
     ORDER BY c.created_at, c.name`;

  const transferTargets = await db<{ service_id: string; service_name: string }[]>`
    SELECT s.id AS service_id, s.name AS service_name
      FROM services s
      JOIN facilities f ON f.id = s.facility_id
      JOIN queue_sessions qs ON qs.service_id = s.id
                            AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date
                            AND qs.state = 'open'
     WHERE s.organization_id = ${organizationId} AND s.facility_id = ${session.facility_id}
       AND s.status = 'active' AND s.id <> ${session.service_id}
     ORDER BY s.name`;

  const estimate = await loadEstimate(db, {
    organizationId,
    facilityId: session.facility_id,
    serviceId: session.service_id,
    position: waitingOrder.length,
    queueState: session.state,
  });

  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
  const toStaff = (t: (typeof tickets)[number]): StaffQueue['tickets'][number] => ({
    id: t.id,
    public_code: t.public_code,
    state: t.state,
    priority_class: t.priority_class,
    issued_sequence: t.issued_sequence,
    position: positionById.get(t.id) ?? null,
    counter_id: t.counter_id,
    counter_name: t.counter_name,
    channel: t.channel,
    joined_at: t.joined_at.toISOString(),
    wait_since: t.wait_since.toISOString(),
    called_at: iso(t.called_at),
    transferred_from_code: t.transferred_from_code,
  });

  return {
    id: session.id,
    facility_id: session.facility_id,
    service_id: session.service_id,
    service_name: session.service_name,
    operational_date: session.operational_date,
    state: session.state,
    revision: session.revision,
    last_sequence: session.last_sequence,
    policy_summary: describeOrderingPolicy(session.policy),
    tickets: [...active, ...finished].map(toStaff),
    counters,
    policy: {
      version: session.policy.version,
      priority_order: session.policy.priority_order,
      override_reasons: session.policy.override_reasons ?? [...DEFAULT_OVERRIDE_REASONS],
      transfer_placement: session.policy.transfer_placement ?? 'end_of_queue',
    },
    no_open_counter: !counters.some((c) => c.active && c.availability === 'open'),
    transfer_targets: transferTargets,
    estimate_for_new_visitor: session.state === QueueSessionState.CLOSED ? null : estimate,
  };
}

// ---------------------------------------------------------------------------
// Public (no internal ticket/staff/counter ids, no personal data)
// ---------------------------------------------------------------------------

interface PublicFacilityRow {
  id: string;
  organization_id: string;
  name: string;
  organization_name: string;
}

export async function findPublicFacility(
  db: Db,
  orgSlug: string,
  facilitySlug: string,
): Promise<PublicFacilityRow | null> {
  const rows = await db<PublicFacilityRow[]>`
    SELECT f.id, f.organization_id, f.name, o.name AS organization_name
      FROM facilities f JOIN organizations o ON o.id = f.organization_id
     WHERE o.slug = ${orgSlug} AND f.slug = ${facilitySlug} AND f.status = 'active'`;
  return rows[0] ?? null;
}

async function todaysSessions(db: Db, f: PublicFacilityRow): Promise<SessionRow[]> {
  return db<SessionRow[]>`
    SELECT ${sessionColumns(db)}
      FROM queue_sessions qs
      JOIN services s ON s.id = qs.service_id
      JOIN facilities fa ON fa.id = qs.facility_id
     WHERE qs.organization_id = ${f.organization_id} AND qs.facility_id = ${f.id}
       AND qs.operational_date = (NOW() AT TIME ZONE fa.timezone)::date
       AND s.status = 'active' AND qs.state <> 'closed'
     ORDER BY s.created_at, s.name`;
}

export async function publicFacilityView(db: Db, f: PublicFacilityRow): Promise<PublicFacility> {
  const sessions = await todaysSessions(db, f);
  const queues = await Promise.all(
    sessions.map(async (s) => {
      const waiting = await waitingTickets(db, s.id);
      return {
        queue_id: s.id,
        service_name: s.service_name,
        description: s.description,
        state: s.state,
        waiting_count: waiting.length,
        policy_summary: describeOrderingPolicy(s.policy),
        estimate: await loadEstimate(db, {
          organizationId: f.organization_id,
          facilityId: f.id,
          serviceId: s.service_id,
          position: waiting.length,
          queueState: s.state,
        }),
        accepting_visitors: s.state === QueueSessionState.OPEN,
      };
    }),
  );
  return { organization_name: f.organization_name, facility_name: f.name, queues };
}

export const BOARD_NOW_CALLING_LIMIT = 8;
export const BOARD_NEXT_LIMIT = 5;

/** Display-board projection: ticket codes and counter names only. */
export async function boardView(db: Db, f: PublicFacilityRow): Promise<Board> {
  const sessions = await todaysSessions(db, f);
  const services = await Promise.all(
    sessions.map(async (s) => {
      const calling = await db<
        { public_code: string; counter_name: string; state: 'called' | 'serving' }[]
      >`
        SELECT t.public_code, c.name AS counter_name, t.state
          FROM tickets t JOIN counters c ON c.id = t.current_counter_id
         WHERE t.queue_session_id = ${s.id} AND t.state IN ('called', 'serving')
         ORDER BY t.called_at DESC NULLS LAST
         LIMIT ${BOARD_NOW_CALLING_LIMIT}`;
      const waiting = orderWaiting(await waitingTickets(db, s.id), s.policy.priority_order);
      return {
        service_name: s.service_name,
        state: s.state,
        now_calling: calling,
        next_codes: waiting.slice(0, BOARD_NEXT_LIMIT).map((t) => t.public_code),
        waiting_count: waiting.length,
      };
    }),
  );
  return { facility_name: f.name, updated_at: new Date().toISOString(), services };
}

// ---------------------------------------------------------------------------
// Visitor ticket status (token-protected)
// ---------------------------------------------------------------------------

interface ResolvedTicket {
  id: string;
  organization_id: string;
  queue_session_id: string;
  public_code: string;
  state: TicketState;
  current_counter_id: string | null;
  transferred_to_ticket_id: string | null;
  joined_at: Date;
  updated_at: Date;
}

export interface ResolvedStatusTicket {
  ticket: ResolvedTicket;
  originalCode: string;
  codes: string[];
  facilityId: string;
  /** The ticket the credentials belong to (the one created at join; transfers follow it) */
  rootTicketId: string;
  /** The status token used for this request (row id; never the secret) */
  tokenId: string;
  tokenCreatedAt: Date;
}

/**
 * Resolve a status token to the visitor's CURRENT ticket (following transfers, at most 10 hops).
 * Returns null for unknown/expired tokens or when `publicCode` is not part of this chain — callers
 * must answer every such case with the same 404.
 */
export async function resolveStatusToken(
  db: Db,
  token: string,
  publicCode: string,
): Promise<ResolvedStatusTicket | null> {
  const cols = db.unsafe(`t.id, t.organization_id, t.queue_session_id, t.public_code, t.state,
    t.current_counter_id, t.transferred_to_ticket_id, t.joined_at, t.updated_at`);
  // M5.1: a revoked token (signed out elsewhere, replaced at the cap, staff revoke-all, join
  // replay) is as dead as an expired one
  const root = await db<
    (ResolvedTicket & { facility_id: string; token_id: string; token_created_at: Date })[]
  >`
    SELECT ${cols}, qs.facility_id, trc.id AS token_id, trc.created_at AS token_created_at
      FROM ticket_recovery_credentials trc
      JOIN tickets t ON t.id = trc.ticket_id
      JOIN queue_sessions qs ON qs.id = t.queue_session_id
     WHERE trc.credential_hash = ${hashToken(token)} AND trc.expires_at > NOW()
       AND trc.revoked_at IS NULL`;
  type Row = ResolvedTicket & { facility_id: string };
  const head = root[0];
  if (!head) return null;
  const first: Row = head;
  // Housekeeping only (at most one write per token per minute); never blocks the read
  void db`
    UPDATE ticket_recovery_credentials SET last_used_at = NOW()
     WHERE id = ${head.token_id}
       AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`.catch(
    () => undefined,
  );
  let current: Row = first;
  const originalCode = current.public_code;
  const codes = [current.public_code];
  for (let hop = 0; hop < 10 && current.transferred_to_ticket_id; hop++) {
    const nextRows: Row[] = await db<Row[]>`
      SELECT ${cols}, qs.facility_id FROM tickets t JOIN queue_sessions qs ON qs.id = t.queue_session_id
       WHERE t.id = ${current.transferred_to_ticket_id} AND t.organization_id = ${current.organization_id}`;
    const nextRow = nextRows[0];
    if (!nextRow) break;
    current = nextRow;
    codes.push(current.public_code);
  }
  if (!codes.includes(publicCode)) return null;
  return {
    ticket: current,
    originalCode,
    codes,
    facilityId: current.facility_id,
    rootTicketId: first.id,
    tokenId: head.token_id,
    tokenCreatedAt: head.token_created_at,
  };
}

function statusMessage(
  state: TicketState,
  position: number | null,
  counter: string | null,
  queueState: QueueSessionState,
): string {
  switch (state) {
    case TicketState.WAITING:
      if (queueState === QueueSessionState.PAUSED) {
        return 'You are in the queue. Calling is paused for now and will resume when staff reopen it.';
      }
      return position === 0
        ? 'You are next in line. Please stay nearby.'
        : `You are in the queue. ${position} ${position === 1 ? 'ticket is' : 'tickets are'} ahead of you.`;
    case TicketState.CALLED:
      return `It is your turn. Please go to ${counter ?? 'the counter'} now.`;
    case TicketState.SERVING:
      return `You are being served at ${counter ?? 'the counter'}.`;
    case TicketState.PAUSED:
      return 'Your ticket is on hold. Please speak to a member of staff.';
    case TicketState.MISSED:
      return 'Your ticket was called but you were not there. Please speak to a member of staff as soon as possible.';
    case TicketState.COMPLETED:
      return 'Your visit is complete. Thank you.';
    case TicketState.CANCELLED:
      return 'This ticket was cancelled. Please speak to a member of staff if this is unexpected.';
    default:
      return 'Please speak to a member of staff.';
  }
}

/** M5.1 recovery, rejoin and access facts for the visitor's own ticket (no secret). */
async function recoveryInfo(
  db: Db,
  resolved: ResolvedStatusTicket,
  session: SessionRow,
  recoveryEnabled: boolean,
): Promise<TicketRecoveryInfo> {
  const t = resolved.ticket;
  const rp = recoveryPolicyOf(session.policy);
  const [facts] = await db<
    {
      org_slug: string;
      facility_slug: string;
      grace_ends_at: Date | null;
      grace_open: boolean;
      coordinator: boolean;
      granted_elsewhere: Date | null;
    }[]
  >`
    SELECT o.slug AS org_slug, f.slug AS facility_slug,
           tk.missed_at + make_interval(secs => ${session.policy.grace_window_seconds}) AS grace_ends_at,
           (tk.state = 'missed' AND tk.missed_at IS NOT NULL
             AND NOW() <= tk.missed_at + make_interval(secs => ${session.policy.grace_window_seconds})) AS grace_open,
           (qs.coordinator_device_id IS NOT NULL) AS coordinator,
           (SELECT MAX(c.created_at) FROM ticket_recovery_credentials c
             WHERE c.ticket_id = ${resolved.rootTicketId} AND c.source IN ('recovery', 'staff')
               AND c.id <> ${resolved.tokenId} AND c.created_at > ${resolved.tokenCreatedAt}) AS granted_elsewhere
      FROM tickets tk
      JOIN queue_sessions qs ON qs.id = tk.queue_session_id
      JOIN facilities f ON f.id = qs.facility_id
      JOIN organizations o ON o.id = f.organization_id
     WHERE tk.id = ${t.id} AND tk.organization_id = ${t.organization_id}`;
  return {
    self_service_available: recoveryEnabled,
    recovery_path: recoveryPath(
      facts?.org_slug ?? '',
      facts?.facility_slug ?? '',
      resolved.originalCode,
    ),
    rejoin_available: Boolean(
      t.state === TicketState.MISSED &&
        rp.rejoin_policy === 'self_resume' &&
        facts?.grace_open &&
        !facts.coordinator,
    ),
    grace_ends_at:
      t.state === TicketState.MISSED ? (facts?.grace_ends_at?.toISOString() ?? null) : null,
    auto_miss_after_seconds: rp.auto_miss.enabled ? rp.auto_miss.after_seconds : null,
    access_granted_elsewhere_at: facts?.granted_elsewhere?.toISOString() ?? null,
  };
}

export async function ticketStatusView(
  db: Db,
  resolved: ResolvedStatusTicket,
  opts: { recoveryEnabled: boolean } = { recoveryEnabled: false },
): Promise<TicketStatus> {
  const t = resolved.ticket;
  const sessions = await db<(SessionRow & { facility_name: string })[]>`
    SELECT ${sessionColumns(db)}, f.name AS facility_name
      FROM queue_sessions qs JOIN services s ON s.id = qs.service_id JOIN facilities f ON f.id = qs.facility_id
     WHERE qs.id = ${t.queue_session_id} AND qs.organization_id = ${t.organization_id}`;
  const session = sessions[0];
  if (!session) throw new Error('ticket session missing');

  let position: number | null = null;
  if (t.state === TicketState.WAITING) {
    position = ticketsAhead(
      t.id,
      await waitingTickets(db, session.id),
      session.policy.priority_order,
    );
  }
  let counterName: string | null = null;
  if (t.current_counter_id && (t.state === TicketState.CALLED || t.state === TicketState.SERVING)) {
    const c = await db<
      { name: string }[]
    >`SELECT name FROM counters WHERE id = ${t.current_counter_id}`;
    counterName = c[0]?.name ?? null;
  }
  const estimate =
    t.state === TicketState.WAITING && position !== null
      ? await loadEstimate(db, {
          organizationId: t.organization_id,
          facilityId: session.facility_id,
          serviceId: session.service_id,
          position,
          queueState: session.state,
        })
      : null;

  return {
    public_code: t.public_code,
    facility_name: session.facility_name,
    service_name: session.service_name,
    state: t.state,
    sync_status: 'committed',
    queue_state: session.state,
    position,
    counter_name: counterName,
    joined_at: t.joined_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
    status_message: statusMessage(t.state, position, counterName, session.state),
    policy_summary: describeOrderingPolicy(session.policy),
    estimate,
    transferred_from_code:
      resolved.codes.length > 1 ? (resolved.codes[resolved.codes.length - 2] ?? null) : null,
    revision: session.revision,
    recovery: await recoveryInfo(db, resolved, session, opts.recoveryEnabled),
  };
}
