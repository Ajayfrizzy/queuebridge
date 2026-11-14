import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { uuidv7, type TicketStatus } from '@queuebridge/contracts';
import { useAnnounce } from '../components/Announcer.js';
import {
  DisplaySettingsButton,
  raiseUrgentAlert,
  useA11yPrefs,
} from '../components/DisplaySettings.js';
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel.js';
import { cuesFor } from '../lib/a11yPrefs.js';
import { POSITION_THROTTLE_MS } from '../lib/announcePolicy.js';
import { api, apiUrl, ApiRequestError, TICKET_TOKEN_HEADER } from '../lib/api.js';
import { discardRecoveryKey, peekRecoveryKey, stashRecoveryKey } from '../lib/recoveryKey.js';
import { CONFIDENCE_LABEL, formatEstimate, formatTime, STATE_LABEL } from '../lib/format.js';
import { useLiveUpdates } from '../lib/live.js';
import {
  findTicketById,
  findTicketByToken,
  forgetTicket,
  dropSnapshot,
  loadSnapshot,
  saveSnapshot,
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
    // A staff walk-in link may also carry the recovery key (fragment only; kept in memory)
    const explicit =
      takeTokenFromHash((k) => stashRecoveryKey({ code, key: k, path: '' })) ??
      navState?.token ??
      null;
    if (explicit) return { token: explicit, ambiguous: [] as StoredTicket[] };
    const saved = resolveSaved(code, localId);
    if (saved === 'ambiguous') return { token: null, ambiguous: ticketsWithCode(code) };
    return { token: saved?.token ?? null, ambiguous: [] as StoredTicket[] };
  });
  const token = initial.token;
  const [storageWarning, setStorageWarning] = useState(Boolean(navState?.unsaved));

  // The saved ticket this page shows (the offline copy is kept per saved ticket)
  const snapshotId =
    (localId ? findTicketById(localId) : undefined)?.id ??
    (token ? findTicketByToken(token)?.id : undefined);
  const status = useLoad(
    async (): Promise<{ status: TicketStatus; cachedAt: string | null }> => {
      if (!token) throw new Error('no token');
      try {
        const r = await api.ticketStatus(code, token);
        if (snapshotId) saveSnapshot(snapshotId, r.status);
        return { status: r.status, cachedAt: null };
      } catch (e) {
        // A refusal means this device no longer has access: the stored copy goes too, so it can
        // never be shown (even offline, later) after the server withdrew access
        if (
          snapshotId &&
          e instanceof ApiRequestError &&
          (e.status === 401 || e.status === 403 || e.status === 404)
        ) {
          dropSnapshot(snapshotId);
        }
        // Only an unreachable server falls back to the last copy; refusals are never masked
        if (e instanceof ApiRequestError && e.status === 0 && snapshotId) {
          const snap = loadSnapshot(snapshotId);
          if (snap) return { status: snap.status, cachedAt: snap.at };
        }
        throw e;
      }
    },
    `${code}:${token ?? ''}`,
  );
  const cachedAt = status.data?.cachedAt ?? null;
  const reload = status.reload;
  const headers = useMemo(() => (token ? { [TICKET_TOKEN_HEADER]: token } : null), [token]);
  const live = useLiveUpdates(
    token && status.data ? apiUrl(`/tickets/${encodeURIComponent(code)}/stream`) : null,
    headers,
    useCallback(() => void reload(), [reload]),
  );

  const s = status.data?.status;
  const [savedId, setSavedId] = useState<string | null>(localId);
  const announce = useAnnounce();
  const { prefs, support } = useA11yPrefs();
  // M5.1: a key shown once (after joining, a walk-in link, or a replacement); memory only
  const [fresh, setFresh] = useState<{ key: string; path: string } | null>(null);
  const [keyDismissed, setKeyDismissed] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState<{ text: string; error: boolean } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [rejoinBusy, setRejoinBusy] = useState(false);
  const joinKey = s ? peekRecoveryKey(s.public_code) : null;
  const shownKey =
    fresh ??
    (joinKey && !keyDismissed
      ? { key: joinKey.key, path: joinKey.path || (s?.recovery.recovery_path ?? '') }
      : null);

  async function runRecovery(
    work: () => Promise<{ text: string; key?: { key: string; path: string } | null }>,
  ): Promise<void> {
    setRecoveryBusy(true);
    setRecoveryNote(null);
    try {
      const r = await work();
      if (r.key) setFresh(r.key);
      setRecoveryNote({ text: r.text, error: false });
      announce(r.text);
      await reload();
    } catch (e) {
      const text =
        e instanceof ApiRequestError && e.status === 404
          ? 'This device no longer has access to the ticket.'
          : e instanceof ApiRequestError
            ? e.message
            : 'The request could not be completed.';
      setRecoveryNote({ text, error: true });
      announce(text);
    } finally {
      setRecoveryBusy(false);
    }
  }
  const newKey = (): Promise<void> =>
    runRecovery(async () => {
      const r = await api.newRecoveryKey(code, token ?? '');
      discardRecoveryKey();
      return {
        text: 'A new recovery key was created. The old key no longer works.',
        key: { key: r.recovery_key, path: r.recovery_path },
      };
    });
  const signOutOthers = (): Promise<void> =>
    runRecovery(async () => {
      const r = await api.signOutOtherDevices(code, token ?? '');
      discardRecoveryKey();
      return {
        text:
          r.revoked_tokens > 0
            ? `Signed out ${r.revoked_tokens} other ${r.revoked_tokens === 1 ? 'device' : 'devices'}. Their access to this ticket has ended.`
            : 'No other device had access to this ticket.',
        key: r.recovery_key ? { key: r.recovery_key, path: r.recovery_path } : null,
      };
    });
  async function rejoin(): Promise<void> {
    setRejoinBusy(true);
    try {
      const r = await api.rejoin(code, token ?? '', uuidv7());
      const text =
        r.outcome.disposition === 'rejected'
          ? 'You could not be returned to the queue. Please speak to a member of staff.'
          : 'You are back in the queue.';
      setRecoveryNote({ text, error: r.outcome.disposition === 'rejected' });
      announce(text);
    } catch (e) {
      const text =
        e instanceof ApiRequestError
          ? e.status === 409
            ? 'The time to return to the queue has passed. Please join again or ask a member of staff.'
            : e.message
          : 'The request could not be completed.';
      setRecoveryNote({ text, error: true });
      announce(text);
    } finally {
      setRejoinBusy(false);
      await reload();
    }
  }
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

  // Assertive announcement when it is the visitor's turn (in addition to the polite status region).
  // Once per call: refreshes and live-update replays with the same state change nothing here.
  // Vibration follows the device-local preferences (quiet mode, the vibration switch, support).
  const lastState = useRef<string | null>(null);
  const [turnAlert, setTurnAlert] = useState('');
  useEffect(() => {
    if (!s) return;
    if (s.state === 'called' && lastState.current && lastState.current !== 'called') {
      raiseUrgentAlert(); // never hidden behind the settings dialog
      setTurnAlert(s.status_message);
      if (cuesFor(prefs, support).vibration) navigator.vibrate?.([200, 100, 200]);
    }
    lastState.current = s.state;
  }, [s, prefs, support]);

  // Position changes are announced politely, at most once every 15 seconds, only when the value
  // actually changed (never on the first load, never for a refresh that changed nothing).
  const lastPosition = useRef<number | null | undefined>(undefined);
  const position = s?.position;
  useEffect(() => {
    if (s === undefined) return;
    const prev = lastPosition.current;
    lastPosition.current = position ?? null;
    if (
      prev === undefined ||
      prev === (position ?? null) ||
      position === null ||
      position === undefined
    ) {
      return;
    }
    announce(
      position === 0
        ? 'You are next in line.'
        : `You are now number ${position + 1} in line, ${position} ahead of you.`,
      { throttleKey: 'position', throttleMs: POSITION_THROTTLE_MS },
    );
  }, [s, position, announce]);

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
          <Link to="/recover" data-testid="recover-link">
            I have a recovery key
          </Link>
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
        <p>
          <DisplaySettingsButton />
        </p>
      </div>

      <div className="stack">
        {storageWarning ? (
          <p role="alert" className="alert alert-error" data-testid="storage-warning">
            This browser could not save your ticket. Keep this page open, or write down your ticket
            code {s.public_code} and ask staff if you lose it.
          </p>
        ) : null}

        {cachedAt ? (
          <p role="status" className="alert alert-info" data-testid="ticket-offline-copy">
            You are offline. This is the last information we confirmed at {formatTime(cachedAt)}. It
            may be out of date. It will update when you are back online.
          </p>
        ) : null}

        {s.recovery.access_granted_elsewhere_at ? (
          <p role="status" className="alert alert-info" data-testid="access-elsewhere">
            Access to this ticket was given to another device at{' '}
            {formatTime(s.recovery.access_granted_elsewhere_at)}. If that was not you, use “Sign out
            other devices” below.
          </p>
        ) : null}

        {shownKey ? (
          <RecoveryKeyPanel
            facilityName={s.facility_name}
            code={s.public_code}
            recoveryKey={shownKey.key}
            path={shownKey.path}
            onDone={() => {
              setFresh(null);
              setKeyDismissed(true);
              discardRecoveryKey();
              // The button that had focus is about to disappear: keep focus on this page's heading
              // instead of dropping it to the top of the document (WCAG 2.4.3)
              requestAnimationFrame(() => document.querySelector<HTMLElement>('#main h1')?.focus());
            }}
          />
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
          {called && s.recovery.auto_miss_after_seconds !== null ? (
            <p data-testid="auto-miss-rule">
              If you do not respond within {s.recovery.auto_miss_after_seconds} seconds of being
              called, this ticket may be marked as missed.
            </p>
          ) : null}
          {s.state === 'missed' ? (
            <div data-testid="missed-help">
              {s.recovery.rejoin_available ? (
                <>
                  <p>
                    You can still return to the queue
                    {s.recovery.grace_ends_at
                      ? ` until ${formatTime(s.recovery.grace_ends_at)}`
                      : ' for a short time'}
                    .
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={rejoinBusy}
                    onClick={() => void rejoin()}
                  >
                    {rejoinBusy ? 'Returning…' : 'I am here, return me to the queue'}
                  </button>
                </>
              ) : (
                <p>Your turn was missed. Please ask a member of staff, or join the queue again.</p>
              )}
            </div>
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

        {s.recovery.self_service_available ? (
          <section aria-labelledby="keep-heading" className="card" data-testid="keep-safe">
            <h2 id="keep-heading" className="card-title">
              Keep this ticket safe
            </h2>
            <p>
              If you lose this device you can get your ticket back with your recovery key. If your
              key is lost or someone else may have it, make a new one. Your place in the queue does
              not change.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={recoveryBusy}
                onClick={() => void newKey()}
              >
                Get a new recovery key
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={recoveryBusy}
                onClick={() => void signOutOthers()}
              >
                Sign out other devices
              </button>
            </div>
            {recoveryNote ? (
              <p
                role={recoveryNote.error ? 'alert' : 'status'}
                className={recoveryNote.error ? 'alert alert-error' : 'alert alert-success'}
                data-testid="recovery-note"
              >
                {recoveryNote.text}
              </p>
            ) : null}
          </section>
        ) : (
          <p className="muted" data-testid="recovery-unavailable">
            Self-service recovery is not available here. If you lose this device, ask a member of
            staff.
          </p>
        )}

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
