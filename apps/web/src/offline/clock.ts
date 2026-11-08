import type { ClockReading } from '@queuebridge/continuity';

/**
 * Random id for this page load. The monotonic clock (`performance.now()`) is only comparable
 * within one page session; across reloads the persisted elapsed-time floor takes over.
 */
export const PAGE_SESSION: string =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/** Read the device clocks. The wall clock is untrusted; it is only cross-checked. */
export function readClock(): ClockReading {
  return { wallMs: Date.now(), perfMs: performance.now(), pageSession: PAGE_SESSION };
}
