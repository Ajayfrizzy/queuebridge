import { useState, type FormEvent, type ReactElement } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAnnounce } from '../components/Announcer.js';
import { ErrorSummary, Field, Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import type { FacilityContext } from './FacilityLayout.js';

export function FacilityCounters(): ReactElement {
  const { facilityId, canConfigure } = useOutletContext<FacilityContext>();
  const announce = useAnnounce();
  const counters = useLoad(() => api.listCounters(facilityId), `ctr-${facilityId}`);
  const services = useLoad(() => api.listServices(facilityId), `svc-${facilityId}`);
  const readiness = useLoad(() => api.readiness(facilityId), `ready-${facilityId}`);
  const [error, setError] = useState<ApiRequestError | null>(null);
  /** Outcome of the last activate/deactivate, shown next to that counter (not only announced) */
  const [notice, setNotice] = useState<{ id: string; error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Optimistic checkbox state while a capability change is in flight (server stays authoritative)
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const fe = error?.fieldErrors() ?? {};

  async function refresh(): Promise<void> {
    await Promise.all([counters.reload(), readiness.reload()]);
  }

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const formEl = e.currentTarget;
    const name = String(new FormData(formEl).get('name') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.createCounter(facilityId, name);
      announce(`Counter ${name} added.`);
      formEl.reset();
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function setCapability(
    counterId: string,
    counterName: string,
    serviceId: string,
    serviceName: string,
    enabled: boolean,
  ): Promise<void> {
    const key = `${counterId}:${serviceId}`;
    setPending((p) => ({ ...p, [key]: enabled }));
    try {
      if (enabled) await api.assignCapability(counterId, serviceId);
      else await api.removeCapability(counterId, serviceId);
      announce(`${counterName} ${enabled ? 'now serves' : 'no longer serves'} ${serviceName}.`);
    } catch (err) {
      announce(err instanceof ApiRequestError ? err.message : 'Could not update the counter.');
    }
    await refresh();
    setPending((p) => {
      const { [key]: _done, ...rest } = p;
      return rest;
    });
  }

  async function toggleActive(id: string, name: string, active: boolean): Promise<void> {
    try {
      const res = await api.updateCounter(facilityId, id, { active });
      const codes = (res.released ?? []).map((r) => r.public_code);
      const text = `Counter ${name} ${active ? 'activated' : 'deactivated'}.${
        codes.length > 0 ? ` ${codes.join(', ')} returned to the front of the queue.` : ''
      }`;
      setNotice({ id, error: false, text });
      announce(text);
    } catch (err) {
      // The server refuses to deactivate a counter that is serving someone: say so where it happened
      const text = err instanceof ApiRequestError ? err.message : 'Could not update the counter.';
      setNotice({ id, error: true, text });
      announce(text);
    }
    await refresh();
  }

  const serviceList = services.data?.services ?? [];
  const status = new Map(readiness.data?.readiness.counters.map((c) => [c.id, c]));

  return (
    <div className="split">
      <section aria-labelledby="counters-heading" className="split-main">
        <h2 id="counters-heading">Counters</h2>
        {counters.loading ? <Loading what="counters" /> : null}
        {counters.error ? <p role="alert">{counters.error.message}</p> : null}
        {counters.data && counters.data.counters.length === 0 ? (
          <p data-testid="no-counters">No counters yet.</p>
        ) : null}
        <ul className="card-list">
          {counters.data?.counters.map((c) => {
            const st = status.get(c.id);
            return (
              <li key={c.id} className="card" data-testid="counter-item">
                <h3>{c.name}</h3>
                <p>
                  <StatusBadge active={c.active} />{' '}
                  {st ? (
                    <span className="muted" data-testid="counter-operational">
                      {!c.active
                        ? 'Not operational: inactive counters never serve visitors.'
                        : st.operational
                          ? `Operational: serving ${st.active_service_count} active service${st.active_service_count === 1 ? '' : 's'}.`
                          : 'Not operational: no active service assigned.'}
                    </span>
                  ) : null}
                </p>
                <fieldset disabled={!canConfigure}>
                  <legend>Services at {c.name}</legend>
                  {!c.active ? (
                    <p className="hint">
                      You can still change which services this counter is set to serve. The
                      assignments are kept and take effect when the counter is activated.
                    </p>
                  ) : null}
                  {serviceList.length === 0 ? <p className="muted">Add a service first.</p> : null}
                  {serviceList.map((s) => (
                    <label key={s.id} className="check">
                      <input
                        type="checkbox"
                        checked={pending[`${c.id}:${s.id}`] ?? c.service_ids.includes(s.id)}
                        onChange={(e) =>
                          void setCapability(c.id, c.name, s.id, s.name, e.target.checked)
                        }
                      />{' '}
                      <span>
                        {s.name}
                        {s.status === 'inactive' ? (
                          <span className="muted"> (inactive service)</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
                {canConfigure ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void toggleActive(c.id, c.name, !c.active)}
                  >
                    {c.active ? 'Deactivate' : 'Activate'}
                    <span className="visually-hidden"> {c.name}</span>
                  </button>
                ) : null}
                {notice?.id === c.id ? (
                  <p
                    role={notice.error ? 'alert' : 'status'}
                    className={`alert ${notice.error ? 'alert-error' : 'alert-info'}`}
                    data-testid="counter-notice"
                  >
                    {notice.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {canConfigure ? (
        <section aria-labelledby="add-counter-heading" className="split-side">
          <h2 id="add-counter-heading">Add a counter</h2>
          <form
            onSubmit={(e) => void onCreate(e)}
            noValidate
            aria-label="Add counter"
            className="card form"
          >
            <ErrorSummary error={error} />
            <Field id="counter-name" label="Counter name" error={fe['name']}>
              {(aria) => <input {...aria} name="name" required />}
            </Field>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add counter'}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
