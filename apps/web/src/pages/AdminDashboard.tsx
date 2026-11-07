import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { ErrorSummary, Field, Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { isOrgAdmin, slugify } from '../lib/permissions.js';
import { useLoad } from '../lib/useLoad.js';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export function AdminDashboard(): ReactElement {
  const { user } = useAuth();
  const announce = useAnnounce();
  const facilities = useLoad(() => api.listFacilities(), 'facilities');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return <Loading what="your session" />;
  const canCreate = isOrgAdmin(user);
  const fe = error?.fieldErrors() ?? {};

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api.createFacility({
        name,
        slug,
        timezone: String(form.get('timezone') ?? 'UTC') || 'UTC',
      });
      announce(`Facility ${res.facility.name} created.`);
      setName('');
      setSlug('');
      setSlugEdited(false);
      await facilities.reload();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Administration</h1>
      <p className="muted">
        {user.organization.name} <span aria-hidden="true">·</span>{' '}
        <span className="mono">{user.organization.slug}</span>
      </p>

      <div className="split">
        <section aria-labelledby="facilities-heading" className="split-main">
          <h2 id="facilities-heading">Facilities</h2>
          {facilities.loading ? <Loading what="facilities" /> : null}
          {facilities.error ? (
            <p role="alert" className="alert alert-error">
              {facilities.error.message}
            </p>
          ) : null}
          {facilities.data && facilities.data.facilities.length === 0 ? (
            <p data-testid="no-facilities">
              {canCreate
                ? 'No facilities yet. Create your first facility below.'
                : 'You have not been given access to any facility yet.'}
            </p>
          ) : null}
          <ul className="card-list">
            {facilities.data?.facilities.map((f) => (
              <li key={f.id} className="card">
                <h3>
                  <Link to={`/admin/facilities/${f.id}`}>{f.name}</Link>
                </h3>
                <p className="muted">
                  <span className="mono">{f.slug}</span> · {f.timezone}{' '}
                  <StatusBadge active={f.status === 'active'} off={f.status} />
                </p>
              </li>
            ))}
          </ul>
        </section>

        {canCreate ? (
          <section aria-labelledby="create-facility-heading" className="split-side">
            <h2 id="create-facility-heading">Create a facility</h2>
            <form
              onSubmit={(e) => void onCreate(e)}
              noValidate
              aria-label="Create facility"
              className="card form"
            >
              <ErrorSummary error={error} />
              <Field id="facility-name" label="Facility name" error={fe['name']}>
                {(aria) => (
                  <input
                    {...aria}
                    name="name"
                    value={name}
                    required
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!slugEdited) setSlug(slugify(e.target.value));
                    }}
                  />
                )}
              </Field>
              <Field
                id="facility-slug"
                label="Facility URL identifier (slug)"
                hint="Appears in the visitor join link, for example /join/your-org/your-facility. Lowercase letters, numbers and single hyphens."
                error={fe['slug']}
              >
                {(aria) => (
                  <input
                    {...aria}
                    name="slug"
                    value={slug}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => {
                      setSlugEdited(true);
                      setSlug(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field id="facility-timezone" label="Time zone" error={fe['timezone']}>
                {(aria) => (
                  <>
                    <input {...aria} name="timezone" list="timezones" defaultValue="UTC" />
                    <datalist id="timezones">
                      {timeZones().map((tz) => (
                        <option key={tz} value={tz} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create facility'}
              </button>
            </form>
          </section>
        ) : null}
      </div>
    </>
  );
}
