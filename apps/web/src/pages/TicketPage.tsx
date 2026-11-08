import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiUrl, TICKET_TOKEN_HEADER } from '../lib/api.js';
import { CONFIDENCE_LABEL, formatEstimate, formatTime, STATE_LABEL } from '../lib/format.js';
import { useLiveUpdates } from '../lib/live.js';
import {
  findTicketById,
  findTicketByToken,
  forgetTicket,
  saveTicket,
  takeTokenFromHash,
  ticketPath,
  ticketsWithCode,
  type StoredTicket,
} from '../lib/tickets.js';
import { useLoad } from '../lib/useLoad.js';
import { Loading } from '../components/Form.js';

/**
 * Which saved ticket this URL refers to. Public codes repeat across queues, so the device-local
 * id (`?k=`) decides; a bare `/ticket/:code` is only unambiguous if one saved ticket has the code.
 */
function resolveSaved(code: string, localId: string | null): StoredTicket | 'ambiguous' | null {
  if (localId) return findTicketById(localId) ?? null;
  const matches = ticketsWithCode(code);
  if (matches.length > 1) return 'ambiguous';
  return matches[0] ?? null;
}

/**
 * Live, token-protected ticket status for the visitor (F3 transparency, F6 estimates).
 * Keyed by code + local id: moving between two saved tickets (e.g. from the chooser, or two
 * tickets sharing a code) must re-resolve the token instead of reusing the previous ticket's state.
 */
export function TicketPage(): ReactElement {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  return <TicketView key={`${code}?${search.get('k') ?? ''}`} />;
}

function TicketView(): ReactElement {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  const localId = search.get('k');
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as { token?: string; unsaved?: boolean } | null;

  const [initial] = useState(() => {
    const explicit = takeTokenFromHash() ?? navState?.token ?? null;
    if (explicit) return { token: explicit, ambiguous: [] as StoredTicket[] };
    const saved = resolveSaved(code, localId);
    if (saved === 'ambiguous') return { token: null, ambiguous: ticketsWithCode(code) };
    return { token: saved?.token ?? null, ambiguous: [] as StoredTicket[] };
  });
  const token = initial.token;
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
  const [savedId, setSavedId] = useState<string | null>(localId);

  // Remember tickets opened from a staff walk-in link (or update the saved entry: a replayed
  // walk-in rotates the token, a transfer changes the code) and keep the URL on its local id.
  useEffect(() => {
    if (!s || !token) return;
    const existing = (savedId ? findTicketById(savedId) : undefined) ?? findTicketByToken(token);
    let entry: StoredTicket | null | undefined = existing;
    if (!existing || existing.code !== s.public_code || existing.token !== token) {
      entry = saveTicket({
        id: existing?.id,
        code: s.public_code,
        token,
        facilityName: s.facility_name,
        serviceName: s.service_name,
        joinPath: existing?.joinPath ?? null,
        savedAt: existing?.savedAt ?? new Date().toISOString(),
      });
      if (!entry) setStorageWarning(true);
    }
    if (entry) {
      if (entry.id !== savedId) setSavedId(entry.id);
      if (entry.code !== code || entry.id !== localId) {
        void navigate(ticketPath(entry), { replace: true });
      }
    } else if (s.public_code !== code) {
      void navigate(`/ticket/${encodeURIComponent(s.public_code)}`, {
        replace: true,
        state: { token, unsaved: true },
      });
    }
  }, [s, token, code, localId, savedId, navigate]);

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

  if (!token && initial.ambiguous.length > 1) {
    return (
      <>
        <h1>Ticket {code}</h1>
        <p>This device has more than one ticket {code}. Choose the one you want to see:</p>
        <ul data-testid="ticket-choices">
          {initial.ambiguous.map((t) => (
            <li key={t.id}>
              <Link to={ticketPath(t)}>
                {t.code} — {t.serviceName} · {t.facilityName}
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  }
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
              const id = savedId ?? findTicketByToken(token)?.id;
              if (id) forgetTicket(id);
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
