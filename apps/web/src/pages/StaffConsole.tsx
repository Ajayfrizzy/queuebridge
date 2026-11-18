import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  QueueAction,
  SyncStatus,
  uuidv7,
  type OfflineAction,
  type QueueCommandRequest,
  type StaffQueue,
  type SyncSnapshot,
} from '@queuebridge/contracts';
import {
  CAPTURE_ONLY_MESSAGE,
  decideLocalCall,
  newCaptureInput,
  evaluateOfflineAction,
  offlineAuthorityState,
  projectQueue,
  StorageUnavailableError,
  timingEvidence,
  type LocalAuthority,
  type LocalTicket,
  type OutboxOperation,
} from '@queuebridge/continuity';
import { SyncStateIndicator } from '@queuebridge/ui';
import { useAuth } from '../auth.js';
import { TurnAlertStatus } from '../components/TurnAlertStatus.js';
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
import { StaffRecoveryPanel } from '../components/StaffRecoveryPanel.js';
import { OwnDeviceWarning } from '../components/OwnDeviceWarning.js';
import { formatRecoveryKey } from '@queuebridge/contracts';
import { outcomeOfStatus } from '../lib/operationIds.js';
import { OutboxPanel } from '../components/OutboxPanel.js';
import {
  CounterAvailabilityControl,
  CounterTransferForm,
  PriorityBadge,
  TicketOverridePanel,
  type RunOnline,
} from '../components/FairnessControls.js';
import { StatusHandoverPanel } from '../components/StatusHandoverPanel.js';
import { useOffline } from '../offline/OfflineProvider.js';
import { useCachedLoad } from '../offline/useCachedLoad.js';
import { readClock } from '../offline/clock.js';
import { useQueFacilityHint } from '../que/screenHint.js';

/** A ticket as the console shows it: server state plus this device's unsent changes. */
type Ticket = StaffQueue['tickets'][number] & {
  provisional: boolean;
  temporary_ref: string | null;
  local_status: SyncStatus | null;
};

function toViewTicket(t: LocalTicket, base: StaffQueue['tickets'][number] | undefined): Ticket {
  return {
    id: t.id ?? t.key,
    public_code: t.label,
    state: t.state,
    priority_class: t.priority_class,
    issued_sequence: t.issued_sequence,
    position: t.position,
    counter_id: t.counter_id,
    counter_name: t.counter_name,
    channel: base?.channel ?? 'staff',
    joined_at: t.joined_at ?? new Date(0).toISOString(),
    wait_since: t.wait_since ?? base?.wait_since ?? t.joined_at ?? new Date(0).toISOString(),
    called_at: base?.called_at ?? null,
    transferred_from_code: base?.transferred_from_code ?? null,
    provisional: t.provisional,
    temporary_ref: t.temporary_ref,
    local_status: t.local_status,
  };
}

/** Target fields for an offline command: the server id, or the temporary reference. */
const targetOf = (t: Ticket): { ticket_id: string } | { ticket_ref: string } =>
  t.provisional ? { ticket_ref: t.temporary_ref ?? '' } : { ticket_id: t.id };

const OFFLINE_ACTIONS: string[] = [
  QueueAction.TICKET_CALL_NEXT,
  QueueAction.TICKET_SERVE,
  QueueAction.TICKET_COMPLETE,
  QueueAction.TICKET_MISS,
];

const TRANSFER_REASONS = [
  ['needs_other_service', 'Needs another service'],
  ['wrong_service', 'Joined the wrong service'],
  ['visitor_request', 'Visitor asked'],
  ['staff_judgement', 'Staff judgement'],
] as const;

const counterKey = (queueId: string): string => `qb.staffCounter.${queueId}`;

/** UI hints only (the API re-authorizes): who may override, and who may read the audit. */
const OVERRIDE_ROLES = ['supervisor', 'facility_admin'] as const;
const AUDIT_ROLES = ['auditor', 'supervisor', 'facility_admin'] as const;

