import type { ReactElement } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { Loading } from '../components/Form.js';
import { api } from '../lib/api.js';
import { isFacilityAdmin } from '../lib/permissions.js';
import { useLoad } from '../lib/useLoad.js';

export interface FacilityContext {
  facilityId: string;
  canConfigure: boolean;
}

export function FacilityLayout(): ReactElement {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const facility = useLoad(() => api.getFacility(id), id);

  if (facility.loading || !user) return <Loading what="facility" />;
  if (facility.error || !facility.data) {
    return (
      <>
        <h1>Facility not found</h1>
        <p role="alert">
          This facility does not exist or you do not have access to it.{' '}
          <Link to="/admin">Back to administration</Link>
        </p>
      </>
    );
  }
  const f = facility.data.facility;
  const canConfigure = isFacilityAdmin(user, f.id);
  const ctx: FacilityContext = { facilityId: f.id, canConfigure };

  return (
    <>
      <p>
        <Link to="/admin">← All facilities</Link>
      </p>
      <h1>{f.name}</h1>
      {!canConfigure ? (
        <p className="alert alert-info" data-testid="read-only-note">
          You have read-only access to this facility.
        </p>
      ) : null}
      <nav aria-label="Facility sections" className="subnav">
        <ul className="nav-list">
          <li>
            <NavLink to="" end>
              Overview
            </NavLink>
          </li>
          <li>
            <NavLink to="services">Services</NavLink>
          </li>
          <li>
            <NavLink to="counters">Counters</NavLink>
          </li>
          {canConfigure ? (
            <li>
              <NavLink to="staff">Staff</NavLink>
            </li>
          ) : null}
        </ul>
      </nav>
      <Outlet context={ctx} />
    </>
  );
}
