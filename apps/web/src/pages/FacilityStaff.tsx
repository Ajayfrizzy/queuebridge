import { useState, type FormEvent, type ReactElement } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { FacilityRole, StaffMember } from '@queuebridge/contracts';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { ErrorSummary, Field, Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError, type CreatedInvitation } from '../lib/api.js';
import { INVITABLE_ROLES, isOrgAdmin, ROLE_LABELS } from '../lib/permissions.js';
import { useLoad } from '../lib/useLoad.js';
import type { FacilityContext } from './FacilityLayout.js';

export function FacilityStaff(): ReactElement {
  const { facilityId, canConfigure } = useOutletContext<FacilityContext>();
  const { user } = useAuth();
  const announce = useAnnounce();
  const staff = useLoad(() => api.listStaff(facilityId), `staff-${facilityId}`);
  const invitations = useLoad(() => api.listInvitations(facilityId), `inv-${facilityId}`);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const fe = error?.fieldErrors() ?? {};

  if (!canConfigure || !user) {
    return <p role="alert">Only facility administrators can manage staff.</p>;
  }
  const canDeactivate = isOrgAdmin(user);

  async function onInvite(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await api.invite(facilityId, {
        email: String(form.get('email') ?? ''),
        role: String(form.get('role') ?? '') as FacilityRole,
      });
      setCreated(res);
      announce('Invitation created. Copy the link and send it to the invitee.');
      formEl.reset();
      await invitations.reload();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(id: string, email: string): Promise<void> {
    try {
      await api.revokeInvitation(facilityId, id);
      announce(`Invitation for ${email} revoked.`);
    } catch (err) {
      announce(err instanceof ApiRequestError ? err.message : 'Could not revoke the invitation.');
    }
    await invitations.reload();
  }

  async function changeRole(
    staffId: string,
    name: string,
    role: FacilityRole,
    grant: boolean,
  ): Promise<void> {
    try {
      if (grant) await api.grantRole(facilityId, staffId, role);
      else await api.revokeRole(facilityId, staffId, role);
      announce(`${ROLE_LABELS[role] ?? role} ${grant ? 'granted to' : 'removed from'} ${name}.`);
    } catch (err) {
      announce(err instanceof ApiRequestError ? err.message : 'Could not change the role.');
    }
    await staff.reload();
  }

  async function setStatus(m: StaffMember, status: 'active' | 'inactive'): Promise<void> {
    setConfirming(null);
    try {
      await api.setStaffStatus(m.id, status);
      announce(
        status === 'inactive'
          ? `${m.display_name} deactivated. Their sessions were ended.`
          : `${m.display_name} reactivated. They must sign in again.`,
      );
    } catch (err) {
      announce(
        err instanceof ApiRequestError ? err.message : 'Could not change the account status.',
      );
    }
    await staff.reload();
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(created?.accept_url ?? '');
      announce('Invitation link copied.');
    } catch {
      announce('Could not copy automatically. Select the link and copy it manually.');
    }
  }

  const members = staff.data?.staff ?? [];
  const active = members.filter((m) => m.status === 'active');
  const inactive = members.filter((m) => m.status !== 'active');
  const allInvites = invitations.data?.invitations ?? [];
  const pending = allInvites.filter((i) => i.status === 'pending');
  const history = allInvites.filter((i) => i.status !== 'pending');

  function memberCard(m: StaffMember): ReactElement {
    const isSelf = m.id === user?.id;
    const isActive = m.status === 'active';
    return (
      <li key={m.id} className="card" data-testid="staff-item" data-status={m.status}>
        <h3 className="card-title">
          {m.display_name}
          {isSelf ? <span className="muted"> (you)</span> : null}
        </h3>
        <p className="muted wrap">{m.email}</p>
        <p>
          <StatusBadge
            active={isActive}
            off={m.status === 'suspended' ? 'Suspended' : 'Deactivated'}
          />
        </p>
        <ul className="chips" aria-label={`Roles for ${m.display_name}`}>
          {m.roles.map((r) => (
            <li key={r} className="chip">
              {ROLE_LABELS[r] ?? r}
              <button
                type="button"
                className="chip-remove"
                onClick={() => void changeRole(m.id, m.display_name, r, false)}
              >
                <span aria-hidden="true">×</span>
                <span className="visually-hidden">
                  Remove {ROLE_LABELS[r] ?? r} from {m.display_name}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {isActive ? (
          <form
            className="inline-form"
            aria-label={`Grant a role to ${m.display_name}`}
            onSubmit={(e) => {
              e.preventDefault();
              const role = String(new FormData(e.currentTarget).get('role') ?? '') as FacilityRole;
              void changeRole(m.id, m.display_name, role, true);
            }}
          >
            <label htmlFor={`role-${m.id}`}>Add role</label>
            <select id={`role-${m.id}`} name="role">
              {INVITABLE_ROLES.filter((r) => !m.roles.includes(r)).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-secondary">
              Add
            </button>
          </form>
        ) : (
          <p className="hint">Deactivated accounts cannot sign in or be given new roles.</p>
        )}
        {canDeactivate && !isSelf ? (
          confirming === m.id ? (
            <div
              className="btn-row"
              role="group"
              aria-label={`Confirm ${isActive ? 'deactivating' : 'reactivating'} ${m.display_name}`}
            >
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void setStatus(m, isActive ? 'inactive' : 'active')}
              >
                Confirm {isActive ? 'deactivate' : 'reactivate'}
                <span className="visually-hidden"> {m.display_name}</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(m.id)}>
              {isActive ? 'Deactivate account' : 'Reactivate account'}
              <span className="visually-hidden"> for {m.display_name}</span>
            </button>
          )
        ) : null}
      </li>
    );
  }

  return (
    <div className="split">
      <div className="split-main">
        <section aria-labelledby="staff-heading">
          <h2 id="staff-heading">Active staff</h2>
          {staff.loading ? <Loading what="staff" /> : null}
          {staff.error ? <p role="alert">{staff.error.message}</p> : null}
          {!staff.loading && active.length === 0 ? (
            <p>No active staff yet. Invite someone.</p>
          ) : null}
          <ul className="card-list" data-testid="active-staff">
            {active.map(memberCard)}
          </ul>
          {!canDeactivate ? (
            <p className="hint">
              Only organization administrators can deactivate or reactivate accounts.
            </p>
          ) : null}
        </section>

        {inactive.length > 0 ? (
          <section aria-labelledby="inactive-heading">
            <h2 id="inactive-heading">Deactivated staff</h2>
            <ul className="card-list" data-testid="inactive-staff">
              {inactive.map(memberCard)}
            </ul>
          </section>
        ) : null}

        {staff.data && staff.data.org_admins.length > 0 ? (
          <section aria-labelledby="orgadmins-heading">
            <h2 id="orgadmins-heading">Organization administrators</h2>
            <p className="hint">
              These people can manage every facility in the organization. Their access is not
              changed here.
            </p>
            <ul className="plain-list" data-testid="org-admins">
              {staff.data.org_admins.map((a) => (
                <li key={a.id} className="wrap">
                  <strong>{a.display_name}</strong> — {a.email}{' '}
                  {a.status !== 'active' ? '(deactivated)' : ''}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="split-side">
        <section aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite staff</h2>
          <form
            onSubmit={(e) => void onInvite(e)}
            noValidate
            aria-label="Invite staff"
            className="card form"
          >
            <ErrorSummary error={error} />
            <Field id="invite-email" label="Email address" error={fe['email']}>
              {(aria) => <input {...aria} name="email" type="email" required autoComplete="off" />}
            </Field>
            <Field id="invite-role" label="Role" error={fe['role']}>
              {(aria) => (
                <select {...aria} name="role" defaultValue="staff_counter">
                  {INVITABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Inviting…' : 'Create invitation'}
            </button>
          </form>

          {created ? (
            <div className="alert alert-success" data-testid="invite-result">
              <h3 className="alert-title">Invitation created for {created.invitation.email}</h3>
              <p>
                Email delivery is not configured, so share this link with the invitee yourself. It
                is shown only once and expires in 7 days.
              </p>
              <p>
                <code className="mono wrap" data-testid="invite-link">
                  {created.accept_url}
                </code>
              </p>
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" onClick={() => void copyLink()}>
                  Copy invitation link
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCreated(null)}
                >
                  Hide link
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invitations</h2>
          {pending.length === 0 ? <p data-testid="no-pending">No pending invitations.</p> : null}
          <ul className="card-list" data-testid="pending-invitations">
            {pending.map((i) => (
              <li key={i.id} className="card" data-testid="invitation-item">
                <p className="wrap">
                  <strong>{i.email}</strong> — {ROLE_LABELS[i.role] ?? i.role}
                </p>
                <p className="muted">
                  Not yet accepted · expires {new Date(i.expires_at).toLocaleDateString()}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void revokeInvitation(i.id, i.email)}
                >
                  Revoke<span className="visually-hidden"> invitation for {i.email}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {history.length > 0 ? (
          <section aria-labelledby="history-heading">
            <h2 id="history-heading">Invitation history</h2>
            <ul className="plain-list" data-testid="invitation-history">
              {history.map((i) => (
                <li key={i.id} className="wrap" data-testid="history-item">
                  {i.email} — {ROLE_LABELS[i.role] ?? i.role}:{' '}
                  <span data-testid="invitation-status">{i.status}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
