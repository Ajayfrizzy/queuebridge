import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { turnAlertPath } from '@queuebridge/contracts';
import { parseHandoff, type TurnAlertHandoff } from '../lib/turnAlert.js';

/**
 * Receives push hand-offs from the service worker while a QueueBridge window is focused (design
 * §12.5.5, §12.5.7). The message is re-dispatched as a cancelable `qb:turn-alert` window event:
 * the ticket page claims it (calls `preventDefault`) only when the reference is the push
 * reference of the ticket it shows, then reloads the COMMITTED status from the server, which is
 * what raises its in-app alert. Unclaimed hand-offs (another page, another ticket) show a
 * non-blocking notice with a link built from the reference. The message holds no credential.
 */
export const TURN_ALERT_EVENT = 'qb:turn-alert';

export function PushHandoff(): ReactElement | null {
  const [notice, setNotice] = useState<TurnAlertHandoff | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw || typeof sw.addEventListener !== 'function') return undefined;
    const onMessage = (e: MessageEvent): void => {
      const h = parseHandoff(e.data);
      if (!h) return;
      const ev = new CustomEvent<TurnAlertHandoff>(TURN_ALERT_EVENT, {
        detail: h,
        cancelable: true,
      });
      window.dispatchEvent(ev);
      if (!ev.defaultPrevented) setNotice(h);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, []);

  if (!notice) return null;
  return (
    <div className="container">
      <div
        ref={noticeRef}
        role="status"
        className="alert alert-info"
        data-testid="push-handoff-notice"
      >
        <p>
          An alert arrived for ticket <strong>{notice.code}</strong>
          {notice.counter ? ` (${notice.counter})` : ''}.{' '}
          <Link to={turnAlertPath(notice.code, notice.ref)} onClick={() => setNotice(null)}>
            Open ticket {notice.code}
          </Link>
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
