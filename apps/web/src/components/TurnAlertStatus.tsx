import { useEffect, useState, type ReactElement } from 'react';
import type { AlertDeliveryState, StaffSmsAlert, StaffTicketAlerts } from '@queuebridge/contracts';
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

/**
 * M6.1 SMS wording (design §12.6 vocabulary). `sent` is acceptance by the provider; only a
 * provider receipt is "delivered" (REQ-F11.13). Sandbox messages never reach a phone and say so.
 */
export function smsStateText(s: StaffSmsAlert): string {
  if (s.state === 'failed' && s.detail_code === 'cap')
    return 'Text message not sent: daily limit reached';
  if (s.state === 'suppressed' && s.detail_code === 'opted_out') {
    return 'Text message not sent (visitor stopped text messages)';
  }
  if (s.sandbox) {
    if (s.state === 'sent') return 'Test text message accepted (sandbox: nothing sent to a phone)';
    if (s.state === 'delivered') return 'Test receipt received (simulated: no real message)';
  }
  const text: Record<StaffSmsAlert['state'], string> = {
    pending: 'Text message not sent yet',
    sent: 'Text message accepted by the provider, not confirmed',
    delivered: 'Text message delivered (provider receipt)',
    failed: 'Text message failed',
    suppressed: 'Text message not sent (ticket changed)',
    unknown: 'Text message outcome unknown',
  };
  return `${s.sandbox ? 'Test: ' : ''}${text[s.state]}`;
}
const POLL_MS = 10_000;

export function TurnAlertStatus({
  queueId,
  ticketId,
  revision,
  reachable,
  canStopSms = false,
}: {
  queueId: string;
  ticketId: string;
  revision: number;
  reachable: boolean;
  /** WALK_IN roles may stop SMS for the visitor at the desk (the API checks again) */
  canStopSms?: boolean;
}): ReactElement {
  const [entry, setEntry] = useState<StaffTicketAlerts | null | 'error'>(null);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsNote, setSmsNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
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
  }, [queueId, ticketId, revision, reachable, tick]);
  const devices = entry && entry !== 'error' ? entry.devices : [];
  const sms = entry && entry !== 'error' ? entry.sms : null;
  const smsActive = entry && entry !== 'error' ? entry.sms_active === true : false;
  async function stopSms(): Promise<void> {
    setSmsBusy(true);
    setSmsNote(null);
    try {
      await api.staffStopSms(queueId, ticketId);
      setSmsNote('Text messages stopped for this visitor. Their number has been deleted.');
      setTick((n) => n + 1);
    } catch {
      setSmsNote('Text messages could not be stopped. Try again.');
    } finally {
      setSmsBusy(false);
    }
  }
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
      {sms ? (
        <p data-testid="sms-alert-status" data-state={sms.state}>
          <strong>Text message: </strong>
          {smsStateText(sms)}
        </p>
      ) : null}
      {smsActive && canStopSms && reachable ? (
        <button
          type="button"
          className="btn"
          disabled={smsBusy}
          onClick={() => void stopSms()}
          data-testid="staff-stop-sms"
        >
          {smsBusy ? 'Stopping…' : 'Stop text messages'}
        </button>
      ) : null}
      {smsNote ? <p role="status">{smsNote}</p> : null}
      <p>The public board and calling aloud remain the reliable fallback.</p>
    </div>
  );
}
