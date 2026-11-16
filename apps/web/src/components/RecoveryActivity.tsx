import { useEffect, useState, type ReactElement } from 'react';
import type {
  RecoveryAuditActor,
  RecoveryAuditEntry,
  RecoveryAuditKind,
  RecoveryReasonCode,
} from '@queuebridge/contracts';
import { api, ApiRequestError } from '../lib/api.js';
import { useAnnounce } from './Announcer.js';

/**
 * Recovery activity of one queue's tickets (design §15.9a; ADR-015 amendment 1; manual check 12).
 * Read-only: recovery is audited in admin events, not in the queue's event chain, so it has its
 * own section. Shows who did what as recorded; no key, grant, token or link is ever received.
 */

const KIND_LABEL: Record<RecoveryAuditKind, string> = {
  request: 'Staff recovery requested (needs a second person)',
  restricted_assistance: 'Restricted assistance only (visitor not verified; no credential)',
  approval: 'Request approved (second person)',
  recovered: 'Ticket opened on the visitor’s device',
  key_regenerated: 'Visitor made a new recovery key',
  sessions_revoked: 'Visitor signed out their other devices',
  access_ended: 'Staff ended access on all devices',
  abuse_detected: 'Many failed recovery attempts detected',
};
/** What the person in the "By" column did, so requester and approver are never confused */
const ROLE_LABEL: Partial<Record<RecoveryAuditKind, string>> = {
  request: 'Requested by',
  restricted_assistance: 'Handled by',
  approval: 'Approved by',
  access_ended: 'Ended by',
};
const REASON_LABEL: Record<RecoveryReasonCode, string> = {
  lost_device: 'Lost or broken phone',
  cleared_browser: 'Cleared browser or changed phone',
  no_smartphone: 'Has no smartphone',
  other: 'Another reason',
};

function byText(kind: RecoveryAuditKind, who: RecoveryAuditActor): string {
  switch (who.kind) {
    case 'staff': {
      const status = who.account_status === 'active' ? '' : ` (account ${who.account_status})`;
      return `${ROLE_LABEL[kind] ?? 'By'} ${who.name}${status}`;
    }
    case 'visitor_device':
      return 'The visitor’s own device';
    case 'system':
      return 'QueueBridge (automatic)';
    case 'not_recorded':
      return 'Not recorded';
  }
}

function detailText(e: RecoveryAuditEntry): string {
  const parts: string[] = [];
  if (e.reason_code) parts.push(`reason: ${REASON_LABEL[e.reason_code]}`);
  if (e.assurance) parts.push(`assurance: ${e.assurance}`);
  if (e.method) parts.push(e.method === 'staff_grant' ? 'with a staff grant' : 'with the key');
  if (e.revoked_devices !== null) {
    parts.push(`${e.revoked_devices} ${e.revoked_devices === 1 ? 'device' : 'devices'} signed out`);
  }
  return parts.join(' · ');
}

export function RecoveryActivity({ queueId }: { queueId: string }): ReactElement {
  const announce = useAnnounce();
  const [entries, setEntries] = useState<RecoveryAuditEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .recoveryAudit(queueId, null)
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setNext(r.next_after);
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(
            e instanceof ApiRequestError ? e.message : 'Recovery activity could not be loaded.',
          );
        }
      });
    return (): void => {
      alive = false;
    };
  }, [queueId]);

  async function more(): Promise<void> {
    if (!next) return;
    setLoading(true);
    try {
      const r = await api.recoveryAudit(queueId, next);
      setEntries((prev) => [...(prev ?? []), ...r.entries]);
      setNext(r.next_after);
      announce(`Loaded ${r.entries.length} more recovery entries.`);
    } catch (e) {
      announce(e instanceof ApiRequestError ? e.message : 'Could not load more entries.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="recovery-activity-heading" data-testid="recovery-activity">
      <h2 id="recovery-activity-heading">Recovery activity</h2>
      <p className="muted">
        Who helped visitors get their tickets back, who approved it, and what the visitors’ devices
        did. Recorded separately from the event chain above. Names are the staff accounts’ current
        names.
      </p>
      {error ? (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      ) : entries === null ? (
        <p className="muted">Loading recovery activity…</p>
      ) : entries.length === 0 ? (
        <p className="muted" data-testid="recovery-activity-empty">
          No recovery activity for this queue.
        </p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-labelledby="recovery-activity-heading"
          tabIndex={0}
        >
          <table className="data-table" data-testid="recovery-activity-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Ticket</th>
                <th scope="col">What happened</th>
                <th scope="col">By</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} data-kind={e.kind}>
                  <td>{new Date(e.at).toLocaleString()}</td>
                  <td>{e.ticket_code}</td>
                  <td>{KIND_LABEL[e.kind]}</td>
                  <td>{byText(e.kind, e.performed_by)}</td>
                  <td className="wrap">{detailText(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading}
          onClick={() => void more()}
        >
          {loading ? 'Loading…' : 'Load more recovery activity'}
        </button>
      ) : null}
    </section>
  );
}
