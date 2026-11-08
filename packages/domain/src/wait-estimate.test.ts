import { describe, expect, it } from 'vitest';
import { computeWaitEstimate } from './wait-estimate.js';

const NOW = '2026-10-30T17:00:00.000Z';

describe('computeWaitEstimate', () => {
  it('returns insufficient_data when no counters are active', () => {
    const result = computeWaitEstimate({
      position: 5,
      activeCompatibleCounters: 0,
      serviceSamples: [60, 90, 120, 75, 80, 95],
      calculatedAt: NOW,
    });
    expect(result.confidence).toBe('insufficient_data');
    expect(result.factors.some((f) => f.includes('No active counters'))).toBe(true);
  });

  it('returns insufficient_data with fewer than 5 samples', () => {
    const result = computeWaitEstimate({
      position: 3,
      activeCompatibleCounters: 2,
      serviceSamples: [60, 90, 120, 75],
      calculatedAt: NOW,
    });
    expect(result.confidence).toBe('insufficient_data');
    expect(result.sample_size).toBe(4);
  });

  it('returns a valid interval with sufficient data', () => {
    const result = computeWaitEstimate({
      position: 4,
      activeCompatibleCounters: 2,
      serviceSamples: [60, 90, 120, 75, 80, 95, 110, 70, 85, 100],
      calculatedAt: NOW,
    });
    expect(result.confidence).not.toBe('insufficient_data');
    expect(result.low_seconds).toBeGreaterThanOrEqual(0);
    expect(result.high_seconds).toBeGreaterThan(result.low_seconds);
  });

  it('high_seconds is always greater than low_seconds with data', () => {
    const result = computeWaitEstimate({
      position: 2,
      activeCompatibleCounters: 1,
      serviceSamples: [100, 110, 90, 105, 95, 108],
      calculatedAt: NOW,
    });
    expect(result.high_seconds).toBeGreaterThan(result.low_seconds);
  });

  it('includes explanation factors', () => {
    const result = computeWaitEstimate({
      position: 3,
      activeCompatibleCounters: 2,
      serviceSamples: [60, 80, 100, 70, 90, 85, 75, 95, 65, 110],
      calculatedAt: NOW,
    });
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.factors.some((f) => f.includes('tickets ahead'))).toBe(true);
    expect(result.factors.some((f) => f.includes('counter'))).toBe(true);
  });

  it('more counters reduces the estimate', () => {
    const samples = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90];
    const fewer = computeWaitEstimate({
      position: 10,
      activeCompatibleCounters: 1,
      serviceSamples: samples,
      calculatedAt: NOW,
    });
    const more = computeWaitEstimate({
      position: 10,
      activeCompatibleCounters: 5,
      serviceSamples: samples,
      calculatedAt: NOW,
    });
    expect(fewer.high_seconds).toBeGreaterThan(more.high_seconds);
  });

  it('position 0 gives a low but non-zero-width interval', () => {
    const result = computeWaitEstimate({
      position: 0,
      activeCompatibleCounters: 2,
      serviceSamples: [60, 80, 100, 70, 90, 85, 75, 95, 65, 110],
      calculatedAt: NOW,
    });
    // REQ-F6.6: even for the next person the estimate is an interval, never an exact time
    expect(result.low_seconds).toBe(0);
    expect(result.high_seconds).toBeGreaterThan(0);
    expect(result.factors.some((f) => f.includes('You are next'))).toBe(true);
  });

  it('confidence is high with 20+ samples', () => {
    const samples = Array(25).fill(90);
    const result = computeWaitEstimate({
      position: 5,
      activeCompatibleCounters: 2,
      serviceSamples: samples,
      calculatedAt: NOW,
    });
    expect(result.confidence).toBe('high');
  });

  it('confidence is medium with 10-19 samples', () => {
    const samples = Array(15).fill(90);
    const result = computeWaitEstimate({
      position: 5,
      activeCompatibleCounters: 2,
      serviceSamples: samples,
      calculatedAt: NOW,
    });
    expect(result.confidence).toBe('medium');
  });

  it('confidence is low with 5-9 samples', () => {
    const samples = [90, 80, 100, 85, 95];
    const result = computeWaitEstimate({
      position: 5,
      activeCompatibleCounters: 2,
      serviceSamples: samples,
      calculatedAt: NOW,
    });
    expect(result.confidence).toBe('low');
  });

  it('preserves calculated_at timestamp exactly', () => {
    const result = computeWaitEstimate({
      position: 1,
      activeCompatibleCounters: 1,
      serviceSamples: [60, 80, 100, 70, 90],
      calculatedAt: NOW,
    });
    expect(result.calculated_at).toBe(NOW);
  });
});
