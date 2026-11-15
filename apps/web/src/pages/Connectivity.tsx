import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CONFLICT_RESOLUTION_REASONS,
  FAILOVER_REASONS,
  REVOKE_COORDINATOR_REASONS,
  DEVICE_REVOKE_REASONS,
  SyncStatus,
  uuidv7,
  type DeviceHealth,
  type QueueHealth,
  type SyncConflict,
} from '@queuebridge/contracts';
import { SyncStateIndicator } from '@queuebridge/ui';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { Loading } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { QUEUE_MANAGER_ROLES, hasFacilityRole } from '../lib/permissions.js';
import { useOffline } from '../offline/OfflineProvider.js';
import { useLoad } from '../lib/useLoad.js';
import { HealthAlertsPanel } from '../components/HealthAlertsPanel.js';
import { HEALTH_LABEL, HEALTH_RANK } from '../lib/healthText.js';

const REFRESH_MS = 5000;

type DeviceFilter = 'all' | 'attention' | 'silent' | 'revoked';
const FILTER_LABEL: Record<DeviceFilter, string> = {
  all: 'All devices',
  attention: 'Needing attention',
  silent: 'Offline or stale',
  revoked: 'Revoked',
};
const REVOKE_REASON_LABEL: Record<string, string> = {
  lost: 'Lost',
  stolen: 'Stolen',
  retired: 'No longer used',
  compromised: 'Compromised',
  other: 'Other reason',
};

const words = (code: string): string => code.replace(/_/g, ' ');

/**
 * Connectivity and recovery dashboard (F9, M3.3). What the SERVER knows about each device —
 * pending counts are self-reported, so they are labelled approximate — plus coordinator
 * authority and failover, and the supervisor review queue for held offline actions.
 */
