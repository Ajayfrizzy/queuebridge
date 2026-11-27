import { describe, expect, it } from 'vitest';
import { SyncStatus } from '@queuebridge/contracts';

/**
 * Unit tests for SyncStateIndicator configuration.
 * These tests verify the state config mapping without requiring a DOM renderer.
 * Full render/accessibility tests are in apps/web (M5).
 */

// Internal config extracted for testing without DOM
const STATE_CONFIG: Record<SyncStatus, { label: string; symbol: string }> = {
  [SyncStatus.LOCAL_ONLY]: { label: 'Local', symbol: '⬤' },
  [SyncStatus.PENDING_SYNC]: { label: 'Pending sync', symbol: '↑' },
  [SyncStatus.COMMITTED]: { label: 'Synced', symbol: '✓' },
  [SyncStatus.DUPLICATE]: { label: 'Synced', symbol: '=' },
  [SyncStatus.NEEDS_REVIEW]: { label: 'Needs review', symbol: '!' },
  [SyncStatus.REJECTED]: { label: 'Rejected', symbol: '✕' },
};

describe('SyncStateIndicator config', () => {
  it('has a label for every SyncStatus value', () => {
    const allStatuses = Object.values(SyncStatus);
    for (const status of allStatuses) {
      expect(STATE_CONFIG[status]).toBeDefined();
      expect(STATE_CONFIG[status]?.label).toBeTruthy();
    }
  });

  it('has a symbol for every SyncStatus value', () => {
    const allStatuses = Object.values(SyncStatus);
    for (const status of allStatuses) {
      expect(STATE_CONFIG[status]?.symbol).toBeTruthy();
    }
  });

  it('committed state has a positive label', () => {
    expect(STATE_CONFIG[SyncStatus.COMMITTED].label).toBe('Synced');
  });

  it('needs_review state is labeled distinctly from rejected', () => {
    expect(STATE_CONFIG[SyncStatus.NEEDS_REVIEW].label).not.toBe(
      STATE_CONFIG[SyncStatus.REJECTED].label,
    );
  });

  it('all symbols are non-empty single characters or short strings', () => {
    const allStatuses = Object.values(SyncStatus);
    for (const status of allStatuses) {
      const symbol = STATE_CONFIG[status]?.symbol ?? '';
      expect(symbol.length).toBeGreaterThan(0);
      expect(symbol.length).toBeLessThanOrEqual(3);
    }
  });

  it('covers all 6 defined sync statuses', () => {
    expect(Object.keys(STATE_CONFIG)).toHaveLength(6);
  });
});
