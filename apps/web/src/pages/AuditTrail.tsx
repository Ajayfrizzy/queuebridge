import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditEvent, AuditPage, AuditVerification } from '@queuebridge/contracts';
import { useAnnounce } from '../components/Announcer.js';
import { reasonLabel } from '../components/FairnessControls.js';
import { RecoveryActivity } from '../components/RecoveryActivity.js';
import { Loading } from '../components/Form.js';
import { api, apiUrl, ApiRequestError } from '../lib/api.js';
import { classLabel } from '../lib/policy.js';

const PAGE = 50;

const EVENT_LABEL: Record<string, string> = {
  'queue.open': 'Queue opened',
  'queue.pause': 'Queue paused',
  'queue.close': 'Queue closed',
  'ticket.create': 'Ticket issued',
  'ticket.call_next': 'Called (published order)',
  'ticket.call_specific': 'Called out of order (supervisor)',
  'ticket.serve': 'Service started',
  'ticket.complete': 'Completed',
  'ticket.miss': 'Missed',
  'ticket.pause': 'Put on hold',
  'ticket.resume': 'Returned to queue',
  'ticket.cancel': 'Cancelled',
  'ticket.transfer': 'Transferred to another service',
  'ticket.counter_transfer': 'Sent to another counter',
  'ticket.release': 'Returned to the front (counter out of service)',
  'ticket.priority_override': 'Priority changed (supervisor)',
  'policy.changed': 'Ordering policy changed',
};

/** Verification outcome as text + symbol (never colour alone). "Incomplete" is not success. */
const STATUS_TEXT: Record<
  AuditVerification['status'],
  { symbol: string; title: string; cls: string }
> = {
  verified: {
    symbol: '✓',
    title: 'Verified — no check failed (anything not covered is listed below)',
    cls: 'alert-success',
  },
  failed: { symbol: '✗', title: 'Failed — the record does not check out', cls: 'alert-error' },
  incomplete: {
    symbol: '!',
    title: 'Incomplete — some checks could not run; this is NOT a successful audit',
    cls: 'alert-warn',
  },
};

/**
 * MQ.5 U4: who acted. Staff are named; an event without a staff actor records its kind in the
 * hash-chained payload (`actor_kind`, e.g. `system` for the automatic no-show).
 */
export function actorLabel(e: Pick<AuditEvent, 'actor_id' | 'actor_name' | 'payload'>): string {
  if (e.actor_name) return e.actor_name;
  if (e.actor_id) return 'Staff';
  const kind = e.payload['actor_kind'];
  if (kind === 'system') return 'System (automatic)';
  if (kind === 'visitor') return 'Visitor';
  return 'Visitor / system';
}
/** Plain labels for reasons recorded by the system itself */
const SYSTEM_REASON: Record<string, string> = {
  call_window_elapsed: 'call window elapsed (automatic no-show)',
};
function detailOf(e: AuditEvent): string {
  const p = e.payload;
  const parts: string[] = [];
  if (typeof p['public_code'] === 'string') parts.push(p['public_code']);
  if (e.override) {
    parts.push(`reason: ${reasonLabel(e.override.reason_code)}`);
    if (e.override.reason_text) parts.push(`“${e.override.reason_text}”`);
    parts.push(`policy ${e.override.policy_version}`);
  }
  if (e.event_type === 'ticket.priority_override') {
    const from = p['from_class'];
    const to = p['to_class'];
    if (typeof from === 'string' && typeof to === 'string') {
      parts.push(`${classLabel(from)} → ${classLabel(to)}`);
    }
  }
  const override = p['override'] as { would_have_called_code?: unknown } | undefined;
  if (typeof override?.would_have_called_code === 'string') {
    parts.push(`published order would have called ${override.would_have_called_code}`);
  }
  if (e.event_type === 'ticket.release' && typeof p['reason_code'] === 'string') {
    const r = p['reason_code'];
    parts.push(
      r === 'counter_deactivated'
        ? 'counter deactivated by an administrator'
        : r.startsWith('counter_closed:')
          ? `counter closed (${reasonLabel(r.slice('counter_closed:'.length))})`
          : r,
    );
  }
  if (e.event_type === 'ticket.miss' && typeof p['reason_code'] === 'string') {
    parts.push(`reason: ${SYSTEM_REASON[p['reason_code']] ?? p['reason_code']}`);
  }
  if (e.event_type === 'policy.changed' && typeof p['to_version'] === 'string') {
    parts.push(`now ${p['to_version']}`);
  }
  return parts.join(' · ');
}

/**
 * Read-only audit trail for one queue session (F8): the immutable event sequence, a redacted
 * export, and an integrity check whose result is always stated plainly — a failed or incomplete
 * verification is never presented as success.
 */
