import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUDIT_KEY_FINGERPRINT_LENGTH,
  AUDIT_KEY_FINGERPRINT_MESSAGE,
  type AuditEvent,
  type AuditPage,
  type AuditVerification,
} from '@queuebridge/contracts';
import {
  verifyCheckpoints,
  verifyRoutingDecisions,
  type CheckpointRecord,
  type StoredEvent,
} from '@queuebridge/domain';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { sha256Hex, verifyChain } from './hash.js';
import { policySnapshots } from './policies.js';

/** Maximum events per audit page. */
export const AUDIT_PAGE_MAX = 200;
/** Export / verification read the whole session; sessions are one service for one day. */
export const AUDIT_FULL_MAX = 50_000;

interface EventRow {
  id: string;
  organization_id: string;
  queue_session_id: string;
  sequence: number;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  operation_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
  committed_at: Date;
  o_kind: 'priority' | 'routing' | null;
  o_reason_code: string | null;
  o_reason_text: string | null;
  o_policy_version: string | null;
  o_id: string | null;
  o_actor_id: string | null;
  o_ticket_id: string | null;
  o_from_class: string | null;
  o_to_class: string | null;
  o_counter_id: string | null;
}

interface SessionInfo {
  id: string;
  service_id: string;
  service_name: string;
  operational_date: string;
  last_sequence: number;
}

async function sessionInfo(
  db: Db,
  organizationId: string,
  queueId: string,
): Promise<SessionInfo | null> {
  const rows = await db<SessionInfo[]>`
    SELECT qs.id, qs.service_id, s.name AS service_name,
           to_char(qs.operational_date, 'YYYY-MM-DD') AS operational_date, qs.last_sequence
      FROM queue_sessions qs JOIN services s ON s.id = qs.service_id
     WHERE qs.id = ${queueId} AND qs.organization_id = ${organizationId}`;
  return rows[0] ?? null;
}

async function loadEvents(
  db: Db,
  organizationId: string,
  queueId: string,
  afterSequence: number,
  limit: number,
): Promise<EventRow[]> {
  return db<EventRow[]>`
    SELECT e.id, e.organization_id, e.queue_session_id, e.sequence, e.event_type, e.actor_id,
           u.display_name AS actor_name, e.operation_id, e.payload, e.prev_hash, e.event_hash,
           e.committed_at, o.kind AS o_kind, o.reason_code AS o_reason_code,
           o.reason_text AS o_reason_text, o.policy_version AS o_policy_version,
           o.id AS o_id, o.actor_id AS o_actor_id, o.ticket_id AS o_ticket_id,
           o.from_class AS o_from_class, o.to_class AS o_to_class, o.counter_id AS o_counter_id
      FROM queue_events e
      LEFT JOIN staff_users u ON u.id = e.actor_id
      LEFT JOIN priority_overrides o ON o.queue_event_id = e.id
     WHERE e.queue_session_id = ${queueId} AND e.organization_id = ${organizationId}
       AND e.sequence > ${afterSequence}
     ORDER BY e.sequence
     LIMIT ${limit}`;
}

function toAuditEvent(r: EventRow, redact: boolean): AuditEvent {
  return {
    sequence: r.sequence,
    event_type: r.event_type,
    committed_at: r.committed_at.toISOString(),
    actor_id: r.actor_id,
    // REQ-F8.6: exports replace personal data (staff names, free text) with reference ids/hashes
    actor_name: redact ? null : r.actor_name,
    payload: r.payload,
    prev_hash: r.prev_hash,
    event_hash: r.event_hash,
    override:
      r.o_kind && r.o_reason_code && r.o_reason_text !== null && r.o_policy_version
        ? {
            kind: r.o_kind,
            reason_code: r.o_reason_code,
            reason_text: redact ? null : r.o_reason_text,
            reason_text_sha256: sha256Hex(r.o_reason_text),
            policy_version: r.o_policy_version,
          }
        : null,
  };
}

