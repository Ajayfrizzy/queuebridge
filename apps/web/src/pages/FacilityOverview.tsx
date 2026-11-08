import { useMemo, type ReactElement } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useAnnounce } from '../components/Announcer.js';
import { Loading, StatusBadge } from '../components/Form.js';
import { api } from '../lib/api.js';
import { buildQr, qrPath, qrSvgDocument, QUIET_ZONE } from '../lib/qr.js';
import { useLoad } from '../lib/useLoad.js';
import type { FacilityContext } from './FacilityLayout.js';

export function FacilityOverview(): ReactElement {
  const { facilityId } = useOutletContext<FacilityContext>();
  const announce = useAnnounce();
  const link = useLoad(() => api.joinLink(facilityId), facilityId);
  const readiness = useLoad(() => api.readiness(facilityId), `ready-${facilityId}`);

  const url = link.data?.join_link.url ?? null;
  const matrix = useMemo(() => (url ? buildQr(url) : null), [url]);
  const downloadHref = useMemo(
    () =>
      matrix && url
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvgDocument(matrix, `Join ${url}`))}`
        : null,
    [matrix, url],
  );

  if (link.loading || readiness.loading) return <Loading what="facility overview" />;
  if (link.error || readiness.error || !url || !matrix || !readiness.data) {
    return (
      <p role="alert">
        {link.error?.message ?? readiness.error?.message ?? 'The facility overview is unavailable.'}
      </p>
    );
  }
  const r = readiness.data.readiness;
  const total = matrix.size + QUIET_ZONE * 2;
  const joinOperational = r.visitor_join.operational;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url ?? '');
      announce('Join link copied to clipboard.');
    } catch {
      announce('Could not copy automatically. Select the link and copy it manually.');
    }
  }

  return (
    <div className="split">
      <div className="split-main">
        <section aria-labelledby="readiness-heading">
          <h2 id="readiness-heading">Configuration readiness</h2>
          <p data-testid="readiness-status">
            <StatusBadge
              active={r.configuration_ready}
              on="Configuration ready"
              off="Setup incomplete"
            />
          </p>
          <p className="muted">
            Ready means at least one <strong>active counter</strong> is set to serve at least one{' '}
            <strong>active service</strong>. Having services and counters is not enough on its own.
          </p>

          {r.issues.length > 0 ? (
            <div className="alert alert-info" data-testid="readiness-issues">
              <h3 className="alert-title">To finish setup</h3>
              <ul>
                {r.issues.map((i) => (
                  <li key={i.code} data-code={i.code}>
                    {i.message}
                  </li>
                ))}
              </ul>
              <p>
                <Link to={`/admin/facilities/${facilityId}/services`}>Open services setup</Link> ·{' '}
                <Link to={`/admin/facilities/${facilityId}/counters`}>Open counters setup</Link>
              </p>
            </div>
          ) : null}

          <h3>Services</h3>
          {r.services.length === 0 ? <p className="muted">No services yet.</p> : null}
          <ul className="plain-list" data-testid="readiness-services">
            {r.services.map((s) => (
              <li key={s.id} data-testid="readiness-service">
                <strong>{s.name}</strong> —{' '}
                {s.status === 'inactive' ? (
                  <span>Inactive: not available to visitors</span>
                ) : s.operational ? (
                  <span>
                    Served by {s.active_counter_count} active counter
                    {s.active_counter_count === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span>
                    {s.configured_counter_count > 0
                      ? 'Only inactive counters serve this service'
                      : 'No counter serves this service yet'}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h3>Counters</h3>
          {r.counters.length === 0 ? <p className="muted">No counters yet.</p> : null}
          <ul className="plain-list" data-testid="readiness-counters">
            {r.counters.map((c) => (
              <li key={c.id} data-testid="readiness-counter">
                <strong>{c.name}</strong> —{' '}
                {!c.active ? (
                  <span>
                    Inactive: not operational
                    {c.configured_service_count > 0
                      ? ` (${c.configured_service_count} service assignment${c.configured_service_count === 1 ? '' : 's'} kept)`
                      : ''}
                  </span>
                ) : c.operational ? (
                  <span>
                    Serving {c.active_service_count} active service
                    {c.active_service_count === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span>Active, but no active service assigned</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="split-side printable" aria-labelledby="join-heading">
        <h2 id="join-heading">Visitor join link and QR code</h2>
        {!joinOperational ? (
          <div className="alert alert-info" role="note" data-testid="join-notice">
            <h3 className="alert-title">Not live yet</h3>
            <p>
              {r.visitor_join.reason} Do not share or print this code for visitors until it is live.
            </p>
          </div>
        ) : (
          <div className="alert alert-success" role="note" data-testid="join-live">
            <h3 className="alert-title">Live</h3>
            <p>{r.visitor_join.reason}</p>
          </div>
        )}
        <p>
          <span className="visually-hidden">Join link: </span>
          <a href={url} data-testid="join-url" className="mono wrap">
            {url}
          </a>
        </p>
        <svg
          role="img"
          aria-label={
            joinOperational
              ? `QR code for the join link ${url}`
              : `QR code for the join link ${url} (preview only: not live yet)`
          }
          viewBox={`0 0 ${total} ${total}`}
          className="qr"
          data-testid="join-qr"
          shapeRendering="crispEdges"
        >
          <rect width={total} height={total} fill="#fff" />
          <path
            transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}
            fill="#000"
            d={qrPath(matrix)}
          />
        </svg>
        <p className="no-print">
          <a
            href={new URL(url).pathname.replace(/^\/join\//, '/display/')}
            data-testid="display-link"
          >
            Open the public display board
          </a>{' '}
          (for a screen in the waiting area; shows ticket codes only)
        </p>
        <div className="btn-row no-print">
          <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
            Copy link
          </button>
          {downloadHref ? (
            <a className="btn btn-secondary" href={downloadHref} download="queuebridge-join-qr.svg">
              Download QR (SVG)
            </a>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </aside>
    </div>
  );
}