/**
 * Staff queue console (M2.3). Every button sends an idempotent, server-authorized command; the
 * screen only shows server-confirmed state and refreshes on live change signals. Controls are
 * hidden when the role cannot use them, but the API enforces every rule independently.
 */
export function StaffConsole(): ReactElement {
  const { queueId = '' } = useParams();
  const { user } = useAuth();
  const announce = useAnnounce();
  const offline = useOffline();
  const queue = useCachedLoad(() => api.staffQueue(queueId), `queue-${queueId}`);
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
  const [walkIn, setWalkIn] = useState<{ code: string; link: string; key: string | null } | null>(
    null,
  );
  /** Operation id of a walk-in whose outcome is unknown (lost response). */
  const [pendingWalkIn, setPendingWalkIn] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferReason, setTransferReason] = useState<string>('needs_other_service');
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  /** Waiting ticket whose supervisor actions panel is open (M4) */
  const [managing, setManaging] = useState<string | null>(null);
  /** Services left without an open counter by the last availability change (M4) */
  const [uncovered, setUncovered] = useState<string[]>([]);

  const q = queue.data?.queue;

  // ---- Offline coordination (M3) -------------------------------------------------------------
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [coord, setCoord] = useState<SyncSnapshot['coordinator'] | null>(null);
  const [authority, setAuthority] = useState<LocalAuthority | null>(null);
  const [knownEpoch, setKnownEpoch] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [offlineCapture, setOfflineCapture] = useState<{ ref: string } | null>(null);
  const { ensureDevice, refreshSnapshot, loadCached, authorityFor } = offline;
  const facilityId = q?.facility_id;
  // Ask Que (MQ.3): this screen's facility, so help can link to the facility's other screens
  useQueFacilityHint(facilityId);
  const revision = q?.revision;
  const reachable = offline.reachable;

  useEffect(() => {
    if (!facilityId) return undefined;
    let alive = true;
    void (async () => {
      const dev = await ensureDevice(facilityId);
      // A device id is never "unlearned" by a later, failed lookup (e.g. lost connectivity)
      if (dev) setDeviceId(dev);
      if (!alive) return;
      if (reachable) {
        const snap = await refreshSnapshot(queueId, dev);
        if (alive && snap) setCoord(snap.coordinator);
      } else {
        const cached = await loadCached(queueId);
        if (alive && cached) setCoord(cached.coordinator);
      }
      const a = await authorityFor(queueId);
      if (!alive) return;
      setAuthority(a.authority);
      setKnownEpoch(a.knownEpoch);
    })();
    return (): void => {
      alive = false;
    };
  }, [
    facilityId,
    revision,
    reachable,
    queueId,
    ensureDevice,
    refreshSnapshot,
    loadCached,
    authorityFor,
  ]);

  // A ticking clock keeps the "authority expires in …" state honest while offline
  useEffect(() => {
    if (!authority) return undefined;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return (): void => clearInterval(t);
  }, [authority]);

  const queueOps: OutboxOperation[] = useMemo(
    () => offline.ops.filter((o) => o.queue_session_id === queueId),
    [offline.ops, queueId],
  );
  const projected = useMemo(() => (q ? projectQueue(q, queueOps) : null), [q, queueOps]);
  const viewTickets: Ticket[] = useMemo(
    () =>
      projected && q
        ? projected.tickets.map((t) =>
            toViewTicket(
              t,
              q.tickets.find((x) => x.id === t.id),
            ),
          )
        : [],
    [projected, q],
  );
  // `nowMs` ticks every second so this re-evaluates; the clocks themselves are read fresh
  void nowMs;
  const authState = offlineAuthorityState(authority, {
    queueId,
    deviceId: deviceId ?? '',
    clock: readClock(),
    knownServerEpoch: knownEpoch,
  });
  const iAmCoordinator =
    deviceId !== null && coord?.device_id === deviceId && coord.status !== 'none';
  /** Advancement goes through the outbox when offline, or when this device IS the coordinator. */
  const viaOutbox = !reachable || (authority !== null && iAmCoordinator);
  const otherCoordinator =
    reachable && coord !== null && coord.status !== 'none' && !iAmCoordinator;
  const advanceBlockedReason: string | null = otherCoordinator
    ? `A coordinator device${coord?.device_label ? ` (${coord.device_label})` : ''} holds authority over this queue. Calling and serving are paused here until it syncs or a supervisor revokes it.`
    : viaOutbox && authState.mode !== 'advance'
      ? CAPTURE_ONLY_MESSAGE[authState.reason]
      : null;

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
      viewTickets.find(
        (t) => t.counter_id === counterId && (t.state === 'called' || t.state === 'serving'),
      ),
    [viewTickets, counterId],
  );

  if (!user || (queue.loading && !q)) return <Loading what="queue" />;
  if (!q) {
    return (
      <>
        <h1>{queue.error?.status === 0 ? 'Offline' : 'Queue not found'}</h1>
        <p role="alert">
          {queue.error?.status === 0
            ? 'Cannot reach the server, and this queue has no saved copy on this device yet.'
            : 'This queue does not exist or you do not have access to it.'}
        </p>
      </>
    );
  }
  const fid = q.facility_id;
  const canManage = hasFacilityRole(user, fid, QUEUE_MANAGER_ROLES);
  const canCount = hasFacilityRole(user, fid, COUNTER_ROLES);
  const canWalkIn = hasFacilityRole(user, fid, WALK_IN_ROLES);
  const isSupervisor = hasFacilityRole(user, fid, ['supervisor']);
  /** Priority / routing overrides and releasing a called visitor (API: supervisor, facility admin) */
  const canOverride = hasFacilityRole(user, fid, OVERRIDE_ROLES);
  const canAudit = hasFacilityRole(user, fid, AUDIT_ROLES);
  const canReturnMissed = hasFacilityRole(user, fid, [
    'staff_reception',
    'staff_counter',
    'supervisor',
  ]);
  const counter = projected?.counters.find((c) => c.id === counterId);
  const waiting = viewTickets
    .filter((t) => t.state === 'waiting')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const held = viewTickets.filter((t) => t.state === 'paused' || t.state === 'missed');
  const finished = viewTickets.filter((t) =>
    ['completed', 'cancelled', 'transferred'].includes(t.state),
  );
  const advanceDisabled = busy || advanceBlockedReason !== null;
  const onlineOnlyDisabled = busy || viaOutbox || otherCoordinator;
  const counterOpen = counter?.availability !== 'closed';
  /** Active AND open: only then may it call or start serving (the API enforces the same rule) */
  const counterInService = counter !== undefined && counter.active && counterOpen;
  /** Overrides are online-only and need the live (M4-shaped) queue, never a saved copy */
  const overridesAvailable = reachable && !viaOutbox && !queue.fromCache;
  /** This device's counter, when it could take a call right now (for "call out of order") */
  const callableCounter =
    counter && counter.active && counterOpen && !counter.busy_with && q.state === 'open'
      ? { id: counter.id, name: counter.name }
      : null;
  const transferCounters = (projected?.counters ?? [])
    .filter((c) => c.id !== counterId && c.active && c.availability === 'open' && !c.busy_with)
    .map((c) => ({ id: c.id, name: c.name }));

  /**
   * Run one online-only M4 action: busy state, announcement, visible error, then reload.
   * Reports how it ended so the form can decide whether its operation id may be reused.
   */
  const runOnline: RunOnline = async (action) => {
    setBusy(true);
    setLastError(null);
    setLocalNote(null);
    try {
      announce(await action());
      return 'committed';
    } catch (e) {
      const err =
        e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error');
      const fields = Object.values(err.fieldErrors());
      const message = fields.length > 0 ? `${err.message} ${fields.join(' ')}` : err.message;
      setLastError({ message, retry: null });
      announce(message);
      return outcomeOfStatus(err.status);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const labelFor = (op: OutboxOperation): string => {
    const p = op.payload as { ticket_id?: string; ticket_ref?: string; temporary_ref?: string };
    if (p.temporary_ref) return p.temporary_ref;
    if (p.ticket_ref) return p.ticket_ref;
    return viewTickets.find((t) => t.id === p.ticket_id)?.public_code ?? '';
  };

  /** Record an action on THIS device (durably, before any acknowledgement); the server decides later. */
  async function sendLocal(
    body: QueueCommandRequest,
    success: (code: string | null) => string,
  ): Promise<void> {
    setLastError(null);
    setLocalNote(null);
    const refuse = (message: string): void => {
      setLastError({ message, retry: null });
      announce(message);
    };
    if (!q || !projected) return;
    if (!OFFLINE_ACTIONS.includes(body.action)) {
      refuse('This action needs a connection to the server. It cannot be recorded offline.');
      return;
    }
    if (!deviceId) {
      refuse('This device is not registered for offline use. Reconnect once to enable it.');
      return;
    }
    // Re-read the held authority with its floor advanced to now (persisted) before deciding
    const fresh = (await authorityFor(queueId)).authority;
    setAuthority(fresh);
    const clock = readClock();
    const decision = evaluateOfflineAction(fresh, {
      queueId,
      deviceId,
      action: body.action as QueueAction,
      clock,
      knownServerEpoch: knownEpoch,
    });
    if (!decision.allowed || !fresh) {
      refuse(CAPTURE_ONLY_MESSAGE[decision.allowed ? 'no_authority' : decision.reason]);
      return;
    }
    let payload: Record<string, unknown>;
    let label: string | null = null;
    if (body.action === 'ticket.call_next') {
      const d = decideLocalCall(q.state, projected, body.counter_id ?? '');
      if (!d.ok) {
        const why = {
          queue_not_open: 'Calling is only possible while the queue is open.',
          queue_empty: 'Nobody is waiting.',
          counter_missing: 'Choose an active counter first.',
          counter_closed: 'That counter is closed. Open it before calling.',
          counter_busy: 'That counter is still handling a ticket.',
        }[d.reason];
        refuse(why);
        return;
      }
      payload = { ...d.payload };
      label = d.ticket.label;
    } else {
      const t = viewTickets.find((x) => x.id === body.ticket_id);
      if (!t) {
        refuse('That ticket is no longer on this screen.');
        return;
      }
      payload = targetOf(t);
      label = t.public_code;
    }
    try {
      await offline.record({
        facility_id: q.facility_id,
        queue_session_id: queueId,
        device_id: deviceId,
        coordinator_epoch: fresh.auth.epoch,
        base_revision: q.revision,
        action: body.action as OfflineAction,
        payload,
        // Elapsed-time evidence relative to the signed delivery time (never the wall clock alone)
        authority_timing: timingEvidence(fresh, clock),
      });
      const msg = `${success(label)} Saved on this device — not confirmed by the server yet.`;
      setLocalNote(msg);
      announce(msg);
    } catch (e) {
      refuse(
        e instanceof StorageUnavailableError
          ? 'This browser could not save the action, so it was NOT recorded. Do not rely on it.'
          : 'The action could not be recorded.',
      );
    }
  }

  async function send(
    body: QueueCommandRequest,
    success: (code: string | null) => string,
  ): Promise<void> {
    if (viaOutbox) {
      await sendLocal(body, success);
      return;
    }
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

  async function captureOffline(): Promise<void> {
    setLastError(null);
    setLocalNote(null);
    const fail = (message: string): void => {
      setLastError({ message, retry: null });
      announce(message);
    };
    if (!q) return;
    if (!deviceId) {
      fail('This device is not registered for offline use. Reconnect once to enable it.');
      return;
    }
    try {
      const op = await offline.record(
        newCaptureInput({
          facility_id: q.facility_id,
          queue_session_id: queueId,
          device_id: deviceId,
          coordinator_epoch: authority?.auth.epoch ?? 0,
          base_revision: q.revision,
        }),
      );
      setOfflineCapture({ ref: op.temporary_ref ?? '' });
      setWalkIn(null);
      announce(
        `Saved on this device as ${op.temporary_ref ?? ''}. Not confirmed by the server yet.`,
      );
    } catch (e) {
      fail(
        e instanceof StorageUnavailableError
          ? 'This browser could not save the ticket, so it was NOT recorded. Write the visitor down on paper.'
          : 'The ticket could not be recorded.',
      );
    }
  }

  async function issueWalkIn(): Promise<void> {
    if (!reachable && !pendingWalkIn) {
      await captureOffline();
      return;
    }
    setOfflineCapture(null);
    setBusy(true);
    setLastError(null);
    // Reuse the operation id of a walk-in whose response was lost: the server returns the SAME
    // ticket (with a fresh status link) instead of issuing a second one for the same visitor.
    const op = pendingWalkIn ?? uuidv7();
    setPendingWalkIn(op);
    try {
      const res = await api.walkIn(queueId, op);
      // Token and recovery key travel in the URL FRAGMENT only (never sent to a server)
      const fragment = new URLSearchParams({ t: res.ticket.status_token });
      if (res.ticket.recovery_key) fragment.set('k', res.ticket.recovery_key);
      const link = new URL(
        `${res.ticket.status_path}#${fragment.toString()}`,
        window.location.origin,
      ).toString();
      setWalkIn({ code: res.ticket.public_code, link, key: res.ticket.recovery_key });
      setPendingWalkIn(null);
      announce(`Walk-in ticket ${res.ticket.public_code} issued.`);
    } catch (e) {
      const err =
        e instanceof ApiRequestError
          ? e
          : new ApiRequestError(0, null, 'Could not issue the ticket.');
      const uncertain = err.status === 0 || err.status >= 500;
      // A definite refusal (paused/closed/forbidden) ends this attempt; an uncertain one keeps
      // the operation id so "Finish issuing" can recover the ticket that may already exist.
      if (!uncertain) setPendingWalkIn(null);
      const msg = uncertain
        ? `${err.message} The ticket may already have been issued — use “Finish issuing walk-in ticket” to get it without creating a second one.`
        : err.message;
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
      <div className="page-head" data-device-ready={deviceId ? 'true' : 'false'}>
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

      {queue.fromCache ? (
        <p role="status" className="alert alert-warn" data-testid="cached-notice">
          <strong>Showing the last saved copy of this queue.</strong> It may be out of date until
          the server can be reached.
        </p>
      ) : null}
      {q.no_open_counter && q.state === 'open' ? (
        <p role="status" className="alert alert-warn" data-testid="no-open-counter">
          <strong>No counter is open for this service.</strong> Visitors keep their place in line,
          but nobody can be called until a counter is opened.
        </p>
      ) : null}
      {uncovered.length > 0 ? (
        <p role="status" className="alert alert-warn" data-testid="uncovered-services">
          Now without an open counter: {uncovered.join(', ')}.
        </p>
      ) : null}
      {canAudit ? (
        <p>
          <Link to={`/staff/queues/${queueId}/audit`} data-testid="audit-link">
            Audit trail and integrity check
          </Link>
        </p>
      ) : null}
      <OwnDeviceWarning deviceId={deviceId} reachable={reachable} />
      {canCount && advanceBlockedReason ? (
        <p role="status" className="alert alert-warn" data-testid="authority-banner">
          {advanceBlockedReason}
        </p>
      ) : null}
      {canCount && viaOutbox && authState.mode === 'advance' ? (
        <p role="status" className="alert alert-info" data-testid="authority-active">
          <strong>This device is the offline coordinator for this queue</strong> (authority epoch{' '}
          {authority?.auth.epoch}). What you do here is saved on this device and is{' '}
          <strong>not final</strong> until the server confirms it. Authority ends in about{' '}
          {Math.max(1, Math.round(authState.expiresInMs / 60000))} min.
        </p>
      ) : null}
      {localNote ? (
        <p role="status" className="alert alert-info" data-testid="local-note">
          {localNote}
        </p>
      ) : null}

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
                  {(projected?.counters ?? []).map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.active}>
                      {c.name}
                      {!c.active
                        ? ' (inactive)'
                        : c.availability === 'closed'
                          ? ' (closed)'
                          : c.busy_with
                            ? ` (serving ${c.busy_with})`
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
              {counter && counter.active && reachable && !viaOutbox ? (
                <CounterAvailabilityControl
                  counter={{
                    id: counter.id,
                    name: counter.name,
                    availability: counter.availability,
                  }}
                  atCounterState={
                    atCounter?.state === 'called' || atCounter?.state === 'serving'
                      ? atCounter.state
                      : null
                  }
                  canRelease={canOverride}
                  disabled={onlineOnlyDisabled}
                  run={runOnline}
                  onResult={(r) => setUncovered(r.services_without_open_counter.map((x) => x.name))}
                />
              ) : null}
              {counter && !counter.active ? (
                <p role="status" className="alert alert-warn" data-testid="counter-inactive">
                  <strong>{counter.name} has been deactivated by an administrator.</strong> It
                  cannot call or serve visitors. Choose another counter.
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
                      {atCounter.local_status ? (
                        <>
                          <SyncStateIndicator status={atCounter.local_status} />{' '}
                        </>
                      ) : null}
                      <StatusBadge active on={STATE_LABEL[atCounter.state] ?? atCounter.state} />
                      {atCounter.called_at ? (
                        <span className="muted"> · called {formatTime(atCounter.called_at)}</span>
                      ) : null}
                    </p>
                  </div>
                  {atCounter.state === 'called' &&
                  (!atCounter.local_status || atCounter.local_status === 'committed') ? (
                    <TurnAlertStatus
                      queueId={queueId}
                      ticketId={atCounter.id}
                      revision={q.revision}
                      reachable={reachable}
                    />
                  ) : null}
                  {atCounter.state === 'called' && !counterInService ? (
                    <p className="hint" data-testid="serve-blocked-hint">
                      This counter is out of service, so {atCounter.public_code} cannot be served
                      here. A supervisor can return them to the queue for an open counter.
                    </p>
                  ) : null}
                  <div className="btn-row">
                    {atCounter.state === 'called' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={advanceDisabled || !counterInService}
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
                          disabled={advanceDisabled}
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
                            disabled={onlineOnlyDisabled}
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
                        disabled={advanceDisabled}
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
                        disabled={onlineOnlyDisabled}
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
                  {!atCounter.provisional && reachable && !viaOutbox ? (
                    <CounterTransferForm
                      ticket={{ id: atCounter.id, public_code: atCounter.public_code }}
                      targets={transferCounters}
                      disabled={onlineOnlyDisabled}
                      run={runOnline}
                    />
                  ) : null}
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
                            disabled={onlineOnlyDisabled || !transferTarget}
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
                      advanceDisabled ||
                      !counter ||
                      !counter.active ||
                      !counterOpen ||
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
                  {counter && !counterOpen ? (
                    <p className="hint">Open this counter to call visitors.</p>
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
                <li
                  key={t.id}
                  className={`ticket-row${t.provisional ? ' is-provisional' : ''}`}
                  data-testid={t.provisional ? 'provisional-ticket' : undefined}
                >
                  <span className="ticket-row-code">{t.public_code}</span>
                  {t.local_status ? <SyncStateIndicator status={t.local_status} /> : null}
                  <span className="muted ticket-row-meta">
                    <PriorityBadge cls={t.priority_class} />
                    {t.priority_class !== 'normal' ? ' ' : null}
                    {t.provisional
                      ? 'Temporary reference — the server has not confirmed this ticket'
                      : t.channel === 'staff'
                        ? 'Walk-in'
                        : t.channel === 'transfer'
                          ? `Transfer from ${t.transferred_from_code ?? ''}`
                          : 'Web'}
                    {' · joined '}
                    {formatTime(t.joined_at)}
                  </span>
                  {canOverride && overridesAvailable && !t.provisional && managing !== t.id ? (
                    <span className="ticket-row-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-expanded={false}
                        onClick={() => setManaging(t.id)}
                      >
                        Supervisor actions
                        <span className="visually-hidden"> for {t.public_code}</span>
                      </button>
                    </span>
                  ) : null}
                  {canOverride && overridesAvailable && managing === t.id ? (
                    <TicketOverridePanel
                      ticket={{
                        id: t.id,
                        public_code: t.public_code,
                        priority_class: t.priority_class,
                      }}
                      policy={q.policy}
                      counter={callableCounter}
                      disabled={onlineOnlyDisabled}
                      run={runOnline}
                      onClose={() => setManaging(null)}
                    />
                  ) : null}
                  {canWalkIn && !t.provisional ? (
                    confirmCancel === t.id ? (
                      <span className="ticket-row-actions">
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={onlineOnlyDisabled}
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
                          disabled={onlineOnlyDisabled}
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
          <StatusHandoverPanel
            handovers={offline.handovers.filter((h) => h.queue_session_id === queueId)}
            confirmedCaptures={queueOps.filter(
              (o) =>
                o.action === QueueAction.TICKET_CREATE &&
                (o.status === SyncStatus.COMMITTED || o.status === SyncStatus.DUPLICATE),
            )}
            onDone={offline.dismissHandover}
            onReissue={offline.requestHandover}
          />
          <OutboxPanel ops={queueOps} labelFor={labelFor} />
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
                disabled={busy || (q.state !== 'open' && !pendingWalkIn)}
                onClick={() => void issueWalkIn()}
              >
                {pendingWalkIn && !busy ? 'Finish issuing walk-in ticket' : 'Issue walk-in ticket'}
              </button>
              {offlineCapture ? (
                <div className="alert alert-info" data-testid="offline-capture">
                  <p className="ticket-code" data-testid="offline-capture-ref">
                    {offlineCapture.ref}
                  </p>
                  <p>
                    <SyncStateIndicator status={SyncStatus.LOCAL_ONLY} /> Saved on this device only.
                    This is a <strong>temporary reference</strong>, not a ticket number. Tell the
                    visitor they are registered; their real code is confirmed when the server is
                    reachable. Ticket recovery is not available until then.
                  </p>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setOfflineCapture(null)}
                    >
                      Hide
                    </button>
                  </div>
                </div>
              ) : null}
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
                  {walkIn.key ? (
                    <p>
                      Recovery key, for the visitor to keep (shown once):{' '}
                      <strong className="mono" data-testid="walkin-key">
                        {formatRecoveryKey(walkIn.key)}
                      </strong>
                    </p>
                  ) : null}
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

          {canWalkIn ? (
            <StaffRecoveryPanel
              queueId={queueId}
              tickets={viewTickets
                .filter(
                  (t) =>
                    !t.provisional &&
                    ['waiting', 'called', 'serving', 'paused', 'missed'].includes(t.state),
                )
                .map((t) => ({ id: t.id, public_code: t.public_code }))}
              canApprove={canManage}
              disabled={!reachable || queue.fromCache}
            />
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
                    disabled={busy || !reachable}
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
                    disabled={busy || !reachable}
                    onClick={() => void send(cmd('queue.open'), () => 'Queue open.')}
                  >
                    {q.state === 'closed' ? 'Reopen queue' : 'Resume queue'}
                  </button>
                )}
                {q.state !== 'closed' ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !reachable}
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
                    {t.public_code} — {STATE_LABEL[t.state]}{' '}
                    {t.local_status ? <SyncStateIndicator status={t.local_status} /> : null}
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