export function Connectivity(): ReactElement {
  const { fid = '' } = useParams();
  const { user } = useAuth();
  const announce = useAnnounce();
  const offline = useOffline();
  const health = useLoad(() => api.operationsHealth(fid), `health-${fid}`);
  const conflicts = useLoad(() => api.conflicts(fid, true), `conflicts-${fid}`);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [filter, setFilter] = useState<DeviceFilter>('all');
  const reloadHealth = health.reload;
  const reloadConflicts = conflicts.reload;

  useEffect(() => {
    const t = setInterval(() => {
      void reloadHealth();
      void reloadConflicts();
    }, REFRESH_MS);
    return (): void => clearInterval(t);
  }, [reloadHealth, reloadConflicts]);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      setMessage(null);
      try {
        await fn();
        setMessage({ text: `${label} done.`, error: false });
        announce(`${label} done.`);
      } catch (e) {
        const text = e instanceof ApiRequestError ? e.message : 'The action failed.';
        setMessage({ text, error: true });
        announce(text);
      }
      await Promise.all([reloadHealth(), reloadConflicts()]);
    },
    [announce, reloadHealth, reloadConflicts],
  );

  if (!user || (health.loading && !health.data)) return <Loading what="connectivity" />;
  if (!health.data) {
    return (
      <>
        <h1>Connectivity</h1>
        <p role="alert">
          {health.error?.status === 0
            ? 'Cannot reach the server. The dashboard needs a connection.'
            : 'This facility does not exist or you do not have access to its connectivity tools.'}
        </p>
      </>
    );
  }
  const h = health.data.health;
  const canAct = hasFacilityRole(user, fid, QUEUE_MANAGER_ROLES);
  const liveDevices = h.devices.filter((d) => !d.revoked_at);
  const shownDevices = h.devices
    .filter((d) =>
      filter === 'all'
        ? true
        : filter === 'revoked'
          ? d.health === 'revoked'
          : filter === 'silent'
            ? d.health === 'offline' || d.health === 'stale'
            : d.health !== 'healthy' && d.health !== 'revoked',
    )
    .sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health]);
  const list = conflicts.data?.conflicts ?? [];
  const open = list.filter((c) => c.status === 'needs_review');
  const past = list.filter((c) => c.status !== 'needs_review');

  return (
    <>
      <p>
        <Link to={`/staff/facilities/${fid}`}>← Today&apos;s queues</Link>
      </p>
      <h1>Connectivity and recovery</h1>
      <p className="muted">
        Server health is checked separately from each device&apos;s connection. A device&apos;s
        unsent-action count is reported by the device itself, so treat it as approximate. A silent
        device may be offline, asleep, closed or lost: the server cannot tell which. Offline means
        no contact for {Math.round(h.offline_after_seconds / 60)} min; stale means no contact for{' '}
        {Math.round(h.stale_after_seconds / 60)} min.
      </p>
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={`alert ${message.error ? 'alert-error' : 'alert-success'}`}
          data-testid="connectivity-message"
        >
          {message.text}
        </p>
      ) : null}

      <HealthAlertsPanel
        alerts={h.alerts}
        evaluation={h.evaluation}
        canAcknowledge={canAct}
        onAcknowledge={(a) => void act('Alert acknowledged', () => api.acknowledgeAlert(fid, a.id))}
      />

      <dl className="stat-row" data-testid="health-counters">
        <div className="stat">
          <dt>Recovery-abuse signals (24 h)</dt>
          <dd>{h.counters.recovery_abuse_24h}</dd>
        </div>
        <div className="stat">
          <dt>Failed turn alerts (1 h)</dt>
          <dd>{h.counters.turn_alert_failures_1h}</dd>
        </div>
      </dl>
      <section
        aria-labelledby="turn-alerts-heading"
        className="card"
        data-testid="turn-alert-counters"
      >
        <h2 id="turn-alerts-heading" className="card-title">
          Visitor push alerts (last hour)
        </h2>
        <p className="hint">
          Push alerts are best effort. “Sent” means the push service accepted the alert; only “seen
          on device” is confirmed by the visitor’s page. An expired browser subscription is not
          counted as a failure. The public board and calling aloud remain the reliable fallback.
        </p>
        <dl className="stat-row">
          {(
            [
              ['Attempted', h.turn_alerts.attempted],
              ['Sent, not confirmed', h.turn_alerts.sent],
              ['Seen on device', h.turn_alerts.delivered],
              ['Failed', h.turn_alerts.failed],
              ['Not sent (ticket changed)', h.turn_alerts.suppressed],
              ['Outcome unknown', h.turn_alerts.unknown],
              ['Could not be queued', h.turn_alerts.enqueue_errors],
            ] as const
          ).map(([label, n]) => (
            <div className="stat" key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="this-device" className="card">
        <h2 id="this-device" className="card-title">
          This device
        </h2>
        <dl className="stat-row">
          <div className="stat">
            <dt>Server</dt>
            <dd data-testid="this-server">{offline.reachable ? 'Reachable' : 'Not reachable'}</dd>
          </div>
          <div className="stat">
            <dt>Local storage</dt>
            <dd>
              {offline.storage === 'ok'
                ? 'Working'
                : offline.storage === 'checking'
                  ? 'Checking…'
                  : 'Unavailable'}
            </dd>
          </div>
          <div className="stat">
            <dt>Unsent actions</dt>
            <dd data-testid="this-unsent">{offline.summary.unsynced}</dd>
          </div>
          <div className="stat">
            <dt>Needs review</dt>
            <dd>{offline.summary.needs_review}</dd>
          </div>
        </dl>
        {offline.lastFlush?.error ? (
          <p role="status" className="hint">
            Last send failed ({words(offline.lastFlush.error.kind)}). It will be retried; nothing
            was marked as synced.
          </p>
        ) : null}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!offline.reachable || offline.flushing || offline.summary.unsynced === 0}
            onClick={() => void offline.flush()}
          >
            Retry sending now
          </button>
          {canAct ? (
            wipeConfirm ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() =>
                    void offline.wipeLocalData().then(() => {
                      setWipeConfirm(false);
                      announce('Local data on this device was erased.');
                    })
                  }
                >
                  Erase {offline.summary.unsynced + offline.foreignPending} unsent{' '}
                  {offline.summary.unsynced + offline.foreignPending === 1 ? 'action' : 'actions'}{' '}
                  (everyone&apos;s) and all local data
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setWipeConfirm(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setWipeConfirm(true)}
              >
                Clear local data on this device…
              </button>
            )
          ) : null}
        </div>
      </section>

      <section aria-labelledby="queues-heading">
        <h2 id="queues-heading">Queues and coordinator authority</h2>
        <p className="hint">
          Only one device per queue may advance it offline. While a coordinator is designated,
          calling and serving from other devices is paused. Failing over fences the old coordinator:
          anything it did offline is held for review, never applied.
        </p>
        {h.queues.length === 0 ? <p className="muted">No queues are open today.</p> : null}
        <ul className="card-list">
          {h.queues.map((q) => (
            <QueueCard key={q.queue_id} q={q} devices={liveDevices} canAct={canAct} act={act} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="devices-heading">
        <h2 id="devices-heading">Devices</h2>
        <div className="field device-filter">
          <label htmlFor="device-filter">Show</label>
          <select
            id="device-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as DeviceFilter)}
          >
            {(Object.keys(FILTER_LABEL) as DeviceFilter[]).map((k) => (
              <option key={k} value={k}>
                {FILTER_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">Most urgent first.</p>
        {h.devices.length === 0 ? (
          <p className="muted">
            No device has registered yet. Devices register when staff open a queue console.
          </p>
        ) : (
          // Keyboard users can scroll a table that is wider than a narrow screen (WCAG 2.1.1)
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Devices table">
            <table className="data-table" data-testid="device-table">
              <caption className="visually-hidden">
                Registered devices and their sync health
              </caption>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Health</th>
                  <th scope="col">Last contact</th>
                  <th scope="col">Unsent (approx.)</th>
                  <th scope="col">Coordinator for</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody data-testid="device-rows">
                {shownDevices.map((d) => (
                  <DeviceRow key={d.id} d={d} canAct={canAct} act={act} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="review-heading">
        <h2 id="review-heading">Conflict review ({open.length} waiting)</h2>
        {open.length === 0 ? (
          <p className="muted" data-testid="no-conflicts">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="card-list" data-testid="conflict-list">
            {open.map((c) => (
              <ConflictCard key={c.operation_id} c={c} canAct={canAct} act={act} />
            ))}
          </ul>
        )}
        {past.length > 0 ? (
          <details>
            <summary>Earlier decisions and refused actions ({past.length})</summary>
            <ul className="plain-list">
              {past.map((c) => (
                <li key={c.operation_id}>
                  {words(c.action)} {c.ticket_code ?? c.temporary_ref ?? ''} from{' '}
                  {c.device_label ?? 'a device'} —{' '}
                  {c.resolution
                    ? `${c.resolution} by ${c.resolved_by_name ?? 'a supervisor'}`
                    : `refused (${words(c.reason_code ?? 'rejected')})`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </>
  );
}

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function QueueCard({
  q,
  devices,
  canAct,
  act,
}: {
  q: QueueHealth;
  devices: DeviceHealth[];
  canAct: boolean;
  act: Act;
}): ReactElement {
  const [device, setDevice] = useState('');
  const [reason, setReason] = useState<string>(FAILOVER_REASONS[0]);
  const [revokeReason, setRevokeReason] = useState<string>(REVOKE_COORDINATOR_REASONS[0]);
  const [ttl, setTtl] = useState('240');
  const c = q.coordinator;
  const id = `q-${q.queue_id}`;
  const ttlNum = Math.max(5, Math.min(720, Number(ttl) || 240));
  return (
    <li className="card" data-testid="queue-health">
      <h3 className="card-title">{q.service_name}</h3>
      <p data-testid="coordinator-status">
        Coordinator:{' '}
        {c.status === 'none' ? (
          <strong>none (queue is run online)</strong>
        ) : (
          <strong>
            {c.device_label ?? 'a device'} —{' '}
            {c.status === 'active' ? 'authority active' : 'authority EXPIRED'}
          </strong>
        )}{' '}
        <span className="muted">
          (epoch {c.epoch}
          {c.expires_at
            ? `, ${c.status === 'expired' ? 'expired' : 'until'} ${formatTime(c.expires_at)}`
            : ''}
          )
        </span>
      </p>
      {c.status === 'expired' ? (
        <p className="alert alert-warn" role="status">
          Offline authority has expired. The device may only capture tickets. Renew it, or fail over
          if the device is lost. Calling from other devices stays paused until you act.
        </p>
      ) : null}
      {q.open_conflicts > 0 ? (
        <p>
          <SyncStateIndicator status={SyncStatus.NEEDS_REVIEW} /> {q.open_conflicts} action
          {q.open_conflicts === 1 ? '' : 's'} waiting for review
        </p>
      ) : null}
      {canAct ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${id}-device`}>
              {c.status === 'none' ? 'Designate device' : 'New coordinator device'}
            </label>
            <select id={`${id}-device`} value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">Choose a device…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label ?? 'Unnamed device'} — {d.owner_name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-ttl`}>Authority lasts (minutes, 5–720)</label>
            <input
              id={`${id}-ttl`}
              inputMode="numeric"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
            />
          </div>
          {c.status === 'none' ? (
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!device}
                onClick={() =>
                  void act('Coordinator assigned', () =>
                    api.coordinator(q.queue_id, 'assign', {
                      operation_id: uuidv7(),
                      device_id: device,
                      ttl_minutes: ttlNum,
                    }),
                  )
                }
              >
                Make coordinator<span className="visually-hidden"> for {q.service_name}</span>
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor={`${id}-reason`}>Why replace it?</label>
                <select
                  id={`${id}-reason`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {FAILOVER_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {words(r)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!device}
                  onClick={() =>
                    void act('Failover', () =>
                      api.coordinator(q.queue_id, 'failover', {
                        operation_id: uuidv7(),
                        device_id: device,
                        ttl_minutes: ttlNum,
                        reason_code: reason,
                      }),
                    )
                  }
                >
                  Fail over to this device
                  <span className="visually-hidden"> for {q.service_name}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void act('Authority renewed', () =>
                      api.coordinator(q.queue_id, 'renew', {
                        operation_id: uuidv7(),
                        ttl_minutes: ttlNum,
                      }),
                    )
                  }
                >
                  Renew authority<span className="visually-hidden"> for {q.service_name}</span>
                </button>
              </div>
              <div className="field">
                <label htmlFor={`${id}-revoke`}>Reason to end authority</label>
                <select
                  id={`${id}-revoke`}
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                >
                  {REVOKE_COORDINATOR_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {words(r)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() =>
                    void act('Authority revoked', () =>
                      api.coordinator(q.queue_id, 'revoke', {
                        operation_id: uuidv7(),
                        reason_code: revokeReason,
                      }),
                    )
                  }
                >
                  End authority (run online)
                  <span className="visually-hidden"> for {q.service_name}</span>
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DeviceRow({
  d,
  canAct,
  act,
}: {
  d: DeviceHealth;
  canAct: boolean;
  act: Act;
}): ReactElement {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState<string>(DEVICE_REVOKE_REASONS[0]);
  const hl = HEALTH_LABEL[d.health];
  return (
    <tr data-testid="device-row" data-health={d.health}>
      <th scope="row">
        {d.label ?? 'Unnamed device'}
        <br />
        <span className="muted">{d.owner_name}</span>
      </th>
      <td>
        <span aria-hidden="true">{hl.symbol} </span>
        {hl.text}
        {d.needs_review_count > 0 ? ` (${d.needs_review_count} to review)` : ''}
        {d.last_failure_code ? (
          <>
            <br />
            <span className="muted">
              {words(d.last_failure_code)}
              {d.failure_streak > 1 ? ` (${d.failure_streak} times in a row)` : ''}
            </span>
          </>
        ) : null}
        {d.revoked_at ? (
          <>
            <br />
            <span className="muted" data-testid="revoked-detail">
              {REVOKE_REASON_LABEL[d.revoked_reason ?? ''] ?? 'Revoked'} at{' '}
              {formatTime(d.revoked_at)}.
              {d.pending_count > 0
                ? ` Up to ${d.pending_count} ${d.pending_count === 1 ? 'action was' : 'actions were'} pending on this device and may be lost.`
                : ''}{' '}
              Its unsent actions can never be sent. If it is found, it stays revoked; register it
              again as a new device.
            </span>
          </>
        ) : null}
      </td>
      <td>{d.last_seen_at ? formatTime(d.last_seen_at) : 'never'}</td>
      <td>{d.pending_count}</td>
      <td>
        {d.coordinator_for.length === 0
          ? '—'
          : d.coordinator_for
              .map(
                (c) =>
                  `${c.service_name}${c.expired ? ' (expired)' : c.expiring ? ' (ending soon)' : ''}`,
              )
              .join(', ')}
      </td>
      <td>
        {canAct && !d.revoked_at ? (
          confirm ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor={`rv-${d.id}`}>Reason</label>
                <select
                  id={`rv-${d.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {DEVICE_REVOKE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {REVOKE_REASON_LABEL[r] ?? r}
                    </option>
                  ))}
                </select>
              </div>
              <p className="hint" data-testid="revoke-warning">
                Last contact {d.last_seen_at ? formatTime(d.last_seen_at) : 'never'}.{' '}
                {d.pending_count > 0
                  ? `It reported about ${d.pending_count} unsent ${d.pending_count === 1 ? 'action' : 'actions'}; after revoking they cannot be sent and may be lost. `
                  : ''}
                {d.coordinator_for.length > 0
                  ? 'It is a coordinator: revoking ends that authority and fences it, so its offline actions go to review. '
                  : ''}
                The owner&apos;s sign-in is not ended by this; deactivate or sign out the user if
                needed.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void act('Device revoked', () => api.revokeDevice(d.id, reason))}
                >
                  Confirm revoke<span className="visually-hidden"> {d.label ?? 'device'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirm(false)}
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>
              Revoke<span className="visually-hidden"> {d.label ?? 'device'}</span>
            </button>
          )
        ) : null}
      </td>
    </tr>
  );
}

function ConflictCard({
  c,
  canAct,
  act,
}: {
  c: SyncConflict;
  canAct: boolean;
  act: Act;
}): ReactElement {
  const [reason, setReason] = useState<string>(CONFLICT_RESOLUTION_REASONS[0]);
  const what = `${words(c.action)} ${c.ticket_code ?? c.temporary_ref ?? ''}`.trim();
  return (
    <li className="card" data-testid="conflict">
      <h3 className="card-title">
        {what} <SyncStateIndicator status={SyncStatus.NEEDS_REVIEW} />
      </h3>
      <p>
        From <strong>{c.device_label ?? 'a device'}</strong> ({c.actor_name ?? 'unknown'}) ·{' '}
        {c.service_name} · received {formatTime(c.received_at)}
      </p>
      <p data-testid="conflict-reason">{c.message ?? words(c.reason_code ?? 'needs review')}</p>
      {canAct ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`cr-${c.operation_id}`}>Reason for your decision</label>
            <select
              id={`cr-${c.operation_id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {CONFLICT_RESOLUTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {words(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void act('Applied', () =>
                  api.resolveConflict(c.operation_id, { resolution: 'apply', reason_code: reason }),
                )
              }
            >
              Apply now<span className="visually-hidden"> {what}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                void act('Dismissed', () =>
                  api.resolveConflict(c.operation_id, {
                    resolution: 'dismiss',
                    reason_code: reason,
                  }),
                )
              }
            >
              Dismiss<span className="visually-hidden"> {what}</span>
            </button>
          </div>
          <p className="hint">
            Apply re-checks the action against the queue as it is now; if it still cannot be
            applied, nothing changes and you are told why.
          </p>
        </div>
      ) : (
        <p className="hint">Only a supervisor or facility administrator can resolve this.</p>
      )}
    </li>
  );
}
