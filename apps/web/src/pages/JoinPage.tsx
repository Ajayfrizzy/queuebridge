import { useCallback, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PublicQueue } from '@queuebridge/contracts';
import { useAnnounce } from '../components/Announcer.js';
import { Loading } from '../components/Form.js';
import { api, apiUrl, ApiRequestError } from '../lib/api.js';
import { formatEstimate } from '../lib/format.js';
import { useLiveUpdates } from '../lib/live.js';
import {
  beginJoin,
  finishJoin,
  isPendingVolatile,
  pendingJoins,
  saveTicket,
  storedTickets,
  ticketPath,
} from '../lib/tickets.js';
import { useLoad } from '../lib/useLoad.js';

/** Visitor join: QR / link → choose service → confirmed ticket. No account required (REQ-F2.1). */
export function JoinPage(): ReactElement {
  const { orgSlug = '', facilitySlug = '' } = useParams();
  const navigate = useNavigate();
  const announce = useAnnounce();
  const facility = useLoad(
    () => api.publicFacility(orgSlug, facilitySlug),
    `${orgSlug}/${facilitySlug}`,
  );
  const [busyQueue, setBusyQueue] = useState<string | null>(null);
  const [error, setError] = useState<{
    queueId: string;
    message: string;
    retryable: boolean;
  } | null>(null);
  const [forSomeoneElse, setForSomeoneElse] = useState(false);
  const joinPath = `/join/${orgSlug}/${facilitySlug}`;

  const reload = facility.reload;
  const live = useLiveUpdates(
    facility.data ? apiUrl(`/public/facilities/${orgSlug}/${facilitySlug}/stream`) : null,
    null,
    useCallback(() => void reload(), [reload]),
  );

  if (facility.loading && !facility.data) return <Loading what="services" />;
  if (facility.error || !facility.data) {
    return (
      <>
        <h1>Queue not found</h1>
        <p role="alert">
          This join link is not active. Check the address or ask a member of staff for help.
        </p>
      </>
    );
  }
  const f = facility.data.facility;
  const mine = storedTickets().filter((t) => t.joinPath === joinPath);
  const pending = pendingJoins();

  async function join(q: PublicQueue): Promise<void> {
    if (mine.length > 0 && !forSomeoneElse) {
      setError({
        queueId: q.queue_id,
        message:
          'You already have a ticket here. Tick the box below if this ticket is for another person.',
        retryable: false,
      });
      return;
    }
    setBusyQueue(q.queue_id);
    setError(null);
    // Idempotency key and proof are saved BEFORE sending: a retry can never create a second ticket
    const p = beginJoin(q.queue_id, q.service_name);
    try {
      const res = await api.join(q.queue_id, {
        operation_id: p.operationId,
        join_proof: p.joinProof,
      });
      const saved = saveTicket({
        code: res.ticket.public_code,
        token: res.ticket.status_token,
        facilityName: res.ticket.facility_name,
        serviceName: res.ticket.service_name,
        joinPath,
        savedAt: new Date().toISOString(),
      });
      finishJoin(q.queue_id);
      announce(`Your ticket is ${res.ticket.public_code}.`);
      void navigate(
        saved ? ticketPath(saved) : `/ticket/${encodeURIComponent(res.ticket.public_code)}`,
        { state: saved ? undefined : { token: res.ticket.status_token, unsaved: true } },
      );
    } catch (e) {
      const err =
        e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error');
      // Network failure: the ticket may exist — retrying reuses the saved key safely.
      // Conflict (closed/paused) is final for this attempt: drop the pending key.
      if (err.status !== 0 && err.status < 500) finishJoin(q.queue_id);
      setError({
        queueId: q.queue_id,
        message: err.message,
        retryable: err.status === 0 || err.status >= 500,
      });
    } finally {
      setBusyQueue(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{f.facility_name}</h1>
        <div className="toolbar muted">
          <span>{f.organization_name} · Get a ticket without an account.</span>
          <span className="badge badge-off" data-testid="live-mode">
            {live === 'live' ? 'Live' : live === 'polling' ? 'Refreshing every 15 s' : 'Connecting'}
          </span>
        </div>
      </div>

      {mine.length > 0 ? (
        <div className="alert alert-info" data-testid="existing-tickets">
          <h2 className="alert-title">Your tickets on this device</h2>
          <ul>
            {mine.map((t) => (
              <li key={t.id}>
                <Link to={ticketPath(t)}>
                  {t.code} — {t.serviceName}
                </Link>
              </li>
            ))}
          </ul>
          <label className="check">
            <input
              type="checkbox"
              checked={forSomeoneElse}
              onChange={(e) => setForSomeoneElse(e.target.checked)}
            />{' '}
            I am getting another ticket for someone else (for example, a family member)
          </label>
        </div>
      ) : null}

      {f.queues.length === 0 ? (
        <p role="status" data-testid="no-open-queues">
          No queue is open right now. Please ask a member of staff.
        </p>
      ) : null}

      <ul className="card-list" aria-label="Services">
        {f.queues.map((q) => {
          const hasPending = pending.some((p) => p.queueId === q.queue_id);
          return (
            <li key={q.queue_id} className="card" data-testid="join-service">
              <h2 className="card-title">{q.service_name}</h2>
              {q.description ? <p>{q.description}</p> : null}
              <p className="meta-row">
                <span>
                  <strong>{q.waiting_count}</strong> waiting
                </span>
                <span>{formatEstimate(q.estimate)}</span>
              </p>
              <p className="muted">{q.policy_summary}</p>
              {q.accepting_visitors ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyQueue !== null}
                  onClick={() => void join(q)}
                >
                  {busyQueue === q.queue_id
                    ? 'Getting your ticket…'
                    : hasPending
                      ? 'Finish getting your ticket'
                      : 'Get a ticket'}
                  <span className="visually-hidden"> for {q.service_name}</span>
                </button>
              ) : (
                <p className="alert alert-info">
                  This queue is paused and not accepting new visitors.
                </p>
              )}
              {error && error.queueId === q.queue_id ? (
                <div role="alert" className="alert alert-error" data-testid="join-error">
                  <p>{error.message}</p>
                  {error.retryable ? (
                    <p>
                      Your request may still have reached us. Retrying is safe and will not create a
                      second ticket.
                      {isPendingVolatile(q.queue_id) ? (
                        <>
                          {' '}
                          This browser cannot save data, so keep this page open and retry from here
                          — reloading or closing it loses that protection.
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
