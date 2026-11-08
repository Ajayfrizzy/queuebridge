import { describe, expect, it } from 'vitest';
import {
  AssignCoordinatorRequestSchema,
  CommandResultSchema,
  FailoverCoordinatorRequestSchema,
  isAdvanceAction,
  parseOfflinePayload,
  QueueAction,
  ResolveConflictRequestSchema,
  SyncBatchTransportSchema,
  temporaryRefFor,
  TemporaryRefSchema,
  uuidv7,
} from './index.js';

const U = '550e8400-e29b-41d4-a716-446655440000';

describe('offline payloads (strict per action)', () => {
  it('accepts exactly the documented shapes', () => {
    expect(parseOfflinePayload(QueueAction.TICKET_CREATE, { temporary_ref: 'P-0A1B2C' }).ok).toBe(
      true,
    );
    expect(parseOfflinePayload(QueueAction.TICKET_CALL_NEXT, { counter_id: U }).ok).toBe(true);
    expect(
      parseOfflinePayload(QueueAction.TICKET_CALL_NEXT, { counter_id: U, ticket_ref: 'P-0A1B2C' })
        .ok,
    ).toBe(true);
    expect(parseOfflinePayload(QueueAction.TICKET_SERVE, { ticket_id: U }).ok).toBe(true);
    expect(parseOfflinePayload(QueueAction.TICKET_COMPLETE, { ticket_ref: 'P-0A1B2C' }).ok).toBe(
      true,
    );
  });

  it.each([
    [
      'extra field (possible PII) on capture',
      QueueAction.TICKET_CREATE,
      { temporary_ref: 'P-0A1B2C', phone: '+2348000000000' },
    ],
    ['malformed temporary ref', QueueAction.TICKET_CREATE, { temporary_ref: 'G001' }],
    ['call without counter', QueueAction.TICKET_CALL_NEXT, {}],
    [
      'call naming two targets',
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: U, ticket_id: U, ticket_ref: 'P-0A1B2C' },
    ],
    ['serve with no target', QueueAction.TICKET_SERVE, {}],
    ['serve with two targets', QueueAction.TICKET_SERVE, { ticket_id: U, ticket_ref: 'P-0A1B2C' }],
    ['online-only action', QueueAction.QUEUE_CLOSE, {}],
    ['coordinator self-assignment', QueueAction.COORDINATOR_ASSIGN, {}],
    ['priority override', QueueAction.TICKET_PRIORITY_OVERRIDE, {}],
  ])('rejects %s', (_n, action, payload) => {
    const r = parseOfflinePayload(action, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });

  it('classifies advancement vs capture', () => {
    expect(isAdvanceAction(QueueAction.TICKET_CALL_NEXT)).toBe(true);
    expect(isAdvanceAction(QueueAction.TICKET_CREATE)).toBe(false);
  });
});

describe('temporary references', () => {
  it('are derived from the operation id and are never ticket codes', () => {
    const id = uuidv7();
    const ref = temporaryRefFor(id);
    expect(TemporaryRefSchema.parse(ref)).toBe(ref);
    expect(ref).toMatch(/^P-[0-9A-F]{6}$/);
    expect(ref).not.toMatch(/^[A-Z]{1,3}\d{3,4}$/);
    expect(temporaryRefFor(id)).toBe(ref); // stable
  });
});

describe('transport and request schemas', () => {
  it('a batch carries 1–100 commands, validated one by one later', () => {
    expect(SyncBatchTransportSchema.safeParse({ commands: [{ anything: true }] }).success).toBe(
      true,
    );
    expect(SyncBatchTransportSchema.safeParse({ commands: [] }).success).toBe(false);
    expect(SyncBatchTransportSchema.safeParse({ commands: Array(101).fill({}) }).success).toBe(
      false,
    );
    expect(SyncBatchTransportSchema.safeParse({ commands: [{}], organization_id: U }).success).toBe(
      false,
    );
  });

  it('coordinator requests are strict and bounded', () => {
    expect(
      AssignCoordinatorRequestSchema.parse({ operation_id: uuidv7(), device_id: U }).ttl_minutes,
    ).toBe(240);
    expect(
      AssignCoordinatorRequestSchema.safeParse({
        operation_id: uuidv7(),
        device_id: U,
        ttl_minutes: 1,
      }).success,
    ).toBe(false);
    expect(
      AssignCoordinatorRequestSchema.safeParse({
        operation_id: uuidv7(),
        device_id: U,
        ttl_minutes: 721,
      }).success,
    ).toBe(false);
    expect(
      AssignCoordinatorRequestSchema.safeParse({ operation_id: U, device_id: U }).success,
    ).toBe(false); // not v7
    expect(
      AssignCoordinatorRequestSchema.safeParse({
        operation_id: uuidv7(),
        device_id: U,
        allowed_actions: ['ticket.create'],
      }).success,
    ).toBe(false);
    expect(
      FailoverCoordinatorRequestSchema.safeParse({ operation_id: uuidv7(), device_id: U }).success,
    ).toBe(false); // reason required
    expect(ResolveConflictRequestSchema.safeParse({ resolution: 'apply' }).success).toBe(false); // reason required
  });

  it('a command result round-trips', () => {
    const r = {
      operation_id: uuidv7(),
      client_sequence: 3,
      disposition: 'needs_review',
      reason_code: 'stale_epoch',
      rejection_reason: 'x',
    };
    expect(CommandResultSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(CommandResultSchema.safeParse({ ...r, disposition: 'maybe' }).success).toBe(false);
  });
});
