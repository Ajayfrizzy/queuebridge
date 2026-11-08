import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { STATE_LABEL } from '../lib/format.js';
import { hasFacilityRole, QUEUE_MANAGER_ROLES } from '../lib/permissions.js';
import { useLoad } from '../lib/useLoad.js';

/** /staff — choose a facility. */
export function StaffHome(): ReactElement {
  const facilities = useLoad(() => api.listFacilities(), 'staff-facilities');
  if (facilities.loading) return <Loading what="facilities" />;
  const list = facilities.data?.facilities ?? [];
  return (
    <>
      <h1>Staff console</h1>
      {list.length === 0 ? <p>You do not have access to any facility yet.</p> : null}
      <ul className="card-list">
        {list.map((f) => (
          <li key={f.id} className="card">
            <h2 className="card-title">
              <Link to={`/staff/facilities/${f.id}`}>{f.name}</Link>
            </h2>
            <p className="muted">{f.timezone}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** /staff/facilities/:fid — today's queues per service; managers can open them. */
export function StaffFacility(): ReactElement {
  const { fid = '' } = useParams();
  const { user } = useAuth();
  const announce = useAnnounce();
  const facility = useLoad(() => api.getFacility(fid), `f-${fid}`);
  const queues = useLoad(() => api.facilityQueues(fid), `q-${fid}`);
  if (!user || facility.loading || queues.loading) return <Loading what="queues" />;
  if (facility.error || queues.error || !facility.data || !queues.data) {
    return (
      <>
        <h1>Facility not found</h1>
        <p role="alert">This facility does not exist or you do not have access to it.</p>
      </>
    );
  }
  const canManage = hasFacilityRole(user, fid, QUEUE_MANAGER_ROLES);

  async function open(serviceId: string, name: string): Promise<void> {
    try {
      await api.openQueue(fid, serviceId);
      announce(`Queue for ${name} is open for today.`);
    } catch (e) {
      announce(e instanceof ApiRequestError ? e.message : 'Could not open the queue.');
    }
    await queues.reload();
  }

  const date = queues.data.queues[0]?.operational_date;
  return (
    <>
      <p>
        <Link to="/staff">← All facilities</Link>
      </p>
      <h1>{facility.data.facility.name}</h1>
      <p className="muted">Today{date ? ` (${date})` : ''}</p>
      {queues.data.queues.length === 0 ? <p>No services are configured yet.</p> : null}
      <ul className="card-list" aria-label="Today's queues">
        {queues.data.queues.map((q) => (
          <li key={q.service_id} className="card" data-testid="facility-queue">
            <h2 className="card-title">{q.service_name}</h2>
            <p>
              {q.state ? (
                <StatusBadge
                  active={q.state === 'open'}
                  on="Open"
                  off={STATE_LABEL[q.state] ?? q.state}
                />
              ) : (
                <StatusBadge active={false} off="Not opened today" />
              )}{' '}
              {q.queue_id ? <span className="muted">{q.waiting_count} waiting</span> : null}
            </p>
            {q.service_status !== 'active' ? (
              <p className="muted">Service inactive.</p>
            ) : q.queue_id ? (
              <Link className="btn btn-primary" to={`/staff/queues/${q.queue_id}`}>
                Open console<span className="visually-hidden"> for {q.service_name}</span>
              </Link>
            ) : canManage ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void open(q.service_id, q.service_name)}
              >
                Open today&apos;s queue
                <span className="visually-hidden"> for {q.service_name}</span>
              </button>
            ) : (
              <p className="muted">A supervisor has not opened this queue today.</p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
