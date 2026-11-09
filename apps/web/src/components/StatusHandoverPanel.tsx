import { useEffect, useRef, useState, type ReactElement } from 'react';
import { SyncStatus } from '@queuebridge/contracts';
import type { OutboxOperation, StatusHandover } from '@queuebridge/continuity';
import { SyncStateIndicator } from '@queuebridge/ui';
import { buildQr, qrPath, QUIET_ZONE } from '../lib/qr.js';
import { useAnnounce } from './Announcer.js';

function linkFor(h: StatusHandover): string {
  // The secret travels in the fragment, which browsers never send to servers or log
  return new URL(
    `/ticket/${encodeURIComponent(h.public_code)}#t=${h.status_token}`,
    window.location.origin,
  ).toString();
}

function HandoverCard({ h, onDone }: { h: StatusHandover; onDone: () => void }): ReactElement {
  const link = linkFor(h);
  const qr = buildQr(link);
  const total = qr.size + QUIET_ZONE * 2;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="alert alert-success qr-panel" data-testid="handover">
      <h3 ref={heading} tabIndex={-1} className="alert-title">
        Confirmed: <span data-testid="handover-code">{h.public_code}</span>
      </h3>
      <p>
        <SyncStateIndicator status={SyncStatus.COMMITTED} /> The server confirmed this ticket. Give
        the visitor their code. If they have a phone, they can scan this to follow their place.
      </p>
      <svg
        role="img"
        aria-label={`QR code with the status link for ticket ${h.public_code}`}
        viewBox={`0 0 ${total} ${total}`}
        className="qr"
        shapeRendering="crispEdges"
      >
        <rect width={total} height={total} fill="#fff" />
        <path transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} fill="#000" d={qrPath(qr)} />
      </svg>
      <details>
        <summary>Show status link</summary>
        <code className="mono wrap" data-testid="handover-link">
          {link}
        </code>
      </details>
      <p className="hint">
        This link is shown once and is not saved on this device. Issuing a replacement later cancels
        this one.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done — handed to visitor<span className="visually-hidden"> {h.public_code}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * One-time hand-over of the visitor status link for tickets captured offline and now confirmed
 * by the server. Only the person who captured a ticket sees it (credentials are held in memory
 * of their own session); the code shown is always the server-confirmed code.
 */
export function StatusHandoverPanel({
  handovers,
  confirmedCaptures,
  onDone,
  onReissue,
}: {
  handovers: StatusHandover[];
  /** This user's confirmed offline captures for the queue (for re-issuing a lost link) */
  confirmedCaptures: OutboxOperation[];
  onDone: (operationId: string) => void;
  onReissue: (operationId: string) => Promise<boolean>;
}): ReactElement | null {
  const announce = useAnnounce();
  const [failed, setFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const reissuable = confirmedCaptures.filter(
    (o) => o.result?.public_code && !handovers.some((h) => h.operation_id === o.operation_id),
  );
  useEffect(() => {
    if (handovers.length > 0) {
      announce(
        `${handovers.length} offline ${handovers.length === 1 ? 'ticket is' : 'tickets are'} now confirmed. Give the visitor their status link.`,
      );
    }
  }, [handovers.length, announce]);
  if (handovers.length === 0 && reissuable.length === 0) return null;
  return (
    <section aria-labelledby="handover-heading" className="card" data-testid="handover-panel">
      <h2 id="handover-heading" className="card-title">
        Confirmed offline tickets
      </h2>
      {handovers.map((h) => (
        <HandoverCard key={h.operation_id} h={h} onDone={() => onDone(h.operation_id)} />
      ))}
      {reissuable.length > 0 ? (
        <>
          <p className="hint">
            Lost the link for a confirmed ticket? You can issue a replacement. Issuing one{' '}
            <strong>cancels the visitor&apos;s current link</strong>.
          </p>
          <ul className="plain-list">
            {reissuable.map((o) => {
              const code = o.result?.public_code ?? '';
              return (
                <li key={o.operation_id}>
                  {confirming === o.operation_id ? (
                    <div role="alert" className="alert alert-warn" data-testid="reissue-warning">
                      <p>
                        <strong>Replace the status link for {code}?</strong> The link and QR code
                        the visitor already has will <strong>stop working immediately</strong>. Only
                        do this if the visitor never received it or has lost it.
                      </p>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => {
                            setConfirming(null);
                            void onReissue(o.operation_id).then((ok) => {
                              setFailed(ok ? null : o.operation_id);
                              if (!ok) {
                                announce(
                                  'The status link could not be fetched. Check the connection.',
                                );
                              }
                            });
                          }}
                        >
                          Replace link — old link stops working
                          <span className="visually-hidden"> for {code}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setConfirming(null)}
                        >
                          Keep current link<span className="visually-hidden"> for {code}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setConfirming(o.operation_id)}
                    >
                      New status link for {code}
                    </button>
                  )}
                  {failed === o.operation_id ? (
                    <span role="alert" className="field-error">
                      {' '}
                      Could not fetch a link right now. The visitor&apos;s current link is unchanged
                      unless a new one was shown.
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
