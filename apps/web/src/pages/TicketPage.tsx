import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, apiUrl, TICKET_TOKEN_HEADER } from '../lib/api.js';
import { CONFIDENCE_LABEL, formatEstimate, formatTime, STATE_LABEL } from '../lib/format.js';
import { useLiveUpdates } from '../lib/live.js';
import { findTicket, forgetTicket, saveTicket, takeTokenFromHash } from '../lib/tickets.js';
import { useLoad } from '../lib/useLoad.js';
import { Loading } from '../components/Form.js';

/** Live, token-protected ticket status for the visitor (F3 transparency, F6 estimates). */
export function TicketPage(): ReactElement {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as { token?: string; unsaved?: boolean } | null;

  const [token] = useState<string | null>(() => {
    const fromHash = takeTokenFromHash();
    return fromHash ?? navState?.token ?? findTicket(code)?.token ?? null;
  });
  const [storageWarning, setStorageWarning] = useState(Boolean(navState?.unsaved));

  const status = useLoad(
    () => (token ? api.ticketStatus(code, token) : Promise.reject(new Error('no token'))),
    `${code}:${token ?? ''}`,
  );
  const reload = status.reload;
  const headers = useMemo(() => (token ? { [TICKET_TOKEN_HEADER]: token } : null), [token]);
  const live = useLiveUpdates(
    token && status.data ? apiUrl(`/tickets/${encodeURIComponent(code)}/stream`) : null,
    headers,
    useCallback(() => void reload(), [reload]),
  );

  const s = status.data?.status;

  // Remember tickets opened from a staff walk-in link; follow transfers to the new code
  useEffect(() => {
    if (!s || !token) return;
    if (!findTicket(s.public_code)) {
      const ok = saveTicket({
        code: s.public_code,
        token,
        facilityName: s.facility_name,
        serviceName: s.service_name,
        joinPath: findTicket(code)?.joinPath ?? null,
        savedAt: new Date().toISOString(),
      });
      if (!ok) setStorageWarning(true);
    }
    if (s.public_code !== code) {
      forgetTicket(code);
      void navigate(`/ticket/${s.public_code}`, { replace: true });
    }
  }, [s, token, code, navigate]);

  // Assertive announcement when it is the visitor's turn (in addition to the polite status region)
  const lastState = useRef<string | null>(null);
  const [turnAlert, setTurnAlert] = useState('');
  useEffect(() => {
    if (!s) return;
    if (s.state === 'called' && lastState.current && lastState.current !== 'called') {
      setTurnAlert(s.status_message);
      if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
    }
    lastState.current = s.state;
  }, [s]);

  if (!token || (status.error && !s)) {
    return (
      <>
        <h1>Ticket {code}</h1>
        <p role="alert" data-testid="ticket-unavailable">
          This device does not have access to ticket {code}, or the ticket has expired. Ticket
          status is private: only the device that received the ticket (or a link from staff) can
          view it. Please speak to a member of staff.
        </p>
        <p>
          <Link to="/">Back to start</Link>
        </p>
      </>
    );
  }
  if (!s) return <Loading what={`ticket ${code}`} />;

  const called = s.state === 'called';
  return (
    <>
      <div role="alert" aria-live="assertive" className="visually-hidden" data-testid="turn-alert">
        {turnAlert}
      </div>
      <div className="page-head">
        <h1>
          <span className="visually-hidden">Ticket </span>
          <span className="ticket-code ticket-code-xl" data-testid="ticket-code">
            {s.public_code}
          </span>
        </h1>
        <p className="muted">
          {s.service_name} · {s.facility_name}
        </p>
      </div>

      <div className="stack">
        {storageWarning ? (
          <p role="alert" className="alert alert-error" data-testid="storage-warning">
            This browser could not save your ticket. Keep this page open, or write down your ticket
            code {s.public_code} and ask staff if you lose it.
          </p>
        ) : null}

        <section
          aria-labelledby="status-heading"
          className={`card status-card${called ? ' status-called' : ''}`}
        >
          <h2 id="status-heading" className="card-title">
            Status: <span data-testid="ticket-state">{STATE_LABEL[s.state] ?? s.state}</span>
          </h2>
          <p
            role="status"
            aria-live="polite"
            className="status-message"
            data-testid="status-message"
          >
            {s.status_message}
          </p>
          {s.position !== null ? (
            <p data-testid="ticket-position">
              Position: <strong>{s.position + 1}</strong> in line ({s.position} ahead of you)
            </p>
          ) : null}
          {s.counter_name ? (
            <p>
              Counter: <strong data-testid="ticket-counter">{s.counter_name}</strong>
            </p>
          ) : null}
          {s.transferred_from_code ? (
            <p data-testid="transfer-note">
              Your ticket {s.transferred_from_code} was moved to this service. Your original join
              time is kept.
            </p>
          ) : null}
          <p className="meta-row">
            <span>Joined {formatTime(s.joined_at)}</span>
            <span className="badge badge-ok" data-testid="sync-status">
              <span aria-hidden="true">✓ </span>
              {s.sync_status === 'committed' ? 'Confirmed by the server' : s.sync_status}
            </span>
            <span data-testid="live-mode">
              {live === 'live'
                ? 'Live updates'
                : live === 'polling'
                  ? 'Refreshing every 15 s'
                  : 'Connecting…'}
            </span>
          </p>
        </section>

        {s.estimate ? (
          <section aria-labelledby="estimate-heading" className="card">
            <h2 id="estimate-heading" className="card-title">
              Estimated wait
            </h2>
            <p data-testid="estimate-text">
              <strong>{formatEstimate(s.estimate)}</strong>{' '}
              <span className="badge badge-off">{CONFIDENCE_LABEL[s.estimate.confidence]}</span>
            </p>
            <details>
              <summary>How this is estimated</summary>
              <ul data-testid="estimate-factors">
                {s.estimate.factors.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}

        <section aria-labelledby="rules-heading" className="card">
          <h2 id="rules-heading" className="card-title">
            Queue rules
          </h2>
          <p data-testid="policy-summary">{s.policy_summary}</p>
        </section>

        <p className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              forgetTicket(s.public_code);
              void navigate('/');
            }}
          >
            Forget this ticket on this device
          </button>
        </p>
      </div>
    </>
  );
}
