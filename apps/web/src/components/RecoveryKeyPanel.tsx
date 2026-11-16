import { useState, type ReactElement } from 'react';
import { formatRecoveryKey } from '@queuebridge/contracts';
import { buildQr, qrPath, QUIET_ZONE } from '../lib/qr.js';
import { recoveryKeyText, recoveryLink } from '../lib/recoveryKey.js';
import { useAnnounce } from './Announcer.js';

interface Props {
  facilityName: string;
  code: string;
  /** The key, shown once. Never persisted by this component. */
  recoveryKey: string;
  /** Public recovery path (no secret) */
  path: string;
  /** Show the heading as h2 (default) inside a page that already has an h1 */
  onDone?: () => void;
}

/**
 * Presents a recovery key once, in three equivalent forms (REQ-F4.8): a QR code/link for another
 * device, readable grouped text for reading out or writing down, and Copy / Share / Save / Print
 * actions. Every action works without a pointer; nothing here stores the key.
 */
export function RecoveryKeyPanel({
  facilityName,
  code,
  recoveryKey,
  path,
  onDone,
}: Props): ReactElement {
  const announce = useAnnounce();
  const [showQr, setShowQr] = useState(false);
  const grouped = formatRecoveryKey(recoveryKey);
  const link = recoveryLink(window.location.origin, path, recoveryKey);
  const qr = showQr ? buildQr(link) : null;
  const total = qr ? qr.size + QUIET_ZONE * 2 : 0;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(grouped);
      announce('Recovery key copied.');
    } catch {
      announce('Could not copy automatically. Select the key text and copy it by hand.');
    }
  }
  async function share(): Promise<void> {
    try {
      await navigator.share({ title: `Ticket ${code} recovery key`, text: grouped });
    } catch {
      // Cancelled or unsupported: nothing was shared, nothing to report
    }
  }
  function save(): void {
    const blob = new Blob([recoveryKeyText(facilityName, code, recoveryKey)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `queuebridge-recovery-${code}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    announce('Recovery key saved as a text file.');
  }

  return (
    <section
      aria-labelledby="recovery-key-heading"
      className="card recovery-key-panel"
      data-testid="recovery-key-panel"
    >
      <p className="print-only" data-testid="recovery-print-heading">
        QueueBridge recovery key for ticket <strong>{code}</strong> at {facilityName}
      </p>
      <h2 id="recovery-key-heading" className="card-title">
        Your recovery key
      </h2>
      <p className="screen-only">
        Save this now. It is shown <strong>only once</strong> on this page. If you lose your phone
        or clear your browser, the key is how you get your ticket back. Your ticket code{' '}
        <strong>{code}</strong> alone is not enough, so keep the key private.
      </p>
      <p className="recovery-key-text mono" data-testid="recovery-key-text">
        <span className="visually-hidden">Recovery key: </span>
        {grouped}
      </p>
      <p className="print-only">
        Keep this private. With it, anyone can get access to your ticket status. Your ticket code
        alone cannot be used to recover your ticket. Open the QueueBridge recover page and enter the
        facility, ticket code and this key.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          Copy key
        </button>
        {canShare ? (
          <button type="button" className="btn btn-secondary" onClick={() => void share()}>
            Share key
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={save}>
          Save as file
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          Print
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={showQr}
          onClick={() => setShowQr((v) => !v)}
        >
          {showQr ? 'Hide QR code' : 'Show QR code'}
        </button>
      </div>
      {qr ? (
        <div className="qr-panel" data-testid="recovery-qr">
          <svg
            role="img"
            aria-label={`QR code that recovers ticket ${code} on another device. Treat it like the key.`}
            viewBox={`0 0 ${total} ${total}`}
            className="qr"
            shapeRendering="crispEdges"
          >
            <rect width={total} height={total} fill="#fff" />
            <path transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} fill="#000" d={qrPath(qr)} />
          </svg>
          <p className="hint">
            Scan this on another phone to open your ticket there. Anyone who scans it can open your
            ticket, so do not post it.
          </p>
        </div>
      ) : null}
      {onDone ? (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            I have saved my key
          </button>
        </div>
      ) : null}
    </section>
  );
}
