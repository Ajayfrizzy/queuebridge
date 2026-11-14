import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { AlertSummary } from '@queuebridge/contracts';
import { useAuth } from '../auth.js';
import { api } from '../lib/api.js';
import { useOffline } from '../offline/OfflineProvider.js';
import { useAnnounce } from './Announcer.js';

const POLL_MS = 30_000;

/**
 * Persistent banner on staff screens while device-health alerts are open (REQ-F9.8). The server
 * decides who sees what: staff without OPERATIONS_VIEW always get an empty summary. Not a live
 * region (it would repeat every refresh): a rise in high-priority alerts is announced once.
 */
export function HealthAlertBanner(): ReactElement | null {
  const { user } = useAuth();
  const { reachable } = useOffline();
  const announce = useAnnounce();
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const lastHigh = useRef<number | null>(null);

  useEffect(() => {
    if (!user || !reachable) return undefined;
    let stop = false;
    const load = (): void => {
      api
        .alertSummary()
        .then((r) => {
          if (stop) return;
          setSummary(r.summary);
          const prev = lastHigh.current;
          lastHigh.current = r.summary.high;
          if (prev !== null && r.summary.high > prev) {
            announce(
              `${r.summary.high} high-priority device ${r.summary.high === 1 ? 'alert is' : 'alerts are'} open.`,
            );
          }
        })
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, POLL_MS);
    return (): void => {
      stop = true;
      clearInterval(t);
    };
  }, [user, reachable, announce]);

  useEffect(() => {
    if (!user) {
      setSummary(null);
      lastHigh.current = null;
    }
  }, [user]);

  if (!user || !summary || summary.open === 0) return null;
  return (
    <div className="container">
      <section
        aria-labelledby="alert-banner-title"
        className={`alert ${summary.high > 0 ? 'alert-error' : 'alert-warn'} alert-banner`}
        data-testid="health-alert-banner"
      >
        <h2 id="alert-banner-title" className="alert-title">
          <span aria-hidden="true">{summary.high > 0 ? '▲ ' : '■ '}</span>
          {summary.open} open device {summary.open === 1 ? 'alert' : 'alerts'}
          {summary.high > 0 ? ` (${summary.high} high priority)` : ''}
        </h2>
        <ul className="plain-list">
          {summary.facilities.map((f) => (
            <li key={f.facility_id}>
              <Link to={`/staff/facilities/${f.facility_id}/connectivity`}>
                {f.facility_name}: {f.open} open{f.high > 0 ? `, ${f.high} high` : ''}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
