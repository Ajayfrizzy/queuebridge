import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { CapabilityManifest } from '@queuebridge/contracts';
import { useAuth } from '../auth.js';
import { api } from '../lib/api.js';
import { storedTickets, ticketPath } from '../lib/tickets.js';
import { loadCapabilities } from '../que/publicKb.js';
import { Onboarding, canAdminister } from './Onboarding.js';
import { ContinuityStory } from './ContinuityStory.js';
import { HeroArt } from './HeroArt.js';
import { LANDING_CHANNELS, channelView } from './channels.js';
import { createLandingI18n } from './i18n.js';
// The supplied logo, downscaled for bandwidth (M7.1); imported only by this chunk
import logoUrl from '../assets/brand/queuebridge-logo-720.png';
import './landing.css';

/** Project facts shown in the footer (the repository's real location and licence). */
export const REPOSITORY_URL = 'https://github.com/Ajayfrizzy/queuebridge';
export const JOIN_SECTION_ID = 'how-visitors-join';

/**
 * M7.2 public landing page at `/` (design §14.1, §14.4; REQ-F15.3). Loaded as its own lazy chunk:
 * no visitor, staff or admin route imports this folder. Collects nothing; the only requests are
 * the public capability manifest (channel status, fail closed) and, for a signed-in administrator,
 * the facility list and readiness through the existing authorized endpoints.
 */
export default function LandingPage(): ReactElement {
  const i18n = useMemo(() => createLandingI18n(), []);
  return (
    <I18nextProvider i18n={i18n}>
      <Landing />
    </I18nextProvider>
  );
}

