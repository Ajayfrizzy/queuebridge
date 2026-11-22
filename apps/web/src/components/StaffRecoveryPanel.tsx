import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  RecoveryReasonCode,
  RecoveryRequestStatus,
  RecoveryRequestSummary,
} from '@queuebridge/contracts';
import { api, ApiRequestError } from '../lib/api.js';
import { useQr } from '../lib/useQr.js';
import { qrPath, QUIET_ZONE } from '../lib/qrSvg.js';
import { formatTime } from '../lib/format.js';
import { useAnnounce } from './Announcer.js';
import { Field } from './Form.js';

interface TicketChoice {
  id: string;
  public_code: string;
}

interface Props {
  queueId: string;
  tickets: TicketChoice[];
  /** Supervisors and facility admins (QUEUE_MANAGE): may approve other people's requests */
  canApprove: boolean;
  /** Offline or otherwise unable to reach the server: the procedure is online-only */
  disabled: boolean;
}

const REASONS: { value: RecoveryReasonCode; label: string }[] = [
  { value: 'lost_device', label: 'Lost or broken phone' },
  { value: 'cleared_browser', label: 'Cleared browser or changed phone' },
  { value: 'no_smartphone', label: 'Has no smartphone' },
  { value: 'other', label: 'Another reason' },
];

interface Active {
  requestId: string;
  ticketId: string;
  code: string;
  grant: string;
  expiresAt: string;
  status: RecoveryRequestStatus;
}

/**
 * Staff-assisted ticket recovery (REQ-F4.11, design §15.5a). A RESTRICTED procedure:
 *  - being at the desk and knowing the public code prove nothing;
 *  - the staff member records whether the visitor named the service and approximate join time
 *    BEFORE seeing them. Without that, no credential is created;
 *  - with it, a DIFFERENT supervisor must approve;
 *  - the grant is single use, expires in 10 minutes and is redeemed on the visitor's own device
 *    from a QR code. It is never shown to staff as readable text.
 */