export function AuditTrail(): ReactElement {
  const { queueId = '' } = useParams();
  const announce = useAnnounce();
  const [page, setPage] = useState<AuditPage | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .audit(queueId, 0, PAGE)
      .then((r) => {
        if (!alive) return;
        setPage(r.audit);
        setEvents(r.audit.events);
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(
            e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error'),
          );
        }
      });
    return (): void => {
      alive = false;
    };
  }, [queueId]);

  useEffect(() => {
    if (verification || verifyError) resultRef.current?.focus();
  }, [verification, verifyError]);

  async function more(): Promise<void> {
    if (page?.next_after_sequence === null || page === null) return;
    setLoadingMore(true);
    try {
      const r = await api.audit(queueId, page.next_after_sequence, PAGE);
      setPage(r.audit);
      setEvents((prev) => [...prev, ...r.audit.events]);
      announce(`Loaded ${r.audit.events.length} more events.`);
    } catch (e) {
      announce(e instanceof ApiRequestError ? e.message : 'Could not load more events.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function verify(): Promise<void> {
    setVerifying(true);
    setVerification(null);
    setVerifyError(null);
    try {
      const r = await api.verifyAudit(queueId);
      setVerification(r.verification);
      announce(STATUS_TEXT[r.verification.status].title);
    } catch (e) {
      // A verification that could not run is reported as such — never as a pass
      const msg = `Verification could not be run: ${
        e instanceof ApiRequestError ? e.message : 'unexpected error'
      }`;
      setVerifyError(msg);
      announce(msg);
    } finally {
      setVerifying(false);
    }
  }

  if (error) {
    return (
      <>
        <h1>Audit trail</h1>
        <p role="alert">
          {error.status === 403
            ? 'Your role cannot view the audit trail for this queue.'
            : error.status === 404
              ? 'This queue does not exist or you do not have access to it.'
              : error.message}
        </p>
      </>
    );
  }
  if (!page) return <Loading what="audit trail" />;
  const v = verification;
  const status = v ? STATUS_TEXT[v.status] : null;

  return (
    <>
      <p>
        <Link to={`/staff/queues/${queueId}`}>← Back to the queue</Link>
      </p>
      <div className="page-head">
        <h1>Audit trail — {page.service_name}</h1>
        <p className="muted">
          {page.operational_date} · {page.last_sequence} events · read-only
        </p>
      </div>

      <dl className="stat-row" aria-label="Override and exception summary">
        <div className="stat">
          <dt>Priority overrides</dt>
          <dd data-testid="summary-priority">{page.summary.priority_overrides}</dd>
        </div>
        <div className="stat">
          <dt>Routing overrides</dt>
          <dd data-testid="summary-routing">{page.summary.routing_overrides}</dd>
        </div>
        <div className="stat">
          <dt>Transfers</dt>
          <dd>{page.summary.transfers}</dd>
        </div>
        <div className="stat">
          <dt>Sync conflicts</dt>
          <dd>{page.summary.sync_conflicts}</dd>
        </div>
      </dl>

      <section aria-labelledby="integrity-heading" className="card">
        <h2 id="integrity-heading" className="card-title">
          Integrity check
        </h2>
        <p className="hint">
          Recomputes the hash chain, checks signed checkpoints and replays each routing decision
          against the policy version it cites. This detects ordinary modification of the record; it
          cannot rule out a rewrite by someone who controls every key and the whole database.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={verifying}
            onClick={() => void verify()}
          >
            {verifying ? 'Checking…' : 'Verify integrity'}
          </button>
          <a
            className="btn btn-secondary"
            href={apiUrl(`/queues/${queueId}/audit/export`)}
            download
          >
            Download redacted export
          </a>
        </div>
        {verifyError ? (
          <div
            ref={resultRef}
            tabIndex={-1}
            role="alert"
            className="alert alert-error"
            data-testid="verify-error"
          >
            {verifyError}
          </div>
        ) : null}
        {v && status ? (
          <div
            ref={resultRef}
            tabIndex={-1}
            className={`alert ${status.cls}`}
            data-testid="verify-result"
            data-status={v.status}
          >
            <p className="alert-title">
              <span aria-hidden="true">{status.symbol} </span>
              <span data-testid="verify-status">{status.title}</span>
            </p>
            {v.problems.length > 0 ? (
              <ul data-testid="verify-problems">
                {v.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <ul className="plain-list">
              <li>
                Hash chain:{' '}
                {v.chain.valid
                  ? 'intact'
                  : `broken at event ${v.chain.broken_at_sequence ?? '?'} (${v.chain.reason ?? ''})`}{' '}
                — {v.chain.events_checked} events checked
              </li>
              <li>
                Signed checkpoints: {v.checkpoints.valid} of {v.checkpoints.total} valid
                {v.checkpoints.unverifiable > 0
                  ? `, ${v.checkpoints.unverifiable} could not be checked`
                  : ''}
                {v.checkpoints.uncheckpointed_events > 0
                  ? ` · ${v.checkpoints.uncheckpointed_events} recent events not yet covered by a checkpoint`
                  : ''}
              </li>
              <li>
                Routing decisions replayed: {v.replay.decisions_verified} match their policy
                {v.replay.decisions_not_replayable > 0
                  ? `, ${v.replay.decisions_not_replayable} recorded before replay data existed`
                  : ''}
                {v.replay.mismatches.length > 0
                  ? `, ${v.replay.mismatches.length} do NOT match`
                  : ''}
              </li>
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="events-heading">
        <h2 id="events-heading">Events</h2>
        <div className="table-scroll" role="region" aria-labelledby="events-heading" tabIndex={0}>
          <table className="data-table" data-testid="audit-events">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">By</th>
                <th scope="col">Details</th>
                <th scope="col">Hash</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.sequence} data-event-type={e.event_type}>
                  <td>{e.sequence}</td>
                  <td>{new Date(e.committed_at).toLocaleTimeString()}</td>
                  <td>{EVENT_LABEL[e.event_type] ?? e.event_type}</td>
                  <td>{actorLabel(e)}</td>
                  <td className="wrap">{detailOf(e)}</td>
                  <td>
                    <code className="mono" title={e.event_hash}>
                      {e.event_hash.slice(0, 12)}…
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {page.next_after_sequence !== null ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loadingMore}
            onClick={() => void more()}
          >
            {loadingMore ? 'Loading…' : 'Load more events'}
          </button>
        ) : (
          <p className="muted">End of the record.</p>
        )}
      </section>

      <RecoveryActivity queueId={queueId} />
    </>
  );
}
