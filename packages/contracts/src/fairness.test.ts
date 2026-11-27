import { describe, expect, it } from 'vitest';
import {
  AuditVerificationSchema,
  CallOutOfOrderRequestSchema,
  CounterAvailabilityRequestSchema,
  CounterTransferRequestSchema,
  PriorityOverrideRequestSchema,
} from './fairness.js';
import { uuidv7 } from './ids.js';

/** Group 2 — M4 request/response schemas: valid inputs parse, invalid ones are rejected clearly. */

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('PriorityOverrideRequestSchema', () => {
  const ok = {
    operation_id: uuidv7(),
    to_class: 'priority',
    reason_code: 'accessibility_need',
    reason_text: 'Uses a wheelchair today',
  };

  it('accepts a complete override and trims the explanation', () => {
    const r = PriorityOverrideRequestSchema.parse({ ...ok, reason_text: '  Uses a wheelchair  ' });
    expect(r.reason_text).toBe('Uses a wheelchair');
  });

  it.each([
    ['missing operation id', { operation_id: undefined }],
    ['operation id not UUID v7', { operation_id: UUID }],
    ['unknown class', { to_class: 'vip' }],
    ['malformed reason code', { reason_code: 'Not A Code!' }],
    ['explanation too short', { reason_text: 'abc' }],
    ['explanation only spaces', { reason_text: '        ' }],
    ['explanation too long', { reason_text: 'x'.repeat(501) }],
  ])('rejects %s', (_n, patch) => {
    expect(PriorityOverrideRequestSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it('rejects unexpected fields (no client-chosen actor, position or policy version)', () => {
    for (const extra of [{ actor_id: UUID }, { position: 0 }, { policy_version: 'v9' }]) {
      expect(PriorityOverrideRequestSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    }
  });

  it('explains a too-short explanation in words', () => {
    const r = PriorityOverrideRequestSchema.safeParse({ ...ok, reason_text: 'no' });
    expect(r.success ? '' : r.error.issues[0]?.message).toMatch(/at least 5 characters/);
  });
});

describe('CallOutOfOrderRequestSchema', () => {
  const ok = {
    operation_id: uuidv7(),
    counter_id: UUID,
    reason_code: 'urgent_need',
    reason_text: 'Visitor feels unwell',
  };
  it('accepts a complete routing override', () => {
    expect(CallOutOfOrderRequestSchema.safeParse(ok).success).toBe(true);
  });
  it('requires a counter, a reason and an explanation', () => {
    for (const k of ['counter_id', 'reason_code', 'reason_text'] as const) {
      const { [k]: _omit, ...rest } = ok;
      expect(CallOutOfOrderRequestSchema.safeParse(rest).success, k).toBe(false);
    }
  });
});

describe('CounterTransferRequestSchema', () => {
  it('accepts a listed reason and rejects anything else', () => {
    const base = { operation_id: uuidv7(), to_counter_id: UUID };
    expect(
      CounterTransferRequestSchema.safeParse({ ...base, reason_code: 'specialist_counter' })
        .success,
    ).toBe(true);
    expect(
      CounterTransferRequestSchema.safeParse({ ...base, reason_code: 'because' }).success,
    ).toBe(false);
    expect(CounterTransferRequestSchema.safeParse({ ...base }).success).toBe(false);
  });
});

describe('CounterAvailabilityRequestSchema', () => {
  it('opening needs no reason; closing requires one', () => {
    expect(CounterAvailabilityRequestSchema.safeParse({ availability: 'open' }).success).toBe(true);
    const closed = CounterAvailabilityRequestSchema.safeParse({ availability: 'closed' });
    expect(closed.success).toBe(false);
    expect(closed.success ? null : closed.error.issues[0]?.path).toEqual(['reason_code']);
    expect(
      CounterAvailabilityRequestSchema.safeParse({ availability: 'closed', reason_code: 'break' })
        .success,
    ).toBe(true);
  });
  it('rejects unknown states and reasons', () => {
    expect(CounterAvailabilityRequestSchema.safeParse({ availability: 'paused' }).success).toBe(
      false,
    );
    expect(
      CounterAvailabilityRequestSchema.safeParse({ availability: 'closed', reason_code: 'lunch' })
        .success,
    ).toBe(false);
  });
});

describe('AuditVerificationSchema', () => {
  const v = {
    queue_id: UUID,
    status: 'incomplete',
    verified_at: '2026-11-08T10:00:00.000Z',
    chain: {
      valid: true,
      events_checked: 3,
      head_hash: 'h',
      broken_at_sequence: null,
      reason: null,
    },
    checkpoints: {
      total: 1,
      valid: 0,
      invalid: [],
      unverifiable: 1,
      covered_to_sequence: 3,
      uncheckpointed_events: 0,
    },
    replay: {
      valid: true,
      decisions_verified: 1,
      decisions_not_replayable: 0,
      mismatches: [],
      error: null,
    },
    alerts: [],
    problems: ['1 checkpoint(s) could not be checked: signing key not available here.'],
  };
  it('round-trips a verification result', () => {
    expect(AuditVerificationSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  it('allows only verified, failed or incomplete', () => {
    expect(AuditVerificationSchema.safeParse({ ...v, status: 'ok' }).success).toBe(false);
    expect(AuditVerificationSchema.safeParse({ ...v, status: 'passed' }).success).toBe(false);
  });
});
