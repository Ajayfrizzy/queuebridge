import { describe, expect, it } from 'vitest';
import { QueueAction, SyncStatus, type TicketState, type StaffQueue } from '@queuebridge/contracts';
import type { OutboxOperation } from './outbox.js';
import {
  decideLocalCall,
  MemoryOutboxStore,
  projectQueue,
  recordLocalOperation,
  newCaptureInput,
} from './index.js';

const Q = '550e8400-e29b-41d4-a716-446655440013';
const C1 = '550e8400-e29b-41d4-a716-446655440031';
const T1 = '550e8400-e29b-41d4-a716-446655440041';
const T2 = '550e8400-e29b-41d4-a716-446655440042';
const base = {
  owner_user_id: 'u',
  organization_id: '550e8400-e29b-41d4-a716-446655440011',
  facility_id: '550e8400-e29b-41d4-a716-446655440012',
  queue_session_id: Q,
  device_id: '550e8400-e29b-41d4-a716-446655440014',
  coordinator_epoch: 1,
  base_revision: 3,
};

const ticket = (
  id: string,
  code: string,
  seq: number,
  state = 'waiting',
): StaffQueue['tickets'][number] => ({
  id,
  public_code: code,
  state: state as TicketState,
  priority_class: 'normal',
  issued_sequence: seq,
  position: null,
  counter_id: null,
  counter_name: null,
  channel: 'web',
  joined_at: '2026-11-08T10:00:00.000Z',
  wait_since: `2026-11-08T10:00:0${seq % 10}.000Z`,
  called_at: null,
  transferred_from_code: null,
});
const snap: StaffQueue = {
  id: Q,
  facility_id: base.facility_id,
  service_id: '550e8400-e29b-41d4-a716-446655440050',
  service_name: 'General',
  operational_date: '2026-11-08',
  state: 'open',
  revision: 3,
  last_sequence: 3,
  policy_summary: '',
  tickets: [ticket(T1, 'G001', 1), ticket(T2, 'G002', 2)],
  counters: [
    { id: C1, name: 'Counter 1', active: true, availability: 'open', busy_with_code: null },
  ],
  policy: {
    version: 'v1',
    priority_order: ['normal'],
    override_reasons: [],
    transfer_placement: 'by_original_join_time',
  },
  no_open_counter: false,
  transfer_targets: [],
  estimate_for_new_visitor: null,
};

async function ops(
  ...specs: { action: string; payload: Record<string, unknown> }[]
): Promise<OutboxOperation[]> {
  const store = new MemoryOutboxStore();
  for (const s of specs) {
    await recordLocalOperation(store, { ...base, action: s.action as never, payload: s.payload });
  }
  return store.list();
}

describe('projectQueue', () => {
  it('shows a captured ticket under its TEMPORARY reference, marked Local, after confirmed tickets', async () => {
    const cap = await recordLocalOperation(new MemoryOutboxStore(), newCaptureInput(base));
    const p = projectQueue(snap, [cap]);
    const prov = p.tickets.find((t) => t.provisional);
    expect(prov).toMatchObject({
      id: null,
      label: cap.temporary_ref,
      local_status: SyncStatus.LOCAL_ONLY,
      state: 'waiting',
    });
    expect(prov?.label).not.toMatch(/^G\d{3}$/);
    expect(p.tickets.map((t) => t.position)).toEqual([0, 1, 2]);
    // untouched server tickets carry NO local status: they are exactly what the server said
    expect(p.tickets.filter((t) => !t.provisional).every((t) => t.local_status === null)).toBe(
      true,
    );
  });

  it('folds call → serve → complete in order, flagging each touched ticket', async () => {
    const list = await ops(
      { action: QueueAction.TICKET_CALL_NEXT, payload: { counter_id: C1, ticket_id: T1 } },
      { action: QueueAction.TICKET_SERVE, payload: { ticket_id: T1 } },
    );
    const p = projectQueue(snap, list);
    const t1 = p.tickets.find((t) => t.id === T1);
    expect(t1).toMatchObject({
      state: 'serving',
      counter_id: C1,
      counter_name: 'Counter 1',
      local_status: SyncStatus.LOCAL_ONLY,
    });
    expect(p.counters[0]?.busy_with).toBe('G001');
    expect(p.applied).toBe(2);
    const done = projectQueue(snap, [
      ...list,
      ...(await ops({ action: QueueAction.TICKET_COMPLETE, payload: { ticket_id: T1 } })).map(
        (o) => ({ ...o, client_sequence: 3 }),
      ),
    ]);
    expect(done.tickets.find((t) => t.id === T1)?.state).toBe('completed');
    expect(done.counters[0]?.busy_with).toBeNull();
  });

  it('does not apply operations that are already synced, or whose target is wrong; they are reported as skipped', async () => {
    const list = await ops({ action: QueueAction.TICKET_SERVE, payload: { ticket_id: T1 } }); // T1 is waiting, not called
    expect(projectQueue(snap, list).skipped).toHaveLength(1);
    const committed = list.map((o) => ({ ...o, status: SyncStatus.COMMITTED }));
    const p = projectQueue(snap, committed);
    expect(p.applied).toBe(0);
    expect(p.skipped).toHaveLength(0);
  });

  it('is deterministic: same snapshot + same operations → same projection', async () => {
    const list = await ops(
      { action: QueueAction.TICKET_CALL_NEXT, payload: { counter_id: C1, ticket_id: T1 } },
      { action: QueueAction.TICKET_SERVE, payload: { ticket_id: T1 } },
    );
    expect(JSON.stringify(projectQueue(snap, list))).toBe(
      JSON.stringify(projectQueue(snap, [...list].reverse())),
    );
  });

  it('can call a provisional ticket by its temporary reference', async () => {
    const empty: StaffQueue = { ...snap, tickets: [] };
    const store = new MemoryOutboxStore();
    const cap = await recordLocalOperation(store, newCaptureInput(base));
    const p0 = projectQueue(empty, [cap]);
    const decision = decideLocalCall('open', p0, C1);
    expect(decision).toMatchObject({
      ok: true,
      payload: { counter_id: C1, ticket_ref: cap.temporary_ref },
    });
  });
});

