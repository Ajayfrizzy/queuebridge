import React from 'react';

export type ConnectivityState = 'online' | 'offline' | 'degraded' | 'reconnecting';

export interface QueueStatusBannerProps {
  connectivity: ConnectivityState;
  pendingCount?: number;
  coordinatorActive?: boolean;
  className?: string;
}

const CONNECTIVITY_CONFIG: Record<
  ConnectivityState,
  { message: string; ariaLive: 'polite' | 'assertive'; className: string }
> = {
  online: {
    message: 'Connected',
    ariaLive: 'polite',
    className: 'qb-banner-online',
  },
  offline: {
    message: 'Offline — changes are saved locally and will sync when connection returns',
    ariaLive: 'assertive',
    className: 'qb-banner-offline',
  },
  degraded: {
    message: 'Connection degraded — some updates may be delayed',
    ariaLive: 'polite',
    className: 'qb-banner-degraded',
  },
  reconnecting: {
    message: 'Reconnecting…',
    ariaLive: 'polite',
    className: 'qb-banner-reconnecting',
  },
};

/**
 * QueueStatusBanner — connectivity and sync health indicator.
 *
 * Accessibility:
 * - ARIA live region announces connectivity changes to screen readers
 * - assertive for offline (critical), polite for degraded
 * - Never hidden from assistive technology
 */
export function QueueStatusBanner({
  connectivity,
  pendingCount = 0,
  coordinatorActive = false,
  className = '',
}: QueueStatusBannerProps): React.ReactElement {
  const config = CONNECTIVITY_CONFIG[connectivity];

  const fullMessage =
    connectivity === 'offline' && pendingCount > 0
      ? `${config.message} (${pendingCount} action${pendingCount !== 1 ? 's' : ''} pending sync)`
      : config.message;

  return (
    <div
      className={`qb-status-banner ${config.className} ${className}`}
      role="status"
      aria-live={config.ariaLive}
      aria-atomic="true"
      data-testid="queue-status-banner"
      data-connectivity={connectivity}
    >
      <span className="qb-banner-message">{fullMessage}</span>
      {connectivity === 'offline' && coordinatorActive && (
        <span className="qb-coordinator-badge" aria-label="Offline coordinator active">
          Coordinator mode active
        </span>
      )}
      {connectivity === 'offline' && !coordinatorActive && (
        <span className="qb-readonly-badge" aria-label="Read-only offline mode">
          Ticket capture only
        </span>
      )}
    </div>
  );
}
