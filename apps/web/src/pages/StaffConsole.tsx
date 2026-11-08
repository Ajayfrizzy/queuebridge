import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { uuidv7, type QueueCommandRequest, type StaffQueue } from '@queuebridge/contracts';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { Loading, StatusBadge } from '../components/Form.js';
import { api, apiUrl, ApiRequestError } from '../lib/api.js';
import { formatEstimate, formatTime, STATE_LABEL } from '../lib/format.js';
import { useLiveUpdates } from '../lib/live.js';
import {
  COUNTER_ROLES,
  hasFacilityRole,
  QUEUE_MANAGER_ROLES,
  WALK_IN_ROLES,
} from '../lib/permissions.js';
import { buildQr, qrPath, QUIET_ZONE } from '../lib/qr.js';
import { useLoad } from '../lib/useLoad.js';

type Ticket = StaffQueue['tickets'][number];

const TRANSFER_REASONS = [
  ['needs_other_service', 'Needs another service'],
  ['wrong_service', 'Joined the wrong service'],
  ['visitor_request', 'Visitor asked'],
  ['staff_judgement', 'Staff judgement'],
] as const;

const counterKey = (queueId: string): string => `qb.staffCounter.${queueId}`;

/**
 * Staff queue console (M2.3). Every button sends an idempotent, server-authorized command; the
 * screen only shows server-confirmed state and refreshes on live change signals. Controls are
 * hidden when the role cannot use them, but the API enforces every rule independently.
 */
