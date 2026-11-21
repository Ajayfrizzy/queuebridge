import { useEffect, useId, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Role,
  type Facility,
  type FacilityReadiness,
  type SessionUser,
} from '@queuebridge/contracts';
import { Icon } from '@queuebridge/ui';
import { api } from '../lib/api.js';

/**
 * M7.2 get-started checklist (design §14.4.6; REQ-F15.3.4), the F10 sequence. Explanatory only:
 * it links to the real screens and reflects the facility readiness the API already computes; it
 * enforces nothing (the facility screens and the API do). Private organization data is loaded
 * only for a signed-in administrator, through the same authorized endpoints the admin screens
 * use; signed-out visitors see the steps and a starting point, nothing else.
 */
type StepState = 'done' | 'todo' | 'unknown';
interface StepView {
  state: StepState | null;
  to: string | null;
}

export function canAdminister(user: SessionUser): boolean {
  return user.roles.some(
    (r) => (r.role === Role.ORG_ADMIN && r.facility_id === null) || r.role === Role.FACILITY_ADMIN,
  );
}

/** Step links and states for a signed-in administrator (pure; tested). */
export function adminSteps(
  facility: Facility | null,
  readiness: FacilityReadiness | null,
): StepView[] {
  const fid = facility?.id;
  const base = fid ? `/admin/facilities/${fid}` : null;
  const r = readiness;
  const has = <T,>(v: T | null | undefined): v is T => v !== null && v !== undefined;
  return [
    { state: 'done', to: null },
    { state: facility ? 'done' : 'todo', to: '/admin' },
    {
      state: !facility
        ? 'todo'
        : has(r)
          ? r.services.some((s) => s.status === 'active')
            ? 'done'
            : 'todo'
          : 'unknown',
      to: base ? `${base}/services` : null,
    },
    {
      state: !facility ? 'todo' : has(r) ? (r.configuration_ready ? 'done' : 'todo') : 'unknown',
      to: base ? `${base}/counters` : null,
    },
    { state: facility ? 'unknown' : 'todo', to: base ? `${base}/staff` : null },
    { state: facility ? 'unknown' : 'todo', to: base },
    { state: facility ? 'unknown' : 'todo', to: fid ? `/staff/facilities/${fid}` : null },
  ];
}

const STATE_ICON = { done: 'check', todo: 'info', unknown: 'info' } as const;

export function Onboarding({ user }: { user: SessionUser | null }): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const steps = t('onboarding.steps', { returnObjects: true }) as { title: string; body: string }[];
  const admin = user ? canAdminister(user) : false;
  const [facilities, setFacilities] = useState<Facility[] | null>(null);
  const [fid, setFid] = useState<string | null>(null);
  // Readiness is kept with the facility it was loaded for, and used only while that facility is
  // the selected one: switching never shows another facility's readiness, even for one render
  const [loaded, setLoaded] = useState<{ fid: string; readiness: FacilityReadiness } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!admin) return undefined;
    let cancelled = false;
    api
      .listFacilities()
      .then((r) => {
        if (cancelled) return;
        setFacilities(r.facilities);
        setFid(r.facilities[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [admin]);

  useEffect(() => {
    if (!fid) return undefined;
    let cancelled = false;
    api
      .readiness(fid)
      .then((r) => {
        if (!cancelled) setLoaded({ fid, readiness: r.readiness });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fid]);

  const facility = facilities?.find((f) => f.id === fid) ?? null;
  const readiness = loaded && facility && loaded.fid === facility.id ? loaded.readiness : null;
  const views: StepView[] = !user
    ? steps.map((_, i) => ({ state: null, to: i === 0 ? '/signup' : null }))
    : admin
      ? adminSteps(facility, readiness)
      : steps.map(() => ({ state: null, to: null }));

  return (
    <section aria-labelledby={`${id}-h`} className="landing-section" data-testid="onboarding">
      <h2 id={`${id}-h`}>{t('onboarding.heading')}</h2>
      <p className="landing-intro">{t('onboarding.intro')}</p>
      {!user ? <p data-testid="onboarding-start">{t('onboarding.anonymousStart')}</p> : null}
      {user && !admin ? (
        <p className="alert alert-info" data-testid="onboarding-not-admin">
          {t('onboarding.notAdmin')} <Link to="/staff">{t('hero.staffConsole')}</Link>
        </p>
      ) : null}
      {admin && error ? (
        <p className="alert alert-warn" role="status">
          {t('onboarding.loadError')}
        </p>
      ) : null}
      {admin && facilities && facilities.length === 0 ? (
        <p className="muted" data-testid="onboarding-no-facility">
          {t('onboarding.noFacilities')}
        </p>
      ) : null}
      {admin && facilities && facilities.length > 1 ? (
        <div className="field onboarding-facility">
          <label htmlFor={`${id}-fac`}>{t('onboarding.chooseFacility')}</label>
          <select id={`${id}-fac`} value={fid ?? ''} onChange={(e) => setFid(e.target.value)}>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {admin && facility ? (
        <p className="muted" data-testid="onboarding-for">
          {t('onboarding.signedInFor', { facility: facility.name })}
        </p>
      ) : null}
      <ol className="onboarding-list" data-testid="onboarding-steps">
        {steps.map((s, i) => {
          const v = views[i] ?? { state: null, to: null };
          return (
            <li
              key={s.title}
              className={`onboarding-step${v.state === 'done' ? ' is-done' : ''}`}
              data-testid="onboarding-step"
              data-state={v.state ?? 'none'}
            >
              <span className="onboarding-num" aria-hidden="true">
                {i + 1}
              </span>
              <div className="onboarding-body">
                <h3>{v.to ? <Link to={v.to}>{s.title}</Link> : s.title}</h3>
                <p>{s.body}</p>
                {!user && i > 0 ? <p className="muted">{t('onboarding.afterSignup')}</p> : null}
              </div>
              {v.state ? (
                <span
                  className={`badge ${v.state === 'done' ? 'badge-ok' : 'badge-off'}`}
                  data-testid="onboarding-state"
                >
                  <Icon name={STATE_ICON[v.state]} className="badge-icon" />
                  {t(`onboarding.state.${v.state}`)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!user ? (
        <p>
          {t('onboarding.already')} <Link to="/login">{t('hero.secondary')}</Link>
        </p>
      ) : null}
    </section>
  );
}
