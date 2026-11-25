import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Permission,
  SMS_DELAY_MIN_SECONDS,
  SMS_FACILITY_CAP_MAX,
  type FacilitySmsSettings,
  type FacilityUssdSettings,
  type SmsMonitorRow,
  type SmsMonitoring,
  type UssdMonitoring,
} from '@queuebridge/contracts';
import { useAuth } from '../auth.js';
import { useAnnounce } from '../components/Announcer.js';
import { ErrorSummary, Field, Loading } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { hasFacilityRole } from '../lib/permissions.js';
import type { FacilityContext } from './FacilityLayout.js';

/**
 * M6.3 facility channels (design §13; REQ-F11.10–F11.13, F12): SMS and USSD settings, honest
 * deployment-mode and readiness indicators, and operational monitoring.
 *
 * - Everything is loaded from the server and saved through the existing authorized API; the
 *   deployment's provider mode is set by its environment and is only SHOWN here (the browser can
 *   never switch a channel to sandbox or live).
 * - Readers see the settings read-only; monitoring needs OPERATIONS_VIEW (supervisors, facility
 *   administrators, auditors). The API enforces both.
 * - Status is always words plus a symbol, never colour alone. Native controls only.
 */
export function FacilityChannels(): ReactElement {
  const { facilityId, canConfigure } = useOutletContext<FacilityContext>();
  const { user } = useAuth();
  const canMonitor = user ? hasFacilityRole(user, facilityId, Permission.OPERATIONS_VIEW) : false;
  return (
    <div className="facility-channels stack" data-testid="channels-page">
      <h2>Channels</h2>
      <p>
        Text message (SMS) turn alerts and the USSD phone menu for this facility. The ticket page,
        the public board and staff calling do not depend on these channels.
      </p>
      {!canConfigure ? (
        <p className="muted" data-testid="channels-read-only">
          Only a facility administrator can change these settings.
        </p>
      ) : null}
      <SmsSettingsSection facilityId={facilityId} canConfigure={canConfigure} />
      <UssdSettingsSection facilityId={facilityId} canConfigure={canConfigure} />
      {canMonitor ? (
        <>
          <SmsMonitorSection facilityId={facilityId} />
          <UssdMonitorSection facilityId={facilityId} />
        </>
      ) : (
        <p className="muted" data-testid="channels-monitor-restricted">
          Delivery monitoring is shown to supervisors, facility administrators and auditors.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Words + symbol (never colour alone). */
function Indicator({ ok, children }: { ok: boolean; children: string }): ReactElement {
  return (
    <span className={`badge ${ok ? 'badge-ok' : 'badge-off'}`}>
      <span aria-hidden="true">{ok ? '✓ ' : '✕ '}</span>
      {children}
    </span>
  );
}

/**
 * The provider mode, as the deployment reports it. Shown as a radio group so both options are
 * visible, but it is display-only: Live is unavailable in this build, and Sandbox is set by the
 * deployment's configuration, not here.
 */
function ProviderMode({
  channel,
  mode,
}: {
  channel: 'SMS' | 'USSD';
  mode: 'off' | 'sandbox' | 'live';
}): ReactElement {
  const id = useId();
  return (
    <fieldset className="provider-mode" disabled data-testid={`${channel.toLowerCase()}-mode`}>
      <legend>Provider mode (set by this deployment, not on this screen)</legend>
      <label className="check" htmlFor={`${id}-sandbox`}>
        <input
          type="radio"
          id={`${id}-sandbox`}
          name={`${id}-mode`}
          checked={mode === 'sandbox'}
          readOnly
        />
        Sandbox (test mode)
      </label>
      <label className="check" htmlFor={`${id}-live`}>
        <input
          type="radio"
          id={`${id}-live`}
          name={`${id}-mode`}
          checked={false}
          readOnly
          aria-describedby={`${id}-live-why`}
        />
        Live
      </label>
      <p id={`${id}-live-why`} className="hint">
        Live is not available: no {channel} provider is approved for this build, so there are no
        live credentials and no live activation.
      </p>
      {mode === 'off' ? (
        <p className="hint" data-testid={`${channel.toLowerCase()}-mode-off`}>
          Off: {channel} is not set up on this deployment, so nothing is sent or answered, not even
          in test mode.
        </p>
      ) : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------

type FieldErrors = Record<string, string>;

/** Client-side validation summary (same pattern as `ErrorSummary`), focused when shown. */
function LocalErrors({ errors }: { errors: FieldErrors }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const entries = Object.entries(errors);
  useEffect(() => {
    if (entries.length > 0) ref.current?.focus();
  }, [entries.length]);
  if (entries.length === 0) return null;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="alert alert-error"
      data-testid="channel-errors"
    >
      <h3 className="alert-title">Please correct the following</h3>
      <ul>
        {entries.map(([field, message]) => (
          <li key={field}>
            <a
              href={`#${field}`}
              onClick={(e) => {
                e.preventDefault();
                ref.current
                  ?.closest('form')
                  ?.querySelector<HTMLElement>(`[name="${field}"]`)
                  ?.focus();
              }}
            >
              {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SmsSettingsSection({
  facilityId,
  canConfigure,
}: {
  facilityId: string;
  canConfigure: boolean;
}): ReactElement {
  const announce = useAnnounce();
  const id = useId();
  const [settings, setSettings] = useState<FacilitySmsSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [cap, setCap] = useState('');
  const [delayOn, setDelayOn] = useState(false);
  const [delay, setDelay] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [apiError, setApiError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const adopt = (s: FacilitySmsSettings): void => {
    setSettings(s);
    setEnabled(s.enabled);
    setCap(s.daily_cap > 0 ? String(s.daily_cap) : '');
    setDelayOn(s.delay_seconds !== null);
    setDelay(s.delay_seconds !== null ? String(s.delay_seconds) : '');
  };
  useEffect(() => {
    let cancelled = false;
    api
      .smsSettings(facilityId)
      .then((r) => {
        if (!cancelled) adopt(r.sms);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoadError(
            e instanceof ApiRequestError ? e.message : 'Could not load the SMS setting.',
          );
      });
    return (): void => {
      cancelled = true;
    };
  }, [facilityId]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !settings) return;
    const next: FieldErrors = {};
    const capN = cap.trim() === '' ? 0 : Number(cap);
    if (!Number.isInteger(capN) || capN < 0 || capN > SMS_FACILITY_CAP_MAX) {
      next['daily_cap'] = `Enter a whole number from 0 to ${SMS_FACILITY_CAP_MAX}.`;
    } else if (enabled && capN < 1) {
      next['daily_cap'] = 'Enter a daily limit of at least 1 to turn text messages on.';
    }
    const delayN = Number(delay);
    const max = settings.delay_max_seconds;
    if (delayOn) {
      if (max === null) {
        next['delay_seconds'] =
          'A delay is not possible at this facility. Send immediately instead.';
      } else if (!Number.isInteger(delayN) || delayN < SMS_DELAY_MIN_SECONDS || delayN > max) {
        next['delay_seconds'] =
          `Enter a whole number of seconds from ${SMS_DELAY_MIN_SECONDS} to ${max}.`;
      }
    }
    setErrors(next);
    setApiError(null);
    setSaved(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const r = await api.setSmsSettings(facilityId, {
        enabled,
        daily_cap: capN,
        delay_seconds: delayOn ? delayN : null,
      });
      adopt(r.sms);
      const text = `SMS settings saved: ${r.sms.enabled ? 'on' : 'off'}${r.sms.delay_seconds !== null ? `, delay ${r.sms.delay_seconds} seconds` : ', sent immediately'}.`;
      setSaved(text);
      announce(text);
    } catch (err) {
      setApiError(
        err instanceof ApiRequestError
          ? err
          : new ApiRequestError(0, null, 'The setting could not be saved.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const s = settings;
  const sandbox = s?.deployment_mode === 'sandbox';
  const willSend = Boolean(s && s.deployment_available && s.enabled && s.daily_cap > 0);
  return (
    <section aria-labelledby={`${id}-h`} className="card" data-testid="sms-settings">
      <h3 id={`${id}-h`}>Text message (SMS) turn alerts</h3>
      {s === null && !loadError ? <Loading what="SMS setting" /> : null}
      {loadError ? (
        <p role="alert" className="alert alert-error">
          {loadError}
        </p>
      ) : null}
      {s ? (
        <>
          {sandbox ? (
            <p className="alert alert-warn" data-testid="sms-sandbox-warning">
              <span aria-hidden="true">⚠ </span>Test mode — no real messages are sent
            </p>
          ) : null}
          <ProviderMode channel="SMS" mode={s.deployment_mode} />
          <ul className="readiness" data-testid="sms-readiness">
            <li>
              <Indicator ok={s.deployment_available}>
                {s.deployment_available
                  ? 'This deployment can send test messages'
                  : 'This deployment is not set up to send text messages'}
              </Indicator>
            </li>
            <li>
              <Indicator ok={s.enabled}>
                {s.enabled ? 'Turned on for this facility' : 'Off for this facility'}
              </Indicator>
            </li>
            <li>
              <Indicator ok={willSend}>
                {willSend
                  ? 'Turn alerts are sent here (test mode: nothing reaches a phone)'
                  : 'No text message is sent from this facility'}
              </Indicator>
            </li>
          </ul>
          <dl className="stat-row" data-testid="sms-usage">
            <div className="stat">
              <dt>Today at this facility (UTC)</dt>
              <dd>
                {s.sent_today.facility} of {s.daily_cap}
              </dd>
            </div>
            <div className="stat">
              <dt>Today on this deployment (UTC)</dt>
              <dd>
                {s.sent_today.deployment} of {s.deployment_daily_cap}
              </dd>
            </div>
          </dl>
          <form noValidate onSubmit={(e) => void onSubmit(e)} aria-describedby={`${id}-help`}>
            <p id={`${id}-help`} className="hint">
              Messages over either daily limit are not sent and are recorded as failed (limit
              reached). Limits reset at midnight UTC.
            </p>
            <LocalErrors errors={errors} />
            <ErrorSummary error={apiError} title="The SMS setting was not saved" />
            <fieldset disabled={!canConfigure || busy}>
              <legend className="visually-hidden">SMS settings</legend>
              <label className="check" htmlFor={`${id}-enabled`}>
                <input
                  type="checkbox"
                  id={`${id}-enabled`}
                  name="enabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Send text message turn alerts at this facility
              </label>
              <Field
                id="daily_cap"
                label="Daily limit for this facility (messages per day)"
                hint={`Required to turn text messages on. At most ${SMS_FACILITY_CAP_MAX}.`}
                error={errors['daily_cap']}
              >
                {(aria) => (
                  <input
                    {...aria}
                    name="daily_cap"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={SMS_FACILITY_CAP_MAX}
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                  />
                )}
              </Field>
              <label className="check" htmlFor={`${id}-delay-on`}>
                <input
                  type="checkbox"
                  id={`${id}-delay-on`}
                  name="delay_on"
                  checked={delayOn}
                  disabled={s.delay_max_seconds === null && !delayOn}
                  aria-describedby={`${id}-delay-help`}
                  onChange={(e) => setDelayOn(e.target.checked)}
                />
                Send a text message only if the ticket page has not shown the alert after a delay
              </label>
              <div id={`${id}-delay-help`} className="hint" data-testid="sms-delay-help">
                <p>
                  Off by default: the text message is sent as soon as the visitor is called. With a
                  delay, it is sent only if the visitor&apos;s ticket page has not shown the alert
                  by then. This can save messages, but the text message arrives later; it is not
                  recommended where timely calling matters.
                </p>
                <p>
                  The ticket page reports only that it showed the alert, not that the visitor read
                  it, and no report does not mean the visitor missed it.
                </p>
                {s.delay_max_seconds === null ? (
                  <p data-testid="sms-delay-impossible">
                    A delay is not possible here: the turn-alert time limit or an automatic no-show
                    setting leaves no time for it.
                  </p>
                ) : null}
              </div>
              {delayOn ? (
                <Field
                  id="delay_seconds"
                  label="Delay before the text message (seconds)"
                  hint={
                    s.delay_max_seconds !== null
                      ? `From ${SMS_DELAY_MIN_SECONDS} to ${s.delay_max_seconds} seconds (limited by the turn-alert time limit and automatic no-show settings).`
                      : 'No delay is possible here.'
                  }
                  error={errors['delay_seconds']}
                >
                  {(aria) => (
                    <input
                      {...aria}
                      name="delay_seconds"
                      type="number"
                      inputMode="numeric"
                      min={SMS_DELAY_MIN_SECONDS}
                      max={s.delay_max_seconds ?? undefined}
                      value={delay}
                      onChange={(e) => setDelay(e.target.value)}
                    />
                  )}
                </Field>
              ) : null}
              {s.delay_seconds !== null &&
              (s.delay_max_seconds === null || s.delay_seconds > s.delay_max_seconds) ? (
                <p className="alert alert-warn" data-testid="sms-delay-over">
                  <span aria-hidden="true">⚠ </span>The saved delay is now longer than this
                  facility allows. Text messages for services with a shorter automatic no-show are
                  sent immediately; save a shorter delay or turn the delay off.
                </p>
              ) : null}
              {canConfigure ? (
                <div className="btn-row">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    aria-disabled={busy}
                    data-testid="sms-save"
                  >
                    {busy ? 'Saving…' : 'Save SMS settings'}
                  </button>
                </div>
              ) : null}
            </fieldset>
            {saved ? (
              <p role="status" className="alert alert-success" data-testid="sms-saved">
                <span aria-hidden="true">✓ </span>
                {saved}
              </p>
            ) : null}
          </form>
        </>
      ) : null}
    </section>
  );
}

function UssdSettingsSection({
  facilityId,
  canConfigure,
}: {
  facilityId: string;
  canConfigure: boolean;
}): ReactElement {
  const announce = useAnnounce();
  const id = useId();
  const [settings, setSettings] = useState<FacilityUssdSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiError, setApiError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .ussdSettings(facilityId)
      .then((r) => {
        if (cancelled) return;
        setSettings(r.ussd);
        setEnabled(r.ussd.enabled);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoadError(
            e instanceof ApiRequestError ? e.message : 'Could not load the USSD setting.',
          );
      });
    return (): void => {
      cancelled = true;
    };
  }, [facilityId]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setApiError(null);
    setSaved(null);
    try {
      const r = await api.setUssdSettings(facilityId, enabled);
      setSettings(r.ussd);
      setEnabled(r.ussd.enabled);
      const text = `USSD settings saved: ${r.ussd.enabled ? 'on' : 'off'}.`;
      setSaved(text);
      announce(text);
    } catch (err) {
      setApiError(
        err instanceof ApiRequestError
          ? err
          : new ApiRequestError(0, null, 'The setting could not be saved.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const s = settings;
  const sandbox = s?.deployment_mode === 'sandbox';
  return (
    <section aria-labelledby={`${id}-h`} className="card" data-testid="ussd-settings">
      <h3 id={`${id}-h`}>USSD phone menu</h3>
      {s === null && !loadError ? <Loading what="USSD setting" /> : null}
      {loadError ? (
        <p role="alert" className="alert alert-error">
          {loadError}
        </p>
      ) : null}
      {s ? (
        <>
          {sandbox ? (
            <p className="alert alert-warn" data-testid="ussd-sandbox-warning">
              <span aria-hidden="true">⚠ </span>Test mode — no real mobile-network USSD session
            </p>
          ) : null}
          <p data-testid="ussd-no-shortcode">
            There is no real USSD code to dial. In test mode the menu answers signed test requests
            only: enter the facility code, then 1 to join a queue, 2 to check a ticket or 3 to
            recover one (a ticket needs its code and recovery key), 9 to go back and 0 to end.
          </p>
          <ProviderMode channel="USSD" mode={s.deployment_mode} />
          <ul className="readiness" data-testid="ussd-readiness">
            <li>
              <Indicator ok={s.deployment_available}>
                {s.deployment_available
                  ? 'This deployment answers test sessions'
                  : 'This deployment is not set up for USSD'}
              </Indicator>
            </li>
            <li>
              <Indicator ok={s.enabled}>
                {s.enabled ? 'Turned on for this facility' : 'Off for this facility'}
              </Indicator>
            </li>
          </ul>
          {s.access_code ? (
            <p data-testid="ussd-access-code">
              Facility code: <strong>{s.access_code}</strong>
              <span className="hint">
                {' '}
                (public, for posters; it identifies the facility and opens no ticket
                {s.enabled ? '' : '; not answered while USSD is off'})
              </span>
            </p>
          ) : (
            <p className="muted">
              A 6-digit facility code is created the first time USSD is turned on.
            </p>
          )}
          <form noValidate onSubmit={(e) => void onSubmit(e)}>
            <ErrorSummary error={apiError} title="The USSD setting was not saved" />
            <fieldset disabled={!canConfigure || busy}>
              <legend className="visually-hidden">USSD settings</legend>
              <label className="check" htmlFor={`${id}-enabled`}>
                <input
                  type="checkbox"
                  id={`${id}-enabled`}
                  name="enabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Answer the USSD menu for this facility
              </label>
              {canConfigure ? (
                <div className="btn-row">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    aria-disabled={busy}
                    data-testid="ussd-save"
                  >
                    {busy ? 'Saving…' : 'Save USSD settings'}
                  </button>
                </div>
              ) : null}
            </fieldset>
            {saved ? (
              <p role="status" className="alert alert-success" data-testid="ussd-saved">
                <span aria-hidden="true">✓ </span>
                {saved}
              </p>
            ) : null}
          </form>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

/** Plain words per recorded state; `sent` is never "delivered", sandbox never reached a phone. */
export function smsRowText(r: SmsMonitorRow): string {
  const sandbox = r.provider_mode === 'sandbox';
  if (r.status === 'pending')
    return r.due_at ? 'Waiting for the delay (not sent yet)' : 'Not sent yet';
  if (r.status === 'sent') {
    return sandbox
      ? 'Accepted by the test provider (nothing sent to a phone)'
      : 'Accepted by the provider, not confirmed';
  }
  if (r.status === 'delivered') {
    return sandbox ? 'Test receipt (simulated, no real message)' : 'Delivered (provider receipt)';
  }
  if (r.status === 'failed')
    return r.detail_code === 'cap' ? 'Not sent: daily limit reached' : 'Failed';
  if (r.status === 'suppressed') {
    const why: Record<string, string> = {
      opted_out: 'visitor stopped text messages',
      alert_seen: 'the ticket page showed the alert first',
      ticket_changed: 'ticket no longer called',
      sms_disabled: 'SMS turned off',
      contact_removed: 'number removed',
    };
    return `Not sent (${why[r.detail_code ?? ''] ?? 'not needed'})`;
  }
  return 'Outcome unknown';
}

const fmt = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function SmsMonitorSection({ facilityId }: { facilityId: string }): ReactElement {
  const id = useId();
  const [data, setData] = useState<SmsMonitoring | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (before: string | null): Promise<void> => {
      setBusy(true);
      try {
        const r = await api.smsMonitor(facilityId, before);
        setData((prev) =>
          before && prev ? { ...r.monitor, rows: [...prev.rows, ...r.monitor.rows] } : r.monitor,
        );
        setError(null);
      } catch (e) {
        setError(e instanceof ApiRequestError ? e.message : 'Could not load SMS monitoring.');
      } finally {
        setBusy(false);
      }
    },
    [facilityId],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const c = data?.last_24h;
  return (
    <section aria-labelledby={`${id}-h`} className="card" data-testid="sms-monitor">
      <h3 id={`${id}-h`}>SMS delivery (recorded states)</h3>
      <p className="hint">
        “Accepted” means the provider took the message; only a provider receipt means delivered. In
        test mode nothing reaches a phone. Phone numbers and message text are never shown.
      </p>
      {error ? (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      ) : null}
      {!data && !error ? <Loading what="SMS monitoring" /> : null}
      {c ? (
        <dl className="stat-row" data-testid="sms-monitor-counts">
          {(
            [
              ['Waiting', c.pending],
              ['Accepted', c.sent],
              ['Receipts', c.delivered],
              ['Failed', c.failed],
              ['Limit reached', c.capped],
              ['Not sent', c.suppressed],
              ['Unknown', c.unknown],
            ] as const
          ).map(([label, n]) => (
            <div className="stat" key={label}>
              <dt>{label} (24 h)</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {data && data.rows.length === 0 ? (
        <p className="muted" data-testid="sms-monitor-empty">
          No text message turn alerts recorded here yet.
        </p>
      ) : null}
      {data && data.rows.length > 0 ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="SMS turn alerts table">
          <table className="data-table" data-testid="sms-monitor-table">
            <caption className="visually-hidden">Recent SMS turn alerts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Alert</th>
                <th scope="col">Created</th>
                <th scope="col">State</th>
                <th scope="col">Mode</th>
                <th scope="col">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={`${r.ticket_code}-${r.created_at}-${i}`}>
                  <td>{r.ticket_code}</td>
                  <td>{r.template === 'ticket.called' ? 'Called to counter' : r.template}</td>
                  <td>{fmt(r.created_at)}</td>
                  <td>
                    {smsRowText(r)}
                    {r.due_at ? <span className="hint"> (due {fmt(r.due_at)})</span> : null}
                  </td>
                  <td>
                    {r.provider_mode === 'sandbox'
                      ? 'Test'
                      : r.provider_mode === 'live'
                        ? 'Live'
                        : '—'}
                  </td>
                  <td>{r.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.next ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void load(data.next)}
          >
            {busy ? 'Loading…' : 'Show older'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function UssdMonitorSection({ facilityId }: { facilityId: string }): ReactElement {
  const id = useId();
  const [data, setData] = useState<UssdMonitoring | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .ussdMonitor(facilityId)
      .then((r) => {
        if (!cancelled) setData(r.monitor);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof ApiRequestError ? e.message : 'Could not load USSD monitoring.');
      });
    return (): void => {
      cancelled = true;
    };
  }, [facilityId]);
  const s = data?.sessions;
  return (
    <section aria-labelledby={`${id}-h`} className="card" data-testid="ussd-monitor">
      <h3 id={`${id}-h`}>USSD sessions</h3>
      <p className="hint">
        Sessions are kept for about an hour after they end, so these figures cover roughly the last
        hour. A session that timed out is never counted as a ticket.
      </p>
      {error ? (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      ) : null}
      {!data && !error ? <Loading what="USSD monitoring" /> : null}
      {s && data ? (
        <dl className="stat-row" data-testid="ussd-monitor-counts">
          {(
            [
              ['Open now', s.active],
              ['Ended by the menu', s.ended_by_menu],
              ['Timed out', s.expired],
              ['Out of order', s.out_of_step],
              ['Created a ticket', s.joined],
              ['USSD tickets today', data.tickets_today],
            ] as const
          ).map(([label, n]) => (
            <div className="stat" key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
