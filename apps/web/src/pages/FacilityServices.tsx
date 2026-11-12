import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  DEFAULT_OVERRIDE_REASONS,
  type PolicyVersion,
  type Service,
  type ServicePolicy,
} from '@queuebridge/contracts';
import { describePolicy } from '../lib/policy.js';
import { useAnnounce } from '../components/Announcer.js';
import { reasonLabel } from '../components/FairnessControls.js';
import { ErrorSummary, Field, Loading, StatusBadge } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { useLoad } from '../lib/useLoad.js';
import type { FacilityContext } from './FacilityLayout.js';

const PLACEMENT_LABEL: Record<ServicePolicy['transfer_placement'], string> = {
  by_original_join_time: 'Keep their original waiting time',
  end_of_queue: 'Join the end of the queue',
};

/** Read the shared policy fields of a create/edit form. The server assigns the version. */
function policyFromForm(form: FormData, current?: ServicePolicy): ServicePolicy {
  const extra = (['urgent', 'priority'] as const).filter((c) => form.get(`class-${c}`) === 'on');
  const reasons = form.getAll('override_reason').map(String);
  return {
    version: current?.version ?? 'v1',
    priority_order: [...extra, 'normal'],
    grace_window_seconds: Number(form.get('grace_window_seconds') ?? 300),
    override_reasons: reasons.length > 0 ? reasons : [...DEFAULT_OVERRIDE_REASONS],
    transfer_placement:
      form.get('transfer_placement') === 'end_of_queue' ? 'end_of_queue' : 'by_original_join_time',
  };
}

