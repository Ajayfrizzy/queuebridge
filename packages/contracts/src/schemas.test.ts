import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  CommandEnvelopeSchema,
  CoordinatorAuthSchema,
  DeliveryReceiptSchema,
  QueueAction,
  QueueSessionSchema,
  QueueSessionState,
  Role,
  SendMessageParamsSchema,
  SyncBatchRequestSchema,
  TicketSchema,
  TicketState,
  UuidV7Schema,
  WaitEstimateSchema,
} from './index.js';

// ---------------------------------------------------------------------------
// UUID v7 schema
// ---------------------------------------------------------------------------

describe('UuidV7Schema', () => {
  it('accepts a valid UUID v7', () => {
    expect(() => UuidV7Schema.parse('018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b')).not.toThrow();
  });

  it('rejects a UUID v4 (version 4, not 7)', () => {
    expect(() => UuidV7Schema.parse('550e8400-e29b-41d4-a716-446655440000')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => UuidV7Schema.parse('')).toThrow();
  });

  it('rejects a non-UUID string', () => {
    expect(() => UuidV7Schema.parse('not-a-uuid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandEnvelopeSchema
// ---------------------------------------------------------------------------

const validEnvelope = {
  operation_id: '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  organization_id: '550e8400-e29b-41d4-a716-446655440000',
  facility_id: '550e8400-e29b-41d4-a716-446655440001',
  queue_session_id: '550e8400-e29b-41d4-a716-446655440002',
  device_id: '550e8400-e29b-41d4-a716-446655440003',
  actor_id: '550e8400-e29b-41d4-a716-446655440004',
  coordinator_epoch: 1,
  base_revision: 0,
  client_sequence: 0,
  action: QueueAction.TICKET_CALL_NEXT,
  payload: { counter_id: '550e8400-e29b-41d4-a716-446655440005' },
  created_at_client: '2026-10-30T17:00:00.000Z',
  schema_version: 1 as const,
};

describe('CommandEnvelopeSchema', () => {
  it('accepts a valid complete envelope', () => {
    expect(() => CommandEnvelopeSchema.parse(validEnvelope)).not.toThrow();
  });

  it('rejects when operation_id is not UUID v7', () => {
    expect(() =>
      CommandEnvelopeSchema.parse({
        ...validEnvelope,
        operation_id: '550e8400-e29b-41d4-a716-446655440000', // v4
      }),
    ).toThrow();
  });

  it('rejects when schema_version is wrong', () => {
    expect(() => CommandEnvelopeSchema.parse({ ...validEnvelope, schema_version: 2 })).toThrow();
  });

  it('rejects when required fields are missing', () => {
    const { operation_id: _opId, ...withoutOpId } = validEnvelope;
    expect(() => CommandEnvelopeSchema.parse(withoutOpId)).toThrow();
  });

  it('rejects invalid action', () => {
    expect(() =>
      CommandEnvelopeSchema.parse({ ...validEnvelope, action: 'invalid.action' }),
    ).toThrow();
  });

  it('rejects negative coordinator_epoch', () => {
    expect(() =>
      CommandEnvelopeSchema.parse({ ...validEnvelope, coordinator_epoch: -1 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SyncBatchRequestSchema
// ---------------------------------------------------------------------------

describe('SyncBatchRequestSchema', () => {
  it('accepts a batch with one command', () => {
    expect(() => SyncBatchRequestSchema.parse({ commands: [validEnvelope] })).not.toThrow();
  });

  it('rejects an empty commands array', () => {
    expect(() => SyncBatchRequestSchema.parse({ commands: [] })).toThrow();
  });

  it('rejects a batch exceeding 100 commands', () => {
    const bigBatch = { commands: Array(101).fill(validEnvelope) };
    expect(() => SyncBatchRequestSchema.parse(bigBatch)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TicketSchema
// ---------------------------------------------------------------------------

describe('TicketSchema', () => {
  const validTicket = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    queue_session_id: '550e8400-e29b-41d4-a716-446655440001',
    public_code: 'A001',
    provisional_source_op_id: null,
    state: TicketState.WAITING,
    priority_class: 'normal',
    issued_sequence: 1,
    current_counter_id: null,
    version: 0,
    sync_status: 'committed',
    created_at: '2026-10-30T17:00:00.000Z',
    updated_at: '2026-10-30T17:00:00.000Z',
  };

  it('accepts a valid ticket', () => {
    expect(() => TicketSchema.parse(validTicket)).not.toThrow();
  });

  it('rejects invalid state', () => {
    expect(() => TicketSchema.parse({ ...validTicket, state: 'flying' })).toThrow();
  });

  it('rejects empty public_code', () => {
    expect(() => TicketSchema.parse({ ...validTicket, public_code: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WaitEstimateSchema
// ---------------------------------------------------------------------------

describe('WaitEstimateSchema', () => {
  it('accepts a valid estimate', () => {
    const estimate = {
      low_seconds: 120,
      high_seconds: 300,
      confidence: 'medium',
      factors: ['3 tickets ahead', '2 counters active'],
      calculated_at: '2026-10-30T17:00:00.000Z',
      sample_size: 12,
    };
    expect(() => WaitEstimateSchema.parse(estimate)).not.toThrow();
  });

  it('accepts insufficient_data confidence', () => {
    const estimate = {
      low_seconds: 0,
      high_seconds: 0,
      confidence: 'insufficient_data',
      factors: ['Insufficient service history'],
      calculated_at: '2026-10-30T17:00:00.000Z',
      sample_size: 2,
    };
    expect(() => WaitEstimateSchema.parse(estimate)).not.toThrow();
  });

  it('rejects negative low_seconds', () => {
    expect(() =>
      WaitEstimateSchema.parse({
        low_seconds: -1,
        high_seconds: 300,
        confidence: 'medium',
        factors: [],
        calculated_at: '2026-10-30T17:00:00.000Z',
        sample_size: 10,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ApiErrorSchema (RFC 9457)
// ---------------------------------------------------------------------------

describe('ApiErrorSchema', () => {
  it('accepts a minimal error', () => {
    expect(() => ApiErrorSchema.parse({ title: 'Not found', status: 404 })).not.toThrow();
  });

  it('accepts a full error', () => {
    expect(() =>
      ApiErrorSchema.parse({
        type: 'https://queuebridge.local/errors/not-found',
        title: 'Resource not found',
        status: 404,
        detail: 'The ticket with the given code was not found',
        instance: 'req-abc123',
        retryable: false,
      }),
    ).not.toThrow();
  });

  it('rejects an invalid status code', () => {
    expect(() => ApiErrorSchema.parse({ title: 'Bad', status: 99 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CoordinatorAuthSchema
// ---------------------------------------------------------------------------

describe('CoordinatorAuthSchema', () => {
  const validAuth = {
    device_id: '550e8400-e29b-41d4-a716-446655440000',
    facility_id: '550e8400-e29b-41d4-a716-446655440001',
    queue_session_id: '550e8400-e29b-41d4-a716-446655440002',
    epoch: 1,
    allowed_actions: [QueueAction.TICKET_CALL_NEXT, QueueAction.TICKET_COMPLETE],
    issued_at: '2026-10-30T17:00:00.000Z',
    expires_at: '2026-10-30T18:00:00.000Z',
    issued_by_role: Role.SUPERVISOR,
    issued_by_actor_id: '550e8400-e29b-41d4-a716-446655440003',
  };

  it('accepts a valid coordinator auth', () => {
    expect(() => CoordinatorAuthSchema.parse(validAuth)).not.toThrow();
  });

  it('rejects epoch 0 (must be positive)', () => {
    expect(() => CoordinatorAuthSchema.parse({ ...validAuth, epoch: 0 })).toThrow();
  });

  it('rejects non-supervisor issued_by_role', () => {
    expect(() =>
      CoordinatorAuthSchema.parse({ ...validAuth, issued_by_role: Role.STAFF_COUNTER }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DeliveryReceiptSchema
// ---------------------------------------------------------------------------

describe('DeliveryReceiptSchema', () => {
  it('accepts a delivered receipt', () => {
    expect(() =>
      DeliveryReceiptSchema.parse({
        provider_message_id: 'sms-12345',
        status: 'delivered',
        recorded_at: '2026-10-30T17:05:00.000Z',
      }),
    ).not.toThrow();
  });

  it('accepts a failed receipt', () => {
    expect(() =>
      DeliveryReceiptSchema.parse({
        provider_message_id: 'sms-12346',
        status: 'failed',
        raw_status: 'UNDELIVERED',
        recorded_at: '2026-10-30T17:05:00.000Z',
      }),
    ).not.toThrow();
  });

  it('rejects missing provider_message_id', () => {
    expect(() =>
      DeliveryReceiptSchema.parse({
        status: 'delivered',
        recorded_at: '2026-10-30T17:05:00.000Z',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// QueueSessionSchema
// ---------------------------------------------------------------------------

describe('QueueSessionSchema', () => {
  it('accepts a valid open session', () => {
    expect(() =>
      QueueSessionSchema.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        facility_id: '550e8400-e29b-41d4-a716-446655440001',
        service_id: '550e8400-e29b-41d4-a716-446655440002',
        operational_date: '2026-10-30',
        state: QueueSessionState.OPEN,
        revision: 5,
        last_sequence: 12,
        coordinator_epoch: 2,
        coordinator_device_id: null,
        created_at: '2026-10-30T08:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('rejects invalid operational_date format', () => {
    expect(() =>
      QueueSessionSchema.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        facility_id: '550e8400-e29b-41d4-a716-446655440001',
        service_id: '550e8400-e29b-41d4-a716-446655440002',
        operational_date: '30/10/2026', // wrong format
        state: QueueSessionState.OPEN,
        revision: 0,
        last_sequence: 0,
        coordinator_epoch: 0,
        coordinator_device_id: null,
        created_at: '2026-10-30T08:00:00.000Z',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SendMessageParamsSchema
// ---------------------------------------------------------------------------

describe('SendMessageParamsSchema', () => {
  it('accepts valid params', () => {
    expect(() =>
      SendMessageParamsSchema.parse({
        to: '+2348012345678',
        template_key: 'ticket.confirmed',
        params: { code: 'A001', service: 'General' },
        idempotency_key: 'ticket-uuid-confirmed',
        sandbox: true,
      }),
    ).not.toThrow();
  });

  it('rejects empty to field', () => {
    expect(() =>
      SendMessageParamsSchema.parse({
        to: '',
        template_key: 'ticket.confirmed',
        params: {},
        idempotency_key: 'key',
        sandbox: false,
      }),
    ).toThrow();
  });
});