function Landing(): ReactElement {
  const { t } = useTranslation();
  const { user } = useAuth();
  const tickets = storedTickets();
  const [manifest, setManifest] = useState<CapabilityManifest | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadCapabilities(() => api.queCapabilities()).then((m) => {
      if (!cancelled) setManifest(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const admin = user ? canAdminister(user) : false;
  return (
    <div className="landing" data-testid="landing">
      {tickets.length > 0 ? (
        <section
          aria-labelledby="my-tickets"
          className="alert alert-info landing-tickets"
          data-testid="my-tickets"
        >
          <h2 id="my-tickets" className="alert-title">
            {t('savedTickets.heading')}
          </h2>
          <p>{t('savedTickets.intro')}</p>
          <ul>
            {tickets.map((tk) => (
              <li key={tk.id}>
                <Link to={ticketPath(tk)}>
                  {t('savedTickets.item', {
                    code: tk.code,
                    service: tk.serviceName,
                    facility: tk.facilityName,
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <img
            className="hero-logo"
            src={logoUrl}
            alt={t('hero.logoAlt')}
            width={720}
            height={240}
          />
          <p className="hero-eyebrow">{t('hero.eyebrow')}</p>
          <h1 id="landing-title" className="hero-title">
            {t('hero.title')}
          </h1>
          <p className="hero-lead">{t('hero.lead')}</p>
          <div className="btn-row hero-actions">
            {user ? (
              <Link className="btn btn-primary btn-large" to={admin ? '/admin' : '/staff'}>
                {admin ? t('hero.continue') : t('hero.staffConsole')}
              </Link>
            ) : (
              <>
                <Link className="btn btn-primary btn-large" to="/signup">
                  {t('hero.primary')}
                </Link>
                <Link className="btn btn-secondary btn-large hero-secondary" to="/login">
                  {t('hero.secondary')}
                </Link>
              </>
            )}
            <a className="btn btn-tertiary hero-tertiary" href={`#${JOIN_SECTION_ID}`}>
              {t('hero.tertiary')}
            </a>
          </div>
        </div>
        <div className="hero-visual">
          <HeroArt />
        </div>
      </section>

      <ContinuityStory />
      <Audiences />
      <Capabilities />
      <Channels manifest={manifest} />
      <JoinHowTo />
      <Onboarding user={user} />
      <Footer />
    </div>
  );
}

function CardGrid({
  section,
  testid,
}: {
  section: 'audiences' | 'capabilities';
  testid: string;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const items = t(`${section}.items`, { returnObjects: true }) as { title: string; body: string }[];
  return (
    <section aria-labelledby={`${id}-h`} className="landing-section" data-testid={testid}>
      <h2 id={`${id}-h`}>{t(`${section}.heading`)}</h2>
      <ul className="landing-cards">
        {items.map((it) => (
          <li key={it.title} className="card landing-card">
            <h3>{it.title}</h3>
            <p>{it.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
const Audiences = (): ReactElement => <CardGrid section="audiences" testid="audiences" />;
const Capabilities = (): ReactElement => <CardGrid section="capabilities" testid="capabilities" />;

const STATUS_SYMBOL: Record<string, string> = {
  live: '✓',
  sandbox: '⚠',
  preview: '◐',
  planned: '○',
  notSetUp: '○',
  switchedOff: '○',
  unknown: '?',
};

function Channels({ manifest }: { manifest: CapabilityManifest | null | undefined }): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="landing-section" data-testid="channels">
      <h2 id={`${id}-h`}>{t('channels.heading')}</h2>
      <p className="landing-intro">{t('channels.intro')}</p>
      {manifest === undefined ? (
        <p role="status" className="muted" data-testid="channels-loading">
          {t('channels.loading')}
        </p>
      ) : (
        <>
          {manifest === null ? (
            <p className="alert alert-warn" data-testid="channels-unavailable">
              {t('channels.unavailableAll')}
            </p>
          ) : null}
          <ul className="landing-cards channel-list">
            {LANDING_CHANNELS.map((c) => {
              const v = channelView(manifest, c);
              return (
                <li
                  key={c}
                  className={`card channel-card channel-${v.status}`}
                  data-testid={`channel-${c}`}
                  data-status={v.status}
                  data-usable={v.usable ? 'true' : 'false'}
                >
                  <h3>{t(`channels.names.${c}`)}</h3>
                  <p>
                    <span
                      className={`badge channel-badge ${v.usable ? 'badge-ok' : v.status === 'sandbox' ? 'badge-priority' : 'badge-off'}`}
                      data-testid="channel-status"
                    >
                      <span aria-hidden="true">{STATUS_SYMBOL[v.status]} </span>
                      {t(`channels.status.${v.status}`)}
                    </span>
                  </p>
                  <p data-testid="channel-explain">{t(`channels.explain.${v.explain}`)}</p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function JoinHowTo(): ReactElement {
  const { t } = useTranslation();
  const steps = t('join.steps', { returnObjects: true }) as string[];
  return (
    <section
      id={JOIN_SECTION_ID}
      tabIndex={-1}
      aria-labelledby={`${JOIN_SECTION_ID}-h`}
      className="landing-section join-howto"
      data-testid="join-howto"
    >
      <h2 id={`${JOIN_SECTION_ID}-h`}>{t('join.heading')}</h2>
      <ol className="join-steps">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="muted">{t('join.noPhone')}</p>
    </section>
  );
}

function Footer(): ReactElement {
  const { t } = useTranslation();
  return (
    <footer className="landing-footer" data-testid="landing-footer">
      <div className="footer-grid">
        <section aria-labelledby="footer-privacy">
          <h2 id="footer-privacy">{t('footer.privacyHeading')}</h2>
          <p>{t('footer.privacy')}</p>
        </section>
        <section aria-labelledby="footer-a11y">
          <h2 id="footer-a11y">{t('footer.accessibilityHeading')}</h2>
          <p>{t('footer.accessibility')}</p>
        </section>
        <section aria-labelledby="footer-project">
          <h2 id="footer-project">{t('footer.projectHeading')}</h2>
          <p>
            <a href={REPOSITORY_URL} rel="noopener noreferrer">
              {t('footer.repository')}
            </a>
          </p>
          <p>{t('footer.license')}</p>
        </section>
        <nav aria-label={t('footer.navLabel')}>
          <h2>{t('footer.navHeading')}</h2>
          <ul className="plain-list">
            <li>
              <Link to="/signup">{t('footer.nav.signup')}</Link>
            </li>
            <li>
              <Link to="/login">{t('footer.nav.signin')}</Link>
            </li>
            <li>
              <Link to="/recover">{t('footer.nav.recover')}</Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