export function StaffConsole(): ReactElement {
  const { queueId = '' } = useParams();
  const { user } = useAuth();
  const announce = useAnnounce();
  const queue = useLoad(() => api.staffQueue(queueId), `queue-${queueId}`);
  const reload = queue.reload;
  const live = useLiveUpdates(
    queue.data ? apiUrl(`/queues/${queueId}/stream`) : null,
    null,
    useCallback(() => void reload(), [reload]),
  );
  const [counterId, setCounterId] = useState<string>(
    () => localStorage.getItem(counterKey(queueId)) ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<{
    message: string;
    retry: QueueCommandRequest | null;
  } | null>(null);
  const [walkIn, setWalkIn] = useState<{ code: string; link: string } | null>(null);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferReason, setTransferReason] = useState<string>('needs_other_service');
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const q = queue.data?.queue;
  useEffect(() => {
    if (!q || counterId) return;
    const first = q.counters.find((c) => c.active);
    if (first) setCounterId(first.id);
  }, [q, counterId]);
  useEffect(() => {
    if (counterId) localStorage.setItem(counterKey(queueId), counterId);
  }, [counterId, queueId]);

  const atCounter: Ticket | undefined = useMemo(
    () =>
      q?.tickets.find(
        (t) => t.counter_id === counterId && (t.state === 'called' || t.state === 'serving'),
      ),
    [q, counterId],
  );

  if (!user || (queue.loading && !q)) return <Loading what="queue" />;
  if (!q) {
    return (
      <>
        <h1>Queue not found</h1>
        <p role="alert">This queue does not exist or you do not have access to it.</p>
      </>
    );
  }
  const fid = q.facility_id;
  const canManage = hasFacilityRole(user, fid, QUEUE_MANAGER_ROLES);
  const canCount = hasFacilityRole(user, fid, COUNTER_ROLES);
  const canWalkIn = hasFacilityRole(user, fid, WALK_IN_ROLES);
  const isSupervisor = hasFacilityRole(user, fid, ['supervisor']);
  const canReturnMissed = hasFacilityRole(user, fid, [
    'staff_reception',
    'staff_counter',
    'supervisor',
  ]);
  const counter = q.counters.find((c) => c.id === counterId);
  const waiting = q.tickets
    .filter((t) => t.state === 'waiting')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const held = q.tickets.filter((t) => t.state === 'paused' || t.state === 'missed');
  const finished = q.tickets.filter((t) =>
    ['completed', 'cancelled', 'transferred'].includes(t.state),
  );

  async function send(
    body: QueueCommandRequest,
    success: (code: string | null) => string,
  ): Promise<void> {
    setBusy(true);
    setLastError(null);
    try {
      const res = await api.command(queueId, body);
      announce(success(res.outcome.public_code));
    } catch (e) {
      const err =
        e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error');
      // Network failure: offer a retry with the SAME operation id (safe: deduplicated server-side)
      setLastError({ message: err.message, retry: err.status === 0 ? body : null });
      announce(err.message);
    } finally {
      setBusy(false);
      await reload();
    }
  }

  const cmd = (
    action: QueueCommandRequest['action'],
    extra: Partial<QueueCommandRequest> = {},
  ): QueueCommandRequest => ({
    operation_id: uuidv7(),
    action,
    ...extra,
  });

  async function issueWalkIn(): Promise<void> {
    setBusy(true);
    setLastError(null);
    const op = uuidv7();
    try {
      const res = await api.walkIn(queueId, op);
      const link = new URL(
        `${res.ticket.status_path}#t=${res.ticket.status_token}`,
        window.location.origin,
      ).toString();
      setWalkIn({ code: res.ticket.public_code, link });
      announce(`Walk-in ticket ${res.ticket.public_code} issued.`);
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : 'Could not issue the ticket.';
      setLastError({ message: msg, retry: null });
      announce(msg);
    } finally {
      setBusy(false);
      await reload();
    }
  }

  const walkInQr = walkIn ? buildQr(walkIn.link) : null;
  const qrTotal = walkInQr ? walkInQr.size + QUIET_ZONE * 2 : 0;

  return (
    <>
      <p>
        <Link to={`/staff/facilities/${fid}`}>← Today&apos;s queues</Link>
      </p>
      <div className="page-head">
        <h1>{q.service_name}</h1>
        <p className="muted">
          {q.operational_date} · {q.policy_summary}
        </p>
      </div>
      <dl className="stat-row" aria-label="Queue status">
        <div className="stat">
          <dt>Queue</dt>
          <dd data-testid="queue-state">
            <StatusBadge
              active={q.state === 'open'}
              on="Open"
              off={STATE_LABEL[q.state] ?? q.state}
            />
          </dd>
        </div>
        <div className="stat">
          <dt>Waiting</dt>
          <dd className="stat-value-lg" data-testid="waiting-count">
            {waiting.length}
          </dd>
        </div>
        <div className="stat">
          <dt>Updates</dt>
          <dd data-testid="live-mode">
            {live === 'live'
              ? 'Live'
              : live === 'polling'
                ? 'Refreshing every 15 s'
                : 'Connecting…'}
          </dd>
        </div>
      </dl>

      {lastError ? (
        <div role="alert" className="alert alert-error" data-testid="command-error">
          <p>{lastError.message}</p>
          {lastError.retry ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send(lastError.retry as QueueCommandRequest, () => 'Done.')}
            >
              Retry (safe — will not repeat the action)
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="split">
        <div className="split-main">
          {canCount ? (
            <section aria-labelledby="counter-heading" className="card">
              <h2 id="counter-heading" className="card-title">
                Your counter
              </h2>
              <div className="field">
                <label htmlFor="counter-select">Counter</label>
                <select
                  id="counter-select"
                  value={counterId}
                  onChange={(e) => setCounterId(e.target.value)}
                >
                  <option value="">Choose a counter…</option>
                  {q.counters.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.active}>
                      {c.name}
                      {!c.active
                        ? ' (inactive)'
                        : c.busy_with_code
                          ? ` (serving ${c.busy_with_code})`
                          : ''}
                    </option>
                  ))}
                </select>
              </div>
              {q.counters.length === 0 ? (
                <p className="hint">
                  No counter is set to serve this service. An administrator can assign one.
                </p>
              ) : null}

              {atCounter ? (
                <div className="current-ticket" data-testid="at-counter">
                  <h3 className="visually-hidden">Ticket at your counter</h3>
                  <div className="current-ticket-head">
                    <p className="ticket-code ticket-code-xl" data-testid="current-code">
                      {atCounter.public_code}
                    </p>
                    <p>
                      <StatusBadge active on={STATE_LABEL[atCounter.state] ?? atCounter.state} />
                      {atCounter.called_at ? (
                        <span className="muted"> · called {formatTime(atCounter.called_at)}</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="btn-row">
                    {atCounter.state === 'called' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() =>
                            void send(
                              cmd('ticket.serve', { ticket_id: atCounter.id }),
                              () => `Serving ${atCounter.public_code}.`,
                            )
                          }
                        >
                          Start serving
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            void send(
                              cmd('ticket.miss', { ticket_id: atCounter.id }),
                              () => `${atCounter.public_code} marked as missed.`,
                            )
                          }
                        >
                          Did not come (missed)
                        </button>
                        {isSupervisor ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() =>
                              void send(
                                cmd('ticket.resume', { ticket_id: atCounter.id }),
                                () => `${atCounter.public_code} returned to the queue.`,
                              )
                            }
                          >
                            Return to queue (recall)
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void send(
                            cmd('ticket.complete', { ticket_id: atCounter.id }),
                            () => `${atCounter.public_code} completed.`,
                          )
                        }
                      >
                        Complete
                      </button>
                    )}
                    {atCounter.state === 'serving' ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void send(
                            cmd('ticket.pause', { ticket_id: atCounter.id }),
                            () => `${atCounter.public_code} put on hold.`,
                          )
                        }
                      >
                        Put on hold
                      </button>
                    ) : null}
                  </div>
                  {atCounter.state === 'serving' && q.transfer_targets.length > 0 ? (
                    <form
                      aria-label={`Transfer ${atCounter.public_code}`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!transferTarget) return;
                        void send(
                          cmd('ticket.transfer', {
                            ticket_id: atCounter.id,
                            destination_service_id: transferTarget,
                            reason_code: transferReason as QueueCommandRequest['reason_code'],
                          }),
                          (code) =>
                            `${atCounter.public_code} transferred; new ticket ${code ?? ''}.`,
                        );
                      }}
                    >
                      <fieldset className="form-grid">
                        <legend>Transfer this ticket</legend>
                        <div className="field">
                          <label htmlFor="transfer-target">Transfer to</label>
                          <select
                            id="transfer-target"
                            value={transferTarget}
                            onChange={(e) => setTransferTarget(e.target.value)}
                          >
                            <option value="">Choose a service…</option>
                            {q.transfer_targets.map((t) => (
                              <option key={t.service_id} value={t.service_id}>
                                {t.service_name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor="transfer-reason">Reason</label>
                          <select
                            id="transfer-reason"
                            value={transferReason}
                            onChange={(e) => setTransferReason(e.target.value)}
                          >
                            {TRANSFER_REASONS.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="form-actions">
                          <button
                            type="submit"
                            className="btn btn-secondary"
                            disabled={busy || !transferTarget}
                          >
                            Transfer
                          </button>
                        </div>
                      </fieldset>
                    </form>
                  ) : null}
                </div>
              ) : (
                <>
                  <p className="muted" data-testid="counter-free">
                    {counter ? `${counter.name} is free.` : 'Choose your counter to start calling.'}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary btn-large"
                    disabled={
                      busy ||
                      !counter ||
                      !counter.active ||
                      q.state !== 'open' ||
                      waiting.length === 0
                    }
                    onClick={() =>
                      void send(
                        cmd('ticket.call_next', { counter_id: counterId }),
                        (code) => `Called ${code ?? ''} to ${counter?.name ?? 'counter'}.`,
                      )
                    }
                  >
                    Call next
                  </button>
                  {q.state !== 'open' ? (
                    <p className="hint">Calling is available only while the queue is open.</p>
                  ) : null}
                  {q.state === 'open' && waiting.length === 0 ? (
                    <p className="hint">Nobody is waiting.</p>
                  ) : null}
                </>
              )}
              {atCounter ? (
                <p className="hint" data-testid="call-next-hint">
                  Finish {atCounter.public_code} to call the next visitor.
                </p>
              ) : null}
            </section>
          ) : (
            <p className="alert alert-info" data-testid="read-only-console">
              You can view this queue. Calling visitors requires the counter operator or supervisor
              role.
            </p>
          )}

          <section aria-labelledby="waiting-heading">
            <h2 id="waiting-heading">Waiting ({waiting.length})</h2>
            {waiting.length === 0 ? <p className="muted">Nobody is waiting.</p> : null}
            <ol className="ticket-list" data-testid="waiting-list">
              {waiting.map((t) => (
                <li key={t.id} className="ticket-row">
                  <span className="ticket-row-code">{t.public_code}</span>
                  <span className="muted ticket-row-meta">
                    {t.channel === 'staff'
                      ? 'Walk-in'
                      : t.channel === 'transfer'
                        ? `Transfer from ${t.transferred_from_code ?? ''}`
                        : 'Web'}
                    {' · joined '}
                    {formatTime(t.joined_at)}
                  </span>
                  {canWalkIn ? (
                    confirmCancel === t.id ? (
                      <span className="ticket-row-actions">
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={() => {
                            setConfirmCancel(null);
                            void send(
                              cmd('ticket.cancel', { ticket_id: t.id }),
                              () => `${t.public_code} cancelled.`,
                            );
                          }}
                        >
                          Confirm cancel<span className="visually-hidden"> {t.public_code}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setConfirmCancel(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <span className="ticket-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setConfirmCancel(t.id)}
                        >
                          Cancel<span className="visually-hidden"> {t.public_code}</span>
                        </button>
                      </span>
                    )
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          {held.length > 0 ? (
            <section aria-labelledby="held-heading">
              <h2 id="held-heading">On hold and missed</h2>
              <ul className="ticket-list">
                {held.map((t) => (
                  <li key={t.id} className="ticket-row">
                    <span className="ticket-row-code">{t.public_code}</span>
                    <span className="muted ticket-row-meta">{STATE_LABEL[t.state]}</span>
                    {(t.state === 'paused' && canCount) ||
                    (t.state === 'missed' && canReturnMissed) ? (
                      <span className="ticket-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            void send(
                              cmd('ticket.resume', { ticket_id: t.id }),
                              () => `${t.public_code} back in the queue.`,
                            )
                          }
                        >
                          Return to queue<span className="visually-hidden"> {t.public_code}</span>
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="split-side">
          {canWalkIn ? (
            <section aria-labelledby="walkin-heading" className="card">
              <h2 id="walkin-heading" className="card-title">
                Walk-in registration
              </h2>
              <p className="hint">
                For visitors without a phone: issue a ticket and tell them the code.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || q.state !== 'open'}
                onClick={() => void issueWalkIn()}
              >
                Issue walk-in ticket
              </button>
              {walkIn && walkInQr ? (
                <div className="alert alert-success qr-panel" data-testid="walkin-result">
                  <p className="ticket-code" data-testid="walkin-code">
                    {walkIn.code}
                  </p>
                  <p>
                    Tell the visitor their code. If they have a phone, they can scan this to follow
                    their place in line.
                  </p>
                  <svg
                    role="img"
                    aria-label={`QR code with the status link for ticket ${walkIn.code}`}
                    viewBox={`0 0 ${qrTotal} ${qrTotal}`}
                    className="qr"
                    shapeRendering="crispEdges"
                  >
                    <rect width={qrTotal} height={qrTotal} fill="#fff" />
                    <path
                      transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}
                      fill="#000"
                      d={qrPath(walkInQr)}
                    />
                  </svg>
                  <details>
                    <summary>Show status link</summary>
                    <code className="mono wrap" data-testid="walkin-link">
                      {walkIn.link}
                    </code>
                  </details>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setWalkIn(null)}
                    >
                      Hide
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {canManage ? (
            <section aria-labelledby="session-heading" className="card">
              <h2 id="session-heading" className="card-title">
                Queue controls
              </h2>
              <div className="btn-row">
                {q.state === 'open' ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void send(cmd('queue.pause'), () => 'Queue paused. No new visitors or calls.')
                    }
                  >
                    Pause queue
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void send(cmd('queue.open'), () => 'Queue open.')}
                  >
                    {q.state === 'closed' ? 'Reopen queue' : 'Resume queue'}
                  </button>
                )}
                {q.state !== 'closed' ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void send(cmd('queue.close'), () => 'Queue closed for today.')}
                  >
                    Close queue
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="estimate-heading" className="card">
            <h2 id="estimate-heading" className="card-title">
              Estimate for a new visitor
            </h2>
            <p data-testid="staff-estimate">{formatEstimate(q.estimate_for_new_visitor)}</p>
          </section>

          {finished.length > 0 ? (
            <section aria-labelledby="done-heading">
              <h2 id="done-heading">Recently finished</h2>
              <ul className="plain-list">
                {finished.map((t) => (
                  <li key={t.id}>
                    {t.public_code} — {STATE_LABEL[t.state]}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