describe('decideLocalCall mirrors the server rules', () => {
  const p = projectQueue(snap, []);
  it('calls the head of the queue', () => {
    expect(decideLocalCall('open', p, C1)).toMatchObject({ ok: true, payload: { ticket_id: T1 } });
  });
  it.each([
    ['paused', 'paused', C1, 'queue_not_open'],
    ['closed', 'closed', C1, 'queue_not_open'],
    ['unknown counter', 'open', 'nope', 'counter_missing'],
  ] as const)('refuses: %s', (_n, state, counter, reason) => {
    expect(decideLocalCall(state, p, counter)).toEqual({ ok: false, reason });
  });
  it('refuses a counter that is closed (M4: closed counters receive no calls)', () => {
    const closed = projectQueue(
      { ...snap, counters: [{ ...snap.counters[0]!, availability: 'closed' }] },
      [],
    );
    expect(decideLocalCall('open', closed, C1)).toEqual({ ok: false, reason: 'counter_closed' });
  });
  it('follows the published class order and waiting age, like the server (no avoidable conflicts)', async () => {
    const T3 = '550e8400-e29b-41d4-a716-446655440043';
    const prio: StaffQueue = {
      ...snap,
      policy: { ...snap.policy, priority_order: ['priority', 'normal'] },
      tickets: [
        ticket(T1, 'G001', 1),
        // issued later, but a transfer that kept an EARLIER waiting age
        { ...ticket(T2, 'G002', 2), wait_since: '2026-11-08T09:00:00.000Z' },
        { ...ticket(T3, 'G003', 3), priority_class: 'priority' },
      ],
    };
    const cap = await recordLocalOperation(new MemoryOutboxStore(), newCaptureInput(base));
    const pp = projectQueue(prio, [cap]);
    const order = [...pp.tickets]
      .filter((t) => t.position !== null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((t) => t.label);
    expect(order).toEqual(['G003', 'G002', 'G001', cap.temporary_ref]);
    expect(decideLocalCall('open', pp, C1)).toMatchObject({ ok: true, payload: { ticket_id: T3 } });
  });
  it('defaults safely for a snapshot cached before M4 (no policy, no availability)', () => {
    const legacy = {
      ...snap,
      policy: undefined,
      counters: [{ id: C1, name: 'Counter 1', active: true, busy_with_code: null }],
    } as unknown as StaffQueue;
    expect(decideLocalCall('open', projectQueue(legacy, []), C1)).toMatchObject({
      ok: true,
      payload: { ticket_id: T1 },
    });
  });
  it('refuses a busy counter and an empty queue', async () => {
    const busy = projectQueue(
      snap,
      await ops({
        action: QueueAction.TICKET_CALL_NEXT,
        payload: { counter_id: C1, ticket_id: T1 },
      }),
    );
    expect(decideLocalCall('open', busy, C1)).toEqual({ ok: false, reason: 'counter_busy' });
    expect(decideLocalCall('open', projectQueue({ ...snap, tickets: [] }, []), C1)).toEqual({
      ok: false,
      reason: 'queue_empty',
    });
  });
});
