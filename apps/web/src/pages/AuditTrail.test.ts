import { describe, expect, it } from 'vitest';
import { actorLabel } from './AuditTrail.js';

describe('MQ.5 U4: audit actor labels', () => {
  it('names staff, and labels the system and visitors from the recorded actor kind', () => {
    expect(actorLabel({ actor_id: 'x', actor_name: 'Ada', payload: {} })).toBe('Ada');
    expect(actorLabel({ actor_id: 'x', actor_name: null, payload: {} })).toBe('Staff');
    expect(
      actorLabel({
        actor_id: null,
        actor_name: null,
        payload: { actor_kind: 'system', reason_code: 'call_window_elapsed' },
      }),
    ).toBe('System (automatic)');
    expect(
      actorLabel({ actor_id: null, actor_name: null, payload: { actor_kind: 'visitor' } }),
    ).toBe('Visitor');
    // older events without a recorded kind stay honest about the ambiguity
    expect(actorLabel({ actor_id: null, actor_name: null, payload: {} })).toBe('Visitor / system');
  });
});
