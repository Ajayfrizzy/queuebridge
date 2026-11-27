import { useState, type ReactElement } from 'react';
import type { SmsAlertState } from '@queuebridge/contracts';
import { useAnnounce } from './Announcer.js';
import { api, ApiRequestError } from '../lib/api.js';

/**
 * M6.1: the visitor's SMS turn alert on the ticket page, with opt-out (REQ-F11.9). Shown only
 * when the visitor gave a number. It never claims a message arrived (REQ-F11.13).
 */
export function TicketSmsPanel({
  code,
  token,
  state,
  sandbox,
  offline,
  onChanged,
}: {
  code: string;
  token: string | null;
  state: SmsAlertState | undefined;
  sandbox: boolean;
  offline: boolean;
  onChanged: () => void;
}): ReactElement | null {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state !== 'on' && state !== 'off') return null;
  async function stop(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopSms(code, token);
      announce('Text messages stopped for this ticket. Your number has been deleted.');
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 0
          ? 'You are offline. Text messages can be stopped when you are back online.'
          : 'Text messages could not be stopped. Please try again or ask a member of staff.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="sms-heading" className="card" data-testid="ticket-sms">
      <h2 id="sms-heading" className="card-title">
        Text message alert
      </h2>
      {state === 'on' ? (
        <>
          <p data-testid="sms-state">Text message alert is on for this ticket.</p>
          {sandbox ? (
            <p className="alert alert-info" data-testid="sms-test-mode">
              Test mode: no real text messages are sent here.
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={busy || offline || !token}
            onClick={() => void stop()}
          >
            {busy ? 'Stopping…' : 'Stop text messages'}
          </button>
          {offline ? <p className="hint">Stopping text messages needs a connection.</p> : null}
        </>
      ) : (
        <p data-testid="sms-state">
          Text message alert is off for this ticket. Your number has been deleted.
        </p>
      )}
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
