import { useEffect, useRef, type ReactElement } from 'react';
import type { AlertEvaluation, HealthAlert } from '@queuebridge/contracts';
import { useAnnounce } from './Announcer.js';
import { alertAdvice, alertTitle, SEVERITY_LABEL } from '../lib/healthText.js';
import { formatTime } from '../lib/format.js';

/**
 * Automatic device-health alerts for one facility (REQ-F9.7, F9.8, F9.14). In-product only.
 * Alerts recommend; they never act. Acknowledging records that someone has seen an alert; it
 * resolves by itself once the condition has cleared (twice).
 */
export function HealthAlertsPanel({
  alerts,
  evaluation,
  canAcknowledge,
  onAcknowledge,
}: {
  alerts: HealthAlert[];
  evaluation: AlertEvaluation;
  canAcknowledge: boolean;
  onAcknowledge: (a: HealthAlert) => void;
}): ReactElement {
  const announce = useAnnounce();
  const open = alerts.filter((a) => a.status === 'open');
  const acknowledged = alerts.filter((a) => a.status === 'acknowledged');
  const resolved = alerts.filter((a) => a.status === 'resolved');

  // A NEW high-severity alert is announced (politely: it is important, not a blocking error).
  // The first load announces nothing; afterwards each new alert id is announced once.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(alerts.map((a) => a.id));
    if (seen.current === null) {
      seen.current = ids;
      return;
    }
    const fresh = alerts.filter(
      (a) => a.status === 'open' && a.severity === 'high' && !seen.current?.has(a.id),
    );
    for (const a of fresh) announce(`New high-priority alert: ${alertTitle(a)}.`);
    seen.current = ids;
  }, [alerts, announce]);

  return (
    <section aria-labelledby="alerts-heading" className="card" data-testid="health-alerts">
      <h2 id="alerts-heading" className="card-title">
        Alerts ({open.length} open)
      </h2>
      <p className="hint" data-testid="alerts-evaluated">
        {evaluation.last_evaluated_at
          ? `Alerts last checked at ${formatTime(evaluation.last_evaluated_at)}.`
          : 'Alerts have not been checked yet.'}{' '}
        Device states below are always current; alerts are shown here only, never sent by SMS or
        email.
      </p>
      {evaluation.paused ? (
        <p role="status" className="alert alert-warn" data-testid="alerts-paused">
          <strong>Automatic alerts are paused</strong>: they have not been checked for more than{' '}
          {Math.round((3 * evaluation.interval_seconds) / 60) || 1} min. The device states below are
          still current, but new problems may not appear here as alerts.
        </p>
      ) : null}
      {evaluation.config_mismatch.length > 0 ? (
        <p role="status" className="alert alert-warn" data-testid="config-mismatch">
          <strong>Settings differ between the server and the alert worker</strong>:{' '}
          {evaluation.config_mismatch.join(', ')}. Alerts may be raised at different times than
          shown here. An administrator should give both the same values and restart them.
        </p>
      ) : null}
      {open.length === 0 && acknowledged.length === 0 ? (
        <p className="muted" data-testid="no-alerts">
          No open alerts.
        </p>
      ) : null}
      {open.length + acknowledged.length > 0 ? (
        <ul className="card-list" data-testid="alert-list">
          {[...open, ...acknowledged].map((a) => (
            <AlertItem
              key={a.id}
              a={a}
              canAcknowledge={canAcknowledge}
              onAcknowledge={onAcknowledge}
            />
          ))}
        </ul>
      ) : null}
      {!canAcknowledge && open.length > 0 ? (
        <p className="hint" data-testid="alerts-read-only">
          You can see these alerts. A supervisor or facility administrator acknowledges them.
        </p>
      ) : null}
      {resolved.length > 0 ? (
        <details>
          <summary>Resolved in the last 24 hours ({resolved.length})</summary>
          <ul className="plain-list" data-testid="resolved-alerts">
            {resolved.map((a) => (
              <li key={a.id}>
                {alertTitle(a)}: resolved at {formatTime(a.resolved_at ?? a.last_seen_at)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function AlertItem({
  a,
  canAcknowledge,
  onAcknowledge,
}: {
  a: HealthAlert;
  canAcknowledge: boolean;
  onAcknowledge: (a: HealthAlert) => void;
}): ReactElement {
  const sev = SEVERITY_LABEL[a.severity];
  const titleId = `alert-${a.id}`;
  return (
    <li
      className={`card alert-item alert-sev-${a.severity}`}
      data-testid="alert-item"
      data-kind={a.kind}
      data-status={a.status}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="card-title">
        <span className="badge badge-off">
          <span aria-hidden="true">{sev.symbol} </span>
          {sev.text}
        </span>{' '}
        {alertTitle(a)}
      </h3>
      <p>{alertAdvice(a)}</p>
      <p className="meta-row muted">
        <span>Since {formatTime(a.opened_at)}</span>
        <span>Last confirmed {formatTime(a.last_seen_at)}</span>
        {a.status === 'acknowledged' ? (
          <span data-testid="alert-acknowledged">
            Acknowledged by {a.acknowledged_by_name ?? 'a supervisor'}
            {a.acknowledged_at ? ` at ${formatTime(a.acknowledged_at)}` : ''}
          </span>
        ) : null}
      </p>
      {canAcknowledge && a.status === 'open' ? (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => onAcknowledge(a)}>
            Acknowledge<span className="visually-hidden"> alert: {alertTitle(a)}</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}