async function summary(
  db: Db,
  organizationId: string,
  queueId: string,
): Promise<AuditPage['summary']> {
  const rows = await db<{ event_type: string; n: number }[]>`
    SELECT event_type, COUNT(*)::int AS n FROM queue_events
     WHERE queue_session_id = ${queueId} AND organization_id = ${organizationId}
       AND event_type IN ('ticket.priority_override', 'ticket.call_specific', 'ticket.transfer',
                          'ticket.counter_transfer', 'sync.conflict_detected')
     GROUP BY event_type`;
  const n = (t: string): number => rows.find((r) => r.event_type === t)?.n ?? 0;
  return {
    priority_overrides: n('ticket.priority_override'),
    routing_overrides: n('ticket.call_specific'),
    transfers: n('ticket.transfer') + n('ticket.counter_transfer'),
    sync_conflicts: n('sync.conflict_detected'),
  };
}

/** Paginated, read-only, tenant-scoped audit view (REQ-F8.5). Callers authorize first. */
export async function auditPage(
  db: Db,
  organizationId: string,
  queueId: string,
  afterSequence: number,
  limit: number,
): Promise<AuditPage | null> {
  const s = await sessionInfo(db, organizationId, queueId);
  if (!s) return null;
  const size = Math.min(Math.max(1, limit), AUDIT_PAGE_MAX);
  const rows = await loadEvents(db, organizationId, queueId, afterSequence, size + 1);
  const page = rows.slice(0, size);
  return {
    queue_id: s.id,
    service_name: s.service_name,
    operational_date: s.operational_date,
    last_sequence: s.last_sequence,
    events: page.map((r) => toAuditEvent(r, false)),
    next_after_sequence: rows.length > size ? (page[page.length - 1]?.sequence ?? null) : null,
    summary: await summary(db, organizationId, queueId),
  };
}

/** Redacted export (REQ-F8.6): no staff names, no free-text explanations (hash only). */
export interface AuditExport {
  queue_id: string;
  service_name: string;
  operational_date: string;
  exported_at: string;
  redacted: true;
  /** The session's recorded head when exported: `event_count` must equal it for a whole record */
  last_sequence: number;
  event_count: number;
  head_hash: string | null;
  events: AuditEvent[];
}

/**
 * Redacted export of a whole session — ALL of it or nothing: a session larger than `maxEvents`
 * is refused (`too_large`) instead of returning a silently truncated file. Read in one snapshot,
 * so `event_count`, `last_sequence` and `head_hash` describe the same moment.
 */
export async function auditExport(
  db: Db,
  organizationId: string,
  queueId: string,
  maxEvents: number = AUDIT_FULL_MAX,
): Promise<AuditExport | { too_large: true; last_sequence: number; max_events: number } | null> {
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const s = await sessionInfo(tx, organizationId, queueId);
    if (!s) return null;
    const tooLarge = {
      too_large: true as const,
      last_sequence: s.last_sequence,
      max_events: maxEvents,
    };
    if (s.last_sequence > maxEvents) return tooLarge;
    // one extra row detects an over-long log even if `last_sequence` understates it
    const rows = await loadEvents(tx, organizationId, queueId, 0, maxEvents + 1);
    if (rows.length > maxEvents) return tooLarge;
    return {
      queue_id: s.id,
      service_name: s.service_name,
      operational_date: s.operational_date,
      exported_at: new Date().toISOString(),
      redacted: true as const,
      last_sequence: s.last_sequence,
      event_count: rows.length,
      head_hash: rows[rows.length - 1]?.event_hash ?? null,
      events: rows.map((r) => toAuditEvent(r, true)),
    };
  });
}

/** HMAC-SHA256 over the checkpoint message. The worker signs with the same construction. */
/**
 * Non-reversible identifier of the configured key (64 bits of an HMAC): logged at startup by the
 * API and the worker so an operator can confirm both hold the same key without seeing it.
 */
export function auditKeyFingerprint(key: string): string {
  return signCheckpoint(key, AUDIT_KEY_FINGERPRINT_MESSAGE).slice(0, AUDIT_KEY_FINGERPRINT_LENGTH);
}

