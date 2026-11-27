import { describe, expect, it } from 'vitest';
import { OperationIdTracker, outcomeOfStatus } from './operationIds.js';

const tracker = (): OperationIdTracker => {
  let n = 0;
  return new OperationIdTracker(() => `op-${++n}`);
};

describe('operation ids for online commands (dedup contract)', () => {
  it('retries the SAME command with the SAME id after an unknown outcome (lost response)', () => {
    const t = tracker();
    expect(t.idFor('transfer:c2:specialist')).toBe('op-1');
    t.settle('unknown');
    expect(t.idFor('transfer:c2:specialist')).toBe('op-1');
  });

  it('issues a NEW id after a definitive refusal (e.g. counter_busy), even for the same command', () => {
    const t = tracker();
    expect(t.idFor('transfer:c2:specialist')).toBe('op-1');
    t.settle('refused');
    expect(t.idFor('transfer:c2:specialist')).toBe('op-2');
  });

  it('issues a NEW id after a commit', () => {
    const t = tracker();
    t.idFor('override:priority');
    t.settle('committed');
    expect(t.idFor('override:priority')).toBe('op-2');
  });

  it('issues a NEW id when the command changes, even after an unknown outcome', () => {
    const t = tracker();
    expect(t.idFor('transfer:c2:specialist')).toBe('op-1');
    t.settle('unknown');
    expect(t.idFor('transfer:c3:specialist')).toBe('op-2');
  });

  it('classifies HTTP outcomes: no response, 429 and 5xx are unknown; other failures are definitive', () => {
    expect([0, 429, 500, 503].map(outcomeOfStatus)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect([400, 403, 404, 409].map(outcomeOfStatus)).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
  });
});
