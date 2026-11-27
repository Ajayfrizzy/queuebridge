import type { WaitEstimate } from '@queuebridge/contracts';

/** Interval in whole minutes, rounded outward so it never narrows into an exact-looking time. */
export function formatEstimate(e: WaitEstimate | null): string {
  if (!e) return 'No estimate';
  if (e.confidence === 'insufficient_data') return 'Not enough information for an estimate yet';
  const low = Math.floor(e.low_seconds / 60);
  const high = Math.max(low + 1, Math.ceil(e.high_seconds / 60));
  return low === 0 ? `Up to about ${high} min` : `About ${low}–${high} min`;
}

export const CONFIDENCE_LABEL: Record<WaitEstimate['confidence'], string> = {
  high: 'Higher confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  insufficient_data: 'Not enough data',
};

export const STATE_LABEL: Record<string, string> = {
  waiting: 'Waiting',
  called: 'Called',
  serving: 'Being served',
  paused: 'On hold',
  missed: 'Missed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  transferred: 'Transferred',
  needs_review: 'Needs review',
  open: 'Open',
  closed: 'Closed',
};

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
