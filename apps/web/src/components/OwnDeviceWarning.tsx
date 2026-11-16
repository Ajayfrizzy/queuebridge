import { useEffect, useState, type ReactElement } from 'react';
import type { OwnDeviceHealth } from '@queuebridge/contracts';
import { api } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { OWN_WARNING_TEXT } from '../lib/healthText.js';

const POLL_MS = 30_000;

/**
 * A non-blocking warning about THIS device on the staff console (REQ-F9.8). Computed by the
 * server from its own clock. While offline the last warnings stay visible with the time they were
 * checked (they may be out of date). Dismissing hides the current set until it changes.
 */
export function OwnDeviceWarning({
  deviceId,
  reachable,
}: {
  deviceId: string | null;
  reachable: boolean;
}): ReactElement | null {
  const [health, setHealth] = useState<OwnDeviceHealth | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId || !reachable) return undefined;
    let stop = false;
    const load = (): void => {
      api
        .ownDeviceHealth(deviceId)
        .then((r) => {
          if (!stop) setHealth(r.device);
        })
        .catch(() => undefined); // revoked or offline: handled by the connectivity bar
    };
    load();
    const t = setInterval(load, POLL_MS);
    return (): void => {
      stop = true;
      clearInterval(t);
    };
  }, [deviceId, reachable]);

  if (!health || health.device_id !== deviceId || health.warnings.length === 0) return null;
  const key = health.warnings.map((w) => `${w.kind}:${w.queue_id ?? ''}`).join('|');
  if (dismissed === key) return null;
  return (
    <section
      aria-labelledby="own-device-warning-title"
      className="alert alert-warn"
      data-testid="own-device-warning"
    >
      <h2 id="own-device-warning-title" className="alert-title">
        <span aria-hidden="true">■ </span>About this device
      </h2>
      <ul className="plain-list">
        {health.warnings.map((w) => (
          <li key={`${w.kind}:${w.queue_id ?? ''}`} data-kind={w.kind}>
            {OWN_WARNING_TEXT[w.kind](w.service_name)}
            {w.expires_at
              ? ` (${w.kind === 'coordinator_expired' ? 'ended' : 'ends'} at ${formatTime(w.expires_at)})`
              : ''}
          </li>
        ))}
      </ul>
      {!reachable ? (
        <p className="hint" data-testid="own-device-warning-stale">
          You are offline. Last checked at {formatTime(health.server_time)}; this may be out of
          date.
        </p>
      ) : null}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => setDismissed(key)}>
          Hide<span className="visually-hidden"> warning about this device</span>
        </button>
      </div>
    </section>
  );
}