export function StaffRecoveryPanel({
  queueId,
  tickets,
  canApprove,
  disabled,
}: Props): ReactElement {
  const announce = useAnnounce();
  const [ticketId, setTicketId] = useState('');
  const [reason, setReason] = useState<RecoveryReasonCode>('lost_device');
  const [matches, setMatches] = useState(false);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [pending, setPending] = useState<RecoveryRequestSummary[]>([]);
  const noteRef = useRef<HTMLDivElement>(null);

  const say = useCallback(
    (text: string, error = false): void => {
      setNote({ text, error });
      announce(text);
    },
    [announce],
  );

  // Approvers: the open requests for this facility (refreshed while the panel is on screen)
  useEffect(() => {
    if (!canApprove || disabled) return;
    let stop = false;
    const load = async (): Promise<void> => {
      try {
        const r = await api.recoveryRequests(queueId);
        if (!stop) setPending(r.requests.filter((x) => x.status === 'pending'));
      } catch {
        // transient: the next tick retries
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [canApprove, disabled, queueId]);

  // The requester waits for approval (poll the request's status)
  useEffect(() => {
    if (!active || active.status === 'approved' || active.status === 'redeemed') return;
    if (active.status === 'expired') return;
    const timer = setInterval(() => {
      api
        .recoveryRequestStatus(queueId, active.ticketId, active.requestId)
        .then((r) => {
          setActive((a) =>
            a && a.requestId === active.requestId ? { ...a, status: r.status } : a,
          );
          if (r.status === 'approved') {
            announce(`Recovery for ${active.code} approved. The visitor can scan the code now.`);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [active, queueId, announce]);

  async function start(): Promise<void> {
    if (!ticketId) {
      say('Choose the ticket first.', true);
      return;
    }
    setBusy(true);
    setNote(null);
    setActive(null);
    try {
      const r = await api.recoveryAssist(queueId, ticketId, {
        reason_code: reason,
        account_matches: matches,
        asked_before_revealing: true,
      });
      if (r.outcome === 'restricted_assistance') {
        say(
          'No credential can be given. The visitor could not confirm the service and approximate join time. Help them in person (for example, tell them the queue is moving), or ask them to join again.',
        );
      } else {
        const code = tickets.find((t) => t.id === ticketId)?.public_code ?? '';
        setActive({
          requestId: r.request_id,
          ticketId,
          code,
          grant: r.grant,
          expiresAt: r.expires_at,
          status: 'pending',
        });
        say(`Request for ${code} created. A different supervisor must approve it.`);
      }
    } catch (e) {
      say(
        e instanceof ApiRequestError
          ? e.status === 429
            ? 'Too many recovery requests for this ticket or from you. Wait and try again.'
            : e.message
          : 'The request could not be completed.',
        true,
      );
    } finally {
      // The answers belong to this visitor and this request only: the next request asks again
      // (manual check 10: kept ticks were silently reused for the next visitor)
      setAsked(false);
      setMatches(false);
      setBusy(false);
      noteRef.current?.focus();
    }
  }

  async function approve(r: RecoveryRequestSummary): Promise<void> {
    setBusy(true);
    try {
      await api.recoveryApprove(queueId, r.ticket_id, r.request_id);
      setPending((p) => p.filter((x) => x.request_id !== r.request_id));
      say(`Approved recovery for ${r.public_code}.`);
    } catch (e) {
      const gone = e instanceof ApiRequestError && (e.status === 404 || e.status === 409);
      if (gone) {
        // Expired, already decided, or no longer part of this queue: drop it and refresh the list
        setPending((p) => p.filter((x) => x.request_id !== r.request_id));
        void api
          .recoveryRequests(queueId)
          .then((l) => setPending(l.requests.filter((x) => x.status === 'pending')))
          .catch(() => undefined);
      }
      say(
        gone
          ? `The request for ${r.public_code} can no longer be approved here: it has expired, was already decided, or belongs to another queue. Ask for a new request if the visitor still needs help.`
          : e instanceof ApiRequestError
            ? e.message
            : 'The approval failed.',
        true,
      );
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll(): Promise<void> {
    if (!ticketId) {
      say('Choose the ticket first.', true);
      return;
    }
    setBusy(true);
    try {
      const r = await api.recoveryRevokeAll(queueId, ticketId, { reason_code: 'lost_device' });
      say(
        `Signed out ${r.revoked_tokens} ${r.revoked_tokens === 1 ? 'device' : 'devices'} and removed the recovery key, because it may be in the wrong hands. Use “Start recovery” to give the visitor access again.`,
      );
    } catch (e) {
      say(e instanceof ApiRequestError ? e.message : 'The request failed.', true);
    } finally {
      setBusy(false);
    }
  }

  const { matrix: grantQr, feedback } = useQr(
    active?.status === 'approved' ? `${window.location.origin}/recover#g=${active.grant}` : null,
  );
  const total = grantQr ? grantQr.size + QUIET_ZONE * 2 : 0;

  return (
    <section aria-labelledby="recovery-heading" className="card" data-testid="staff-recovery">
      <h2 id="recovery-heading" className="card-title">
        Help a visitor get their ticket back
      </h2>
      <p className="hint">
        Being at the desk and knowing the ticket code do not prove who someone is. First ask the
        visitor which service they joined and roughly when. Do not tell them. Never read out or copy
        a credential.
      </p>
      {disabled ? (
        <p className="alert alert-info" data-testid="recovery-offline">
          This procedure needs a connection to the server.
        </p>
      ) : null}
      <div className="stack-sm">
        <Field id="rec-ticket" label="Ticket">
          {(aria) => (
            <select
              {...aria}
              value={ticketId}
              onChange={(e) => {
                setTicketId(e.target.value);
                // answers given about another ticket never carry over
                setAsked(false);
                setMatches(false);
              }}
              disabled={disabled}
            >
              <option value="">Choose a ticket</option>
              {tickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.public_code}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="rec-reason" label="Reason">
          {(aria) => (
            <select
              {...aria}
              value={reason}
              onChange={(e) => setReason(e.target.value as RecoveryReasonCode)}
              disabled={disabled}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={asked}
            onChange={(e) => setAsked(e.target.checked)}
            disabled={disabled}
          />{' '}
          I asked the visitor before showing them any detail of the ticket
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={matches}
            onChange={(e) => setMatches(e.target.checked)}
            disabled={disabled}
          />{' '}
          They named the correct service and a join time within 10 minutes, and it matches the
          ticket
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || disabled || !asked}
            onClick={() => void start()}
          >
            Start recovery
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || disabled}
            onClick={() => void revokeAll()}
          >
            End access on all of this ticket&apos;s devices
          </button>
        </div>
      </div>

      <div ref={noteRef} tabIndex={-1}>
        {note ? (
          <p
            role={note.error ? 'alert' : 'status'}
            className={note.error ? 'alert alert-error' : 'alert alert-info'}
            data-testid="staff-recovery-note"
          >
            {note.text}
          </p>
        ) : null}
      </div>

      {active ? (
        <div className="alert alert-info" data-testid="staff-recovery-active">
          <h3 className="alert-title">Recovery for {active.code}</h3>
          {active.status === 'pending' ? (
            <p data-testid="staff-recovery-waiting">
              Waiting for a different supervisor to approve. This request expires at{' '}
              {formatTime(active.expiresAt)}.
            </p>
          ) : null}
          {active.status === 'expired' ? <p>This request expired. Start again if needed.</p> : null}
          {active.status === 'redeemed' ? <p>The visitor has their ticket back.</p> : null}
          {feedback}
          {grantQr ? (
            <div className="qr-panel" data-testid="staff-recovery-qr">
              <p>
                Approved. Let the visitor scan this code with <strong>their own phone</strong>. It
                works once and expires at {formatTime(active.expiresAt)}. Do not photograph it or
                send it anywhere.
              </p>
              <svg
                role="img"
                aria-label={`One-time QR code for the visitor with ticket ${active.code}`}
                viewBox={`0 0 ${total} ${total}`}
                className="qr"
                shapeRendering="crispEdges"
              >
                <rect width={total} height={total} fill="#fff" />
                <path
                  transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}
                  fill="#000"
                  d={qrPath(grantQr)}
                />
              </svg>
            </div>
          ) : null}
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setActive(null)}>
              Hide
            </button>
          </div>
        </div>
      ) : null}

      {canApprove ? (
        <div data-testid="staff-recovery-approvals">
          <h3>Requests waiting for approval</h3>
          {pending.length === 0 ? <p className="muted">None right now.</p> : null}
          <ul className="ticket-list">
            {pending.map((r) => (
              <li key={r.request_id} className="ticket-row">
                <span className="ticket-row-code">{r.public_code}</span>
                <span className="muted ticket-row-meta">
                  {r.service_name} · requested by {r.requested_by_me ? 'you' : r.requested_by_name}
                </span>
                <span className="ticket-row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || r.requested_by_me}
                    aria-describedby={r.requested_by_me ? `own-${r.request_id}` : undefined}
                    onClick={() => void approve(r)}
                  >
                    Approve<span className="visually-hidden"> recovery for {r.public_code}</span>
                  </button>
                  {r.requested_by_me ? (
                    <span id={`own-${r.request_id}`} className="hint">
                      A different supervisor must approve your request.
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
