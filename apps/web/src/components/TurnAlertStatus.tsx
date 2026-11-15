import { useEffect, useState, type ReactElement } from 'react';
import type { AlertDeliveryState, StaffTicketAlerts } from '@queuebridge/contracts';
import { api } from '../lib/api.js';

/**
 * Staff view of the visitor's push turn alert for the ticket called at this counter (design
 * §12.6). Plain words per device, never a delivery claim the server cannot back: `sent` means the
 * push service accepted it, only the visitor's page can confirm it was seen. The reliable
 * fallback is always stated, because nothing about a push alert changes what staff should do.
 */
export const ALERT_STATE_TEXT: Record<AlertDeliveryState, string> = {
  pending: 'Push not sent yet',
  sent: 'Push sent, not confirmed',
  delivered: 'Seen on device',
  failed: 'Push failed',
  suppressed: 'Alert not sent (ticket changed)',
  unknown: 'Push outcome unknown',
};

const POLL_MS = 10_000;

export function TurnAlertStatus({
  queueId,
  ticketId,
  revision,
  reachable,
}: {
  queueId: string;
  ticketId: string;
  revision: number;
  reachable: boolean;
}): ReactElement {
  const [entry, setEntry] = useState<StaffTicketAlerts | null | 'error'>(null);
  useEffect(() => {
    if (!reachable) return undefined;
    let alive = true;
    const load = (): void => {
      api
        .queueAlerts(queueId)
        .then((r) => {
          if (alive) setEntry(r.alerts.find((a) => a.ticket_id === ticketId) ?? null);
        })
        .catch(() => {
          if (alive) setEntry('error');
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [queueId, ticketId, revision, reachable]);

  const devices = entry && entry !== 'error' ? entry.devices : [];
  return (
    <div className="hint" data-testid="turn-alert-status">
      <p>
        <strong>Visitor alert: </strong>
        {!reachable || entry === 'error' ? (
          <span>Push alert state is not available right now.</span>
        ) : devices.length === 0 ? (
          <span data-testid="turn-alert-none">No push alert for this ticket.</span>
        ) : devices.length === 1 && devices[0] ? (
          <span data-testid="turn-alert-device" data-state={devices[0].state}>
            {ALERT_STATE_TEXT[devices[0].state]}
          </span>
        ) : null}
      </p>
      {devices.length > 1 ? (
        <ul className="plain-list">
          {devices.map((d, i) => (
            <li key={d.subscription_ref} data-testid="turn-alert-device" data-state={d.state}>
              Device {i + 1}: {ALERT_STATE_TEXT[d.state]}
            </li>
          ))}
        </ul>
      ) : null}
      <p>The public board and calling aloud remain the reliable fallback.</p>
    </div>
  );
}
