import React from 'react';
import { type SyncStatus, TicketState, type WaitEstimate } from '@queuebridge/contracts';
import { SyncStateIndicator } from './SyncStateIndicator.js';

export interface TicketCardProps {
  publicCode: string;
  state: TicketState;
  syncStatus: SyncStatus;
  waitEstimate?: WaitEstimate | undefined;
  /** True when this is a provisional (offline-only) ticket — code is temporary */
  provisional?: boolean;
  className?: string;
}

const STATE_LABELS: Record<TicketState, string> = {
  [TicketState.WAITING]: 'Waiting',
  [TicketState.CALLED]: 'Called — please proceed to counter',
  [TicketState.SERVING]: 'Being served',
  [TicketState.PAUSED]: 'Paused',
  [TicketState.MISSED]: 'Missed turn',
  [TicketState.COMPLETED]: 'Completed',
  [TicketState.CANCELLED]: 'Cancelled',
  [TicketState.TRANSFERRED]: 'Transferred',
  [TicketState.NEEDS_REVIEW]: 'Needs review',
};

/**
 * TicketCard — displays a visitor's queue ticket.
 *
 * Accessibility:
 * - Uses semantic article element with aria-label
 * - ARIA live region on status for screen-reader announcements
 * - Wait estimate shown as text interval, never exact time
 * - Provisional status clearly labeled
 */
export function TicketCard({
  publicCode,
  state,
  syncStatus,
  waitEstimate,
  provisional = false,
  className = '',
}: TicketCardProps): React.ReactElement {
  const stateLabel = STATE_LABELS[state];

  return (
    <article
      className={`qb-ticket-card ${className}`}
      aria-label={`Ticket ${publicCode}: ${stateLabel}`}
    >
      <header className="qb-ticket-header">
        <div className="qb-ticket-code-wrapper">
          <span className="qb-ticket-label" aria-hidden="true">
            Ticket
          </span>
          <span className="qb-ticket-code" data-testid="ticket-code">
            {publicCode}
          </span>
          {provisional && (
            <span
              className="qb-ticket-provisional"
              aria-label="Provisional — not yet confirmed by server"
              title="This is a temporary reference. Your ticket number will be confirmed when connectivity is restored."
            >
              (provisional)
            </span>
          )}
        </div>
        <SyncStateIndicator status={syncStatus} />
      </header>

      <div
        className="qb-ticket-state"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="ticket-state"
      >
        {stateLabel}
      </div>

      {waitEstimate && waitEstimate.confidence !== 'insufficient_data' && (
        <div className="qb-ticket-estimate" aria-label="Estimated wait time">
          <span className="qb-estimate-label">Estimated wait:</span>
          <span className="qb-estimate-value" data-testid="wait-estimate">
            {formatWaitInterval(waitEstimate.low_seconds, waitEstimate.high_seconds)}
          </span>
          <span className="qb-estimate-confidence" aria-hidden="true">
            ({waitEstimate.confidence} confidence)
          </span>
          <ul className="qb-estimate-factors" aria-label="Estimate factors">
            {waitEstimate.factors.map((factor: string, i: number) => (
              <li key={i}>{factor}</li>
            ))}
          </ul>
        </div>
      )}

      {waitEstimate && waitEstimate.confidence === 'insufficient_data' && (
        <div className="qb-ticket-estimate qb-estimate-unknown" aria-live="polite">
          Wait time estimate not available yet — insufficient service history.
        </div>
      )}
    </article>
  );
}

function formatWaitInterval(lowSeconds: number, highSeconds: number): string {
  const low = formatDuration(lowSeconds);
  const high = formatDuration(highSeconds);
  return `${low} – ${high}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}