/** Policy fields shared by "Add a service" and "Edit policy". */
function PolicyFields({
  idPrefix,
  policy,
  errors,
}: {
  idPrefix: string;
  policy?: ServicePolicy;
  errors: Record<string, string>;
}): ReactElement {
  const reasons = [...new Set([...DEFAULT_OVERRIDE_REASONS, ...(policy?.override_reasons ?? [])])];
  const enabledReasons = new Set(policy?.override_reasons ?? DEFAULT_OVERRIDE_REASONS);
  return (
    <>
      <fieldset>
        <legend>Queue ordering policy</legend>
        <p className="hint">
          The “normal” class is always on. Visitors in the same class are served first come, first
          served. Optionally enable higher classes that a supervisor may assign with a recorded
          reason; only the classes you tick are enabled.
        </p>
        <label className="check">
          <input
            type="checkbox"
            name="class-urgent"
            defaultChecked={policy?.priority_order.includes('urgent') ?? false}
          />{' '}
          Enable “urgent” class
        </label>
        <label className="check">
          <input
            type="checkbox"
            name="class-priority"
            defaultChecked={policy?.priority_order.includes('priority') ?? false}
          />{' '}
          Enable “priority” class
        </label>
      </fieldset>
      <fieldset>
        <legend>Reasons a supervisor may give for an override</legend>
        {reasons.map((r) => (
          <label key={r} className="check">
            <input
              type="checkbox"
              name="override_reason"
              value={r}
              defaultChecked={enabledReasons.has(r)}
            />{' '}
            {reasonLabel(r)}
          </label>
        ))}
        {errors['policy.override_reasons'] ? (
          <p className="field-error">{errors['policy.override_reasons']}</p>
        ) : null}
      </fieldset>
      <Field
        id={`${idPrefix}-placement`}
        label="Transferred visitors"
        hint="Whether a visitor transferred from another service keeps their waiting time here."
        error={errors['policy.transfer_placement']}
      >
        {(aria) => (
          <select
            {...aria}
            name="transfer_placement"
            defaultValue={policy?.transfer_placement ?? 'by_original_join_time'}
          >
            {(['by_original_join_time', 'end_of_queue'] as const).map((v) => (
              <option key={v} value={v}>
                {PLACEMENT_LABEL[v]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id={`${idPrefix}-grace`}
        label="Grace window (seconds)"
        hint="How long a called visitor may take to arrive before being marked missed."
        error={errors['policy.grace_window_seconds']}
      >
        {(aria) => (
          <input
            {...aria}
            name="grace_window_seconds"
            type="number"
            min={0}
            max={3600}
            defaultValue={policy?.grace_window_seconds ?? 300}
          />
        )}
      </Field>
    </>
  );
}

/** Edit a service's published policy; every real change becomes a new server-assigned version. */
function PolicyEditor({
  facilityId,
  service,
  onSaved,
}: {
  facilityId: string;
  service: Service;
  onSaved: () => Promise<void>;
}): ReactElement {
  const uid = useId();
  const announce = useAnnounce();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const policy = policyFromForm(new FormData(e.currentTarget), service.policy);
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateService(facilityId, service.id, { policy });
      const v = res.service.policy.version;
      announce(
        v === service.policy.version
          ? `No change: ${service.name} still uses policy ${v}.`
          : `${service.name} now uses policy ${v}. Queues opened today use it from now on.`,
      );
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      aria-label={`Edit policy for ${service.name}`}
      className="form stack-sm"
      data-testid="policy-editor"
    >
      <ErrorSummary error={error} />
      <PolicyFields idPrefix={uid} policy={service.policy} errors={error?.fieldErrors() ?? {}} />
      <p className="hint">
        Saving creates a new policy version. Earlier versions are kept so past decisions can be
        explained.
      </p>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save policy'}
      </button>
    </form>
  );
}

/** Immutable history of a service's policy versions (newest first). */
function PolicyHistory({
  facilityId,
  serviceId,
}: {
  facilityId: string;
  serviceId: string;
}): ReactElement {
  const list = useLoad(
    () => api.policyVersions(facilityId, serviceId),
    `policy-versions-${serviceId}`,
  );
  if (list.loading && !list.data) return <Loading what="policy history" />;
  if (list.error) return <p role="alert">{list.error.message}</p>;
  const versions: PolicyVersion[] = list.data?.versions ?? [];
  return (
    <ol className="plain-list" data-testid="policy-history">
      {versions.map((v) => (
        <li key={v.version}>
          <strong>{v.version}</strong> — {formatTime(v.created_at)}
          {v.created_by_name ? ` by ${v.created_by_name}` : ''}:{' '}
          <span className="muted">{describePolicy(v.policy as unknown as ServicePolicy)}</span>
        </li>
      ))}
    </ol>
  );
}

export function FacilityServices(): ReactElement {
  const { facilityId, canConfigure } = useOutletContext<FacilityContext>();
  const announce = useAnnounce();
  const list = useLoad(() => api.listServices(facilityId), `svc-${facilityId}`);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which service's history panel has been opened (loaded lazily) */
  const [historyFor, setHistoryFor] = useState<Set<string>>(new Set());
  /** The one service whose policy editor is open */
  const [editing, setEditing] = useState<string | null>(null);
  const fe = error?.fieldErrors() ?? {};

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get('name') ?? '');
    const description = String(form.get('description') ?? '').trim();
    const policy = policyFromForm(form);
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
                <StatusBadge active={s.status === 'active'} />{' '}
                <span data-testid="policy-version">Policy {s.policy.version}</span>
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
              {canConfigure ? (
                <details
                  onToggle={(e) =>
                    setEditing((e.currentTarget as HTMLDetailsElement).open ? s.id : null)
                  }
                  open={editing === s.id}
                >
                  <summary>
                    Edit policy<span className="visually-hidden"> for {s.name}</span>
                  </summary>
                  {/* Rendered only while open, so its fields never duplicate the create form's */}
                  {editing === s.id ? (
                    <PolicyEditor
                      key={s.policy.version}
                      facilityId={facilityId}
                      service={s}
                      onSaved={list.reload}
                    />
                  ) : null}
                </details>
              ) : null}
              <details
                onToggle={(e) => {
                  if ((e.currentTarget as HTMLDetailsElement).open) {
                    setHistoryFor((prev) => new Set(prev).add(s.id));
                  }
                }}
              >
                <summary>
                  Policy history<span className="visually-hidden"> for {s.name}</span>
                </summary>
                {historyFor.has(s.id) ? (
                  <PolicyHistory key={s.policy.version} facilityId={facilityId} serviceId={s.id} />
                ) : null}
              </details>
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
            <PolicyFields idPrefix="new-service" errors={fe} />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add service'}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
