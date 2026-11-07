import { useState, type FormEvent, type ReactElement } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { ServicePolicy } from '@queuebridge/contracts';
import { describePolicy } from '../lib/policy.js';
import { useAnnounce } from '../components/Announcer.js';
import { ErrorSummary, Field, Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import type { FacilityContext } from './FacilityLayout.js';

export function FacilityServices(): ReactElement {
  const { facilityId, canConfigure } = useOutletContext<FacilityContext>();
  const announce = useAnnounce();
  const list = useLoad(() => api.listServices(facilityId), `svc-${facilityId}`);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = error?.fieldErrors() ?? {};

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get('name') ?? '');
    const description = String(form.get('description') ?? '').trim();
    const extra = (['urgent', 'priority'] as const).filter((c) => form.get(`class-${c}`) === 'on');
    const policy: ServicePolicy = {
      version: 'v1',
      priority_order: [...extra, 'normal'],
      grace_window_seconds: Number(form.get('grace_window_seconds') ?? 300),
    };
    setBusy(true);
    setError(null);
    try {
      await api.createService(facilityId, {
        name,
        ...(description ? { description } : {}),
        policy,
      });
      announce(`Service ${name} added.`);
      formEl.reset();
      await list.reload();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, name: string, status: 'active' | 'inactive'): Promise<void> {
    try {
      await api.updateService(facilityId, id, { status });
      announce(`Service ${name} ${status === 'active' ? 'activated' : 'deactivated'}.`);
      await list.reload();
    } catch (err) {
      announce(err instanceof ApiRequestError ? err.message : 'Could not update the service.');
    }
  }

  return (
    <div className="split">
      <section aria-labelledby="services-heading" className="split-main">
        <h2 id="services-heading">Services</h2>
        {list.loading ? <Loading what="services" /> : null}
        {list.error ? <p role="alert">{list.error.message}</p> : null}
        {list.data && list.data.services.length === 0 ? (
          <p data-testid="no-services">No services yet.</p>
        ) : null}
        <ul className="card-list">
          {list.data?.services.map((s) => (
            <li key={s.id} className="card" data-testid="service-item">
              <h3>{s.name}</h3>
              {s.description ? <p>{s.description}</p> : null}
              <p className="muted">
                <StatusBadge active={s.status === 'active'} />
              </p>
              <p className="muted" data-testid="service-policy">
                {describePolicy(s.policy)}
              </p>
              {canConfigure ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void toggle(s.id, s.name, s.status === 'active' ? 'inactive' : 'active')
                  }
                >
                  {s.status === 'active' ? 'Deactivate' : 'Activate'}
                  <span className="visually-hidden"> {s.name}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {canConfigure ? (
        <section aria-labelledby="add-service-heading" className="split-side">
          <h2 id="add-service-heading">Add a service</h2>
          <form
            onSubmit={(e) => void onCreate(e)}
            noValidate
            aria-label="Add service"
            className="card form"
          >
            <ErrorSummary error={error} />
            <Field id="service-name" label="Service name" error={fe['name']}>
              {(aria) => <input {...aria} name="name" required />}
            </Field>
            <Field
              id="service-description"
              label="Description (optional)"
              error={fe['description']}
            >
              {(aria) => <input {...aria} name="description" />}
            </Field>
            <fieldset>
              <legend>Queue ordering policy</legend>
              <p className="hint">
                The “normal” class is always on. Visitors in the same class are served first come,
                first served. Optionally enable higher classes that a supervisor may assign with a
                recorded reason; only the classes you tick are enabled.
              </p>
              <label className="check">
                <input type="checkbox" name="class-urgent" /> Enable “urgent” class
              </label>
              <label className="check">
                <input type="checkbox" name="class-priority" /> Enable “priority” class
              </label>
            </fieldset>
            <Field
              id="grace-window"
              label="Grace window (seconds)"
              hint="How long a called visitor may take to arrive before being marked missed."
              error={fe['policy.grace_window_seconds']}
            >
              {(aria) => (
                <input
                  {...aria}
                  name="grace_window_seconds"
                  type="number"
                  min={0}
                  max={3600}
                  defaultValue={300}
                />
              )}
            </Field>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add service'}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
