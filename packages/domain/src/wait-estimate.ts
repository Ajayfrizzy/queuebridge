import type { WaitEstimate } from '@queuebridge/contracts';

export interface WaitEstimateInput {
  /** Number of eligible tickets ahead of this position (by priority class and service) */
  position: number;
  /** Number of counters currently active and compatible with this service */
  activeCompatibleCounters: number;
  /** Recent service duration samples in seconds */
  serviceSamples: number[];
  /** ISO datetime of when this estimate was calculated */
  calculatedAt: string;
}

/** Minimum sample size before producing a confident estimate */
const MIN_SAMPLES = 5;

/**
 * Compute a wait-time estimate interval.
 *
 * Pure function — no I/O, no side effects.
 * Returns an interval [low, high] with confidence indicator and explanation.
 * NEVER returns an exact time — always an interval.
 */
export function computeWaitEstimate(input: WaitEstimateInput): WaitEstimate {
  const { position, activeCompatibleCounters, serviceSamples, calculatedAt } = input;

  const factors: string[] = [];

  if (activeCompatibleCounters === 0) {
    factors.push('No active counters for this service');
    return {
      low_seconds: 0,
      high_seconds: 0,
      confidence: 'insufficient_data',
      factors,
      calculated_at: calculatedAt,
      sample_size: serviceSamples.length,
    };
  }

  if (serviceSamples.length < MIN_SAMPLES) {
    factors.push(
      `Insufficient service history (${serviceSamples.length} samples, need ≥${MIN_SAMPLES})`,
    );
    factors.push(
      `${activeCompatibleCounters} counter${activeCompatibleCounters > 1 ? 's' : ''} active`,
    );
    factors.push(`${position} ticket${position !== 1 ? 's' : ''} ahead`);
    return {
      low_seconds: 0,
      high_seconds: 0,
      confidence: 'insufficient_data',
      factors,
      calculated_at: calculatedAt,
      sample_size: serviceSamples.length,
    };
  }

  const avgService = median(serviceSamples);
  // Lower bound: the tickets ahead, served at the observed pace across active counters.
  // Upper bound also allows for the service currently in progress (position + 1), so the interval
  // is never zero-width — not even for the next person — and never implies an exact time
  // (REQ-F6.6). M2 amendment to design §7.
  const lowSeconds = Math.round((position / activeCompatibleCounters) * avgService * 0.7);
  const highSeconds = Math.round(((position + 1) / activeCompatibleCounters) * avgService * 1.5);

  factors.push(
    position === 0
      ? 'You are next; the wait depends on when a counter becomes free'
      : `${position} ticket${position !== 1 ? 's' : ''} ahead`,
  );
  factors.push(
    `${activeCompatibleCounters} counter${activeCompatibleCounters > 1 ? 's' : ''} active`,
  );
  factors.push(
    `~${Math.round(avgService)}s avg service time based on ${serviceSamples.length} samples`,
  );

  const confidence: WaitEstimate['confidence'] =
    serviceSamples.length >= 20 ? 'high' : serviceSamples.length >= 10 ? 'medium' : 'low';

  return {
    low_seconds: lowSeconds,
    high_seconds: highSeconds,
    confidence,
    factors,
    calculated_at: calculatedAt,
    sample_size: serviceSamples.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return sorted[mid]!;
}