export function signCheckpoint(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * Full integrity verification of one queue session (REQ-F8.7). Never reports success if any
 * check failed (`failed`) or a checkpoint signature could not be checked (`incomplete`). Events
 * after the last signed checkpoint and pre-M4 calls without routing data cannot be covered by
 * those checks; they are reported as counts (`uncheckpointed_events`, `decisions_not_replayable`)
 * alongside a `verified` result, never silently.
 */
export async function verifyAudit(
  db: Db,
  env: Env,
  organizationId: string,
  queueId: string,
): Promise<AuditVerification | null> {
  // ONE consistent snapshot for every read (session head, events, override records, policy
  // snapshots, checkpoints, alerts): commands or checkpoints committing meanwhile must not make
  // a healthy queue look broken (e.g. "records 8 events but 9 are present")
  return db.begin('isolation level repeatable read read only', (tx) =>
    verifyInSnapshot(tx, env, organizationId, queueId),
  );
}

async function verifyInSnapshot(
  db: Db,
  env: Env,
  organizationId: string,
  queueId: string,
): Promise<AuditVerification | null> {
  const s = await sessionInfo(db, organizationId, queueId);
  if (!s) return null;
  const problemsFound: string[] = [];
  const rows = await loadEvents(db, organizationId, queueId, 0, AUDIT_FULL_MAX);
  const events: StoredEvent[] = rows.map((r) => ({
    organization_id: r.organization_id,
    queue_session_id: r.queue_session_id,
    sequence: r.sequence,
    event_type: r.event_type,
    actor_id: r.actor_id,
    operation_id: r.operation_id,
    payload: r.payload,
    prev_hash: r.prev_hash,
    event_hash: r.event_hash,
    committed_at: r.committed_at.toISOString(),
  }));

  // 1. Hash chain from genesis, and the session's recorded head must match the log
  const chain = verifyChain(events);
  if (!chain.valid)
    problemsFound.push(`Hash chain broken at event ${chain.broken_at_sequence}: ${chain.reason}.`);
  if (rows.length >= AUDIT_FULL_MAX)
    problemsFound.push('Session too large to verify in one request.');
  if (chain.valid && events.length !== s.last_sequence) {
    problemsFound.push(
      `The session records ${s.last_sequence} events but ${events.length} are present.`,
    );
  }

  // 2. Checkpoints: roots, head links and signatures
  const cps = await db<CheckpointRecord[]>`
    SELECT from_sequence, to_sequence, root_hash, head_hash, key_id, signature
      FROM audit_checkpoints WHERE queue_session_id = ${queueId} ORDER BY from_sequence`;
  const key = env.AUDIT_SIGNING_KEY;
  const keyId = env.AUDIT_SIGNING_KEY_ID;
  const cpResult = verifyCheckpoints(sha256Hex, events, cps, queueId, (message, c) => {
    if (!key || !keyId || c.key_id !== keyId) return null;
    const expected = Buffer.from(signCheckpoint(key, message), 'hex');
    const given = Buffer.from(c.signature, /^[0-9a-f]+$/i.test(c.signature) ? 'hex' : 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  const invalid = cpResult.results
    .filter((r): r is typeof r & { status: 'invalid'; reason: string } => r.status === 'invalid')
    .map((r) => ({ from_sequence: r.from_sequence, to_sequence: r.to_sequence, reason: r.reason }));
  const unverifiable = cpResult.results.filter((r) => r.status === 'unverifiable').length;
  for (const i of invalid) {
    problemsFound.push(`Checkpoint ${i.from_sequence}–${i.to_sequence} is invalid: ${i.reason}.`);
  }

  // 3. Override records must match what the chained events sealed: the record is mutable only by
  //    someone bypassing the append-only triggers, so EVERY field it shows is compared with the
  //    sealed event (free text by its in-chain SHA-256)
  for (const r of rows) {
    const nested = (r.payload['override'] ?? {}) as Record<string, unknown>;
    const sealed = (key: string): unknown => r.payload[key] ?? nested[key];
    const overrideId = sealed('override_id');
    if (overrideId === undefined) continue;
    if (r.o_id === null || r.o_reason_text === null) {
      problemsFound.push(`Event ${r.sequence} cites an override record that is missing.`);
      continue;
    }
    const mismatched: string[] = [];
    if (r.o_id !== overrideId) mismatched.push('record id');
    if (sha256Hex(r.o_reason_text) !== sealed('reason_text_sha256')) mismatched.push('explanation');
    if (r.o_reason_code !== sealed('reason_code')) mismatched.push('reason code');
    if (r.o_actor_id !== r.actor_id) mismatched.push('actor');
    if (r.o_ticket_id !== r.payload['ticket_id']) mismatched.push('ticket');
    if (r.o_policy_version !== r.payload['policy_version']) mismatched.push('policy version');
    const expectedKind = r.event_type === 'ticket.priority_override' ? 'priority' : 'routing';
    if (r.o_kind !== expectedKind) mismatched.push('kind');
    if (expectedKind === 'priority') {
      if (r.o_from_class !== r.payload['from_class']) mismatched.push('original class');
      if (r.o_to_class !== r.payload['to_class']) mismatched.push('resulting class');
    } else if (r.o_counter_id !== r.payload['counter_id']) {
      mismatched.push('counter');
    }
    if (mismatched.length > 0) {
      problemsFound.push(
        mismatched.includes('explanation') && mismatched.length === 1
          ? `The explanation stored for event ${r.sequence} does not match the one sealed in the chain.`
          : `The override record for event ${r.sequence} does not match the one sealed in the chain (${mismatched.join(', ')}).`,
      );
    }
  }

  // 4. Routing decisions replayed against the policy snapshots they cite
  const snapshots = await policySnapshots(db, organizationId, s.service_id);
  const replay = verifyRoutingDecisions(events, snapshots);
  if (!replay.valid) {
    problemsFound.push(
      replay.error
        ? `The event log is not a legal history: ${replay.error}.`
        : `${replay.mismatches.length} routing decision(s) do not match their published policy.`,
    );
  }

  // 5. Alerts raised by the worker are never silently dropped
  const alerts = await db<
    { kind: string; at_sequence: number | null; reason: string; detected_at: Date }[]
  >`
    SELECT kind, at_sequence, reason, detected_at FROM audit_integrity_alerts
     WHERE queue_session_id = ${queueId} AND organization_id = ${organizationId}
     ORDER BY detected_at`;
  for (const a of alerts) problemsFound.push(`Integrity alert (${a.kind}): ${a.reason}.`);

  const failed = problemsFound.length > 0;
  if (!failed && unverifiable > 0) {
    problemsFound.push(
      `${unverifiable} checkpoint(s) could not be checked: signing key not available here.`,
    );
  }
  const status = failed ? 'failed' : unverifiable > 0 ? 'incomplete' : 'verified';

  return {
    queue_id: queueId,
    status,
    verified_at: new Date().toISOString(),
    chain: chain.valid
      ? {
          valid: true,
          events_checked: chain.checked,
          head_hash: chain.head_hash,
          broken_at_sequence: null,
          reason: null,
        }
      : {
          valid: false,
          events_checked: chain.checked,
          head_hash: null,
          broken_at_sequence: chain.broken_at_sequence,
          reason: chain.reason,
        },
    checkpoints: {
      total: cps.length,
      valid: cpResult.results.filter((r) => r.status === 'valid').length,
      invalid,
      unverifiable,
      covered_to_sequence: cpResult.covered_to,
      uncheckpointed_events: Math.max(0, events.length - cpResult.covered_to),
    },
    replay: {
      valid: replay.valid,
      decisions_verified: replay.verified,
      decisions_not_replayable: replay.not_replayable,
      mismatches: replay.mismatches,
      error: replay.error,
    },
    alerts: alerts.map((a) => ({ ...a, detected_at: a.detected_at.toISOString() })),
    problems: problemsFound,
  };
}
