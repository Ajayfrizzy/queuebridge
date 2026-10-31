import React from 'react';
import { SyncStatus } from '@queuebridge/contracts';

export interface SyncStateIndicatorProps {
  status: SyncStatus;
  className?: string;
}

/** Labels and ARIA descriptions for each sync state */
const STATE_CONFIG: Record<
  SyncStatus,
  { label: string; description: string; colorClass: string; symbol: string }
> = {
  [SyncStatus.LOCAL_ONLY]: {
    label: 'Local',
    description: 'Saved locally — not yet sent to server',
    colorClass: 'qb-sync-local',
    symbol: '⬤',
  },
  [SyncStatus.PENDING_SYNC]: {
    label: 'Pending sync',
    description: 'Waiting to send to server',
    colorClass: 'qb-sync-pending',
    symbol: '↑',
  },
  [SyncStatus.COMMITTED]: {
    label: 'Synced',
    description: 'Confirmed by server',
    colorClass: 'qb-sync-committed',
    symbol: '✓',
  },
  [SyncStatus.DUPLICATE]: {
    label: 'Duplicate',
    description: 'Already processed — no change needed',
    colorClass: 'qb-sync-duplicate',
    symbol: '=',
  },
  [SyncStatus.NEEDS_REVIEW]: {
    label: 'Needs review',
    description: 'Conflict detected — supervisor review required',
    colorClass: 'qb-sync-review',
    symbol: '!',
  },
  [SyncStatus.REJECTED]: {
    label: 'Rejected',
    description: 'Server rejected this action',
    colorClass: 'qb-sync-rejected',
    symbol: '✕',
  },
};

/**
 * SyncStateIndicator — displays the offline/online sync status of an operation.
 *
 * Accessibility:
 * - Uses aria-label with full description (not just the symbol)
 * - Does not rely on color alone — symbol + label present
 * - Screen-reader friendly via role="status" on parent
 */
export function SyncStateIndicator({
  status,
  className = '',
}: SyncStateIndicatorProps): React.ReactElement {
  const config = STATE_CONFIG[status];
  return (
    <span
      className={`qb-sync-indicator ${config.colorClass} ${className}`}
      aria-label={config.description}
      title={config.description}
      data-testid="sync-state-indicator"
      data-sync-status={status}
    >
      <span aria-hidden="true" className="qb-sync-symbol">
        {config.symbol}
      </span>
      <span className="qb-sync-label">{config.label}</span>
    </span>
  );
}
