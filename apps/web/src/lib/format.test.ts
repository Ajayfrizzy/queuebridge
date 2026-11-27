import { describe, expect, it } from 'vitest';
import type { WaitEstimate } from '@queuebridge/contracts';
import { formatEstimate } from './format.js';

const est = (
  low: number,
  high: number,
  confidence: WaitEstimate['confidence'] = 'low',
): WaitEstimate => ({
  low_seconds: low,
  high_seconds: high,
  confidence,
  factors: [],
  calculated_at: new Date().toISOString(),
  sample_size: 5,
});

describe('formatEstimate (REQ-F6.2, F6.4, F6.6)', () => {
  it('always shows a range, never a single exact time', () => {
    expect(formatEstimate(est(168, 720))).toBe('About 2–12 min');
    expect(formatEstimate(est(0, 360))).toBe('Up to about 6 min');
    // even a degenerate input never collapses to one value
    expect(formatEstimate(est(120, 120))).toBe('About 2–3 min');
  });

  it('says plainly when data is insufficient instead of inventing a number', () => {
    expect(formatEstimate(est(0, 0, 'insufficient_data'))).toBe(
      'Not enough information for an estimate yet',
    );
    expect(formatEstimate(null)).toBe('No estimate');
  });
});
