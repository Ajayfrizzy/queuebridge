import { useEffect, useId, useState, type ReactElement } from 'react';
import {
  QUE_AI_CONSENT_TEXT,
  QUE_AI_CONSENT_VERSION,
  type QueAiSettings,
} from '@queuebridge/contracts';
import { useAnnounce } from '../components/Announcer.js';
import { api, ApiRequestError } from '../lib/api.js';

/**
 * Facility opt-in for Ask Que AI explanations (MQ.4; REQ-F13.4.4). Off by default. Turning it on
 * needs a facility or organization administrator to acknowledge the disclosure; the API checks
 * the role and records an audited admin event. Opting in never makes AI work by itself: the page
 * says so plainly when this deployment has no approved, zero-cost provider.
 */
export function QueAiSettingsSection({
  facilityId,
  canConfigure,
}: {
  facilityId: string;
  canConfigure: boolean;
}): ReactElement {
  const announce = useAnnounce();
  const headingId = useId();
  const consentId = useId();
  const [settings, setSettings] = useState<QueAiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .queAiSettings(facilityId)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof ApiRequestError ? e.message : 'Could not load this setting.');
      });
    return (): void => {
      cancelled = true;
    };
  }, [facilityId]);

  async function save(enabled: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setQueAiSettings(
        facilityId,
        enabled
          ? { enabled: true, consent_version: QUE_AI_CONSENT_VERSION, consent_acknowledged: true }
          : { enabled: false },
      );
      setSettings(next);
      setAgreed(false);
      announce(
        enabled
          ? 'AI explanations turned on for this facility.'
          : 'AI explanations turned off for this facility.',
      );
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'The setting could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} data-testid="que-ai-settings">
      <h2 id={headingId}>Ask Que AI explanations</h2>
      {settings === null && !error ? <p>Loading…</p> : null}
      {error ? (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      ) : null}
      {settings ? (
        <>
          <p data-testid="que-ai-state">
            {settings.opted_in
              ? `On for this facility${settings.consented_at ? ` (agreed ${new Date(settings.consented_at).toLocaleDateString()})` : ''}.`
              : 'Off for this facility (default).'}
          </p>
          {!settings.deployment_available ? (
            <p className="muted" data-testid="que-ai-deployment">
              Not available on this deployment: no AI provider is set up, so Ask Que uses built-in
              help only.{settings.opted_in ? ' The opt-in is recorded but has no effect.' : ''}
            </p>
          ) : null}
          {canConfigure ? (
            settings.opted_in ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void save(false)}
              >
                Turn off AI explanations
              </button>
            ) : (
              <div className="que-ai-consent">
                <p id={`${consentId}-text`}>{QUE_AI_CONSENT_TEXT}</p>
                <p>
                  <input
                    type="checkbox"
                    id={consentId}
                    checked={agreed}
                    aria-describedby={`${consentId}-text`}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />{' '}
                  <label htmlFor={consentId}>
                    I have read this and agree to turn on AI explanations for this facility.
                  </label>
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!agreed || busy}
                  onClick={() => void save(true)}
                >
                  Turn on AI explanations
                </button>
              </div>
            )
          ) : (
            <p className="muted">Only a facility administrator can change this.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
