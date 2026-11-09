import { describe, expect, it } from 'vitest';
import { PriorityClass, QueueAction, QueueSessionState, TicketState } from '@queuebridge/contracts';
import {
  applyQueueEvent,
  describeOrderingPolicy,
  emptyProjection,
  orderWaiting,
  priorityRank,
  replayQueueEvents,
  ReplayError,
  selectNextTicket,
  sessionTransition,
  ticketsAhead,
  type OrderableTicket,
  type QueueEventForReplay,
} from './queue.js';
import { TRANSITION_RULES } from './state-machine.js';

const t = (
  id: string,
  issued: number,
  priority_class: PriorityClass = PriorityClass.NORMAL,
  state: TicketState = TicketState.WAITING,
): OrderableTicket => ({ id, issued_sequence: issued, priority_class, state });

describe('published ordering policy', () => {
  it('is FIFO by issue sequence in a single-class queue, regardless of input order', () => {
    const tickets = [t('c', 3), t('a', 1), t('b', 2)];
    expect(orderWaiting(tickets, [PriorityClass.NORMAL]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('serves enabled higher classes first, FIFO within each class', () => {
    const tickets = [
      t('n1', 1),
      t('u1', 4, PriorityClass.URGENT),
      t('p1', 2, PriorityClass.PRIORITY),
      t('u2', 5, PriorityClass.URGENT),
      t('n2', 3),
    ];
    const order = [PriorityClass.URGENT, PriorityClass.PRIORITY, PriorityClass.NORMAL];
    expect(orderWaiting(tickets, order).map((x) => x.id)).toEqual(['u1', 'u2', 'p1', 'n1', 'n2']);
  });

  it('a class NOT enabled by the policy can never jump ahead of enabled classes', () => {
    const tickets = [t('urgent-not-enabled', 1, PriorityClass.URGENT), t('n', 2)];
    expect(priorityRank(PriorityClass.URGENT, [PriorityClass.NORMAL])).toBe(1);
    expect(selectNextTicket(tickets, [PriorityClass.NORMAL])?.id).toBe('n');
  });

  it('excludes paused, missed, called, serving and terminal tickets', () => {
    const tickets = [
      t('p', 1, PriorityClass.NORMAL, TicketState.PAUSED),
      t('m', 2, PriorityClass.NORMAL, TicketState.MISSED),
      t('c', 3, PriorityClass.NORMAL, TicketState.CALLED),
      t('s', 4, PriorityClass.NORMAL, TicketState.SERVING),
      t('x', 5, PriorityClass.NORMAL, TicketState.COMPLETED),
      t('w', 6),
    ];
    expect(orderWaiting(tickets, [PriorityClass.NORMAL]).map((x) => x.id)).toEqual(['w']);
  });

  it('breaks ties deterministically by id', () => {
    const tickets = [t('b', 1), t('a', 1)];
    expect(selectNextTicket(tickets, [PriorityClass.NORMAL])?.id).toBe('a');
  });

  it('returns null when nobody is waiting, and positions are 0-based tickets ahead', () => {
    expect(selectNextTicket([], [PriorityClass.NORMAL])).toBeNull();
    const tickets = [t('a', 1), t('b', 2), t('c', 3)];
    expect(ticketsAhead('a', tickets, [PriorityClass.NORMAL])).toBe(0);
    expect(ticketsAhead('c', tickets, [PriorityClass.NORMAL])).toBe(2);
    expect(ticketsAhead('missing', tickets, [PriorityClass.NORMAL])).toBeNull();
  });

  it('does not mutate its input', () => {
    const tickets = [t('b', 2), t('a', 1)];
    const copy = JSON.stringify(tickets);
    orderWaiting(tickets, [PriorityClass.NORMAL]);
    expect(JSON.stringify(tickets)).toBe(copy);
  });

  it('describes only enabled classes', () => {
    expect(
      describeOrderingPolicy({ priority_order: [PriorityClass.NORMAL], grace_window_seconds: 60 }),
    ).toBe('Single queue, first come first served (no priority classes). Grace window 60s.');
    const text = describeOrderingPolicy({
      priority_order: [PriorityClass.PRIORITY, PriorityClass.NORMAL],
      grace_window_seconds: 30,
    });
    expect(text).toContain('Priority, Normal');
    expect(text).not.toContain('Urgent');
  });
});

describe('queue session transitions', () => {
  it.each([
    [QueueSessionState.OPEN, QueueAction.QUEUE_PAUSE, QueueSessionState.PAUSED],
    [QueueSessionState.PAUSED, QueueAction.QUEUE_OPEN, QueueSessionState.OPEN],
    [QueueSessionState.OPEN, QueueAction.QUEUE_CLOSE, QueueSessionState.CLOSED],
    [QueueSessionState.PAUSED, QueueAction.QUEUE_CLOSE, QueueSessionState.CLOSED],
    [QueueSessionState.CLOSED, QueueAction.QUEUE_OPEN, QueueSessionState.OPEN],
  ])('%s -[%s]-> %s', (from, action, to) => {
    expect(sessionTransition(from, action)).toEqual({ ok: true, to });
  });

  it.each([
    [QueueSessionState.OPEN, QueueAction.QUEUE_OPEN],
    [QueueSessionState.CLOSED, QueueAction.QUEUE_PAUSE],
    [QueueSessionState.CLOSED, QueueAction.QUEUE_CLOSE],
    [QueueSessionState.PAUSED, QueueAction.QUEUE_PAUSE],
    [QueueSessionState.OPEN, QueueAction.TICKET_CALL_NEXT],
  ])('rejects %s via %s', (from, action) => {
    expect(sessionTransition(from, action).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const ev = (
  sequence: number,
  event_type: string,
  payload: Record<string, unknown>,
): QueueEventForReplay => ({
  sequence,
  event_type,
  payload,
});

describe('event replay', () => {
  const base = [
    ev(1, 'queue.open', { from_state: 'closed', to_state: 'open' }),
    ev(2, 'ticket.create', { ticket_id: 't1', public_code: 'A001', issued_sequence: 1 }),
    ev(3, 'ticket.call_next', {
      ticket_id: 't1',
      from_state: 'waiting',
      to_state: 'called',
      counter_id: 'c1',
    }),
    ev(4, 'ticket.serve', { ticket_id: 't1', from_state: 'called', to_state: 'serving' }),
    ev(5, 'ticket.complete', { ticket_id: 't1', from_state: 'serving', to_state: 'completed' }),
  ];

  it('rebuilds the authoritative state', () => {
    const p = replayQueueEvents(base);
    expect(p.state).toBe(QueueSessionState.OPEN);
    expect(p.last_sequence).toBe(5);
    expect(p.tickets['t1']).toMatchObject({
      state: 'completed',
      counter_id: 'c1',
      public_code: 'A001',
    });
  });

  it('rejects sequence gaps and re-ordering', () => {
    expect(() => replayQueueEvents([base[0]!, base[2]!])).toThrow(ReplayError);
    expect(() => replayQueueEvents([base[1]!, base[0]!])).toThrow(ReplayError);
  });

  it('rejects transitions the state machine does not allow', () => {
    const bad = [
      ...base.slice(0, 2),
      ev(3, 'ticket.complete', { ticket_id: 't1', from_state: 'waiting', to_state: 'completed' }),
    ];
    expect(() => replayQueueEvents(bad)).toThrow(/illegal transition/);
  });

  it('rejects a from_state that disagrees with the replayed state', () => {
    const bad = [
      ...base.slice(0, 2),
      ev(3, 'ticket.serve', { ticket_id: 't1', from_state: 'called', to_state: 'serving' }),
    ];
    expect(() => replayQueueEvents(bad)).toThrow(/state mismatch/);
  });

  it('rejects duplicate tickets and duplicate issue numbers', () => {
    expect(() =>
      replayQueueEvents([
        ...base.slice(0, 2),
        ev(3, 'ticket.create', { ticket_id: 't1', public_code: 'A002', issued_sequence: 2 }),
      ]),
    ).toThrow(/duplicate ticket/);
    expect(() =>
      replayQueueEvents([
        ...base.slice(0, 2),
        ev(3, 'ticket.create', { ticket_id: 't2', public_code: 'A002', issued_sequence: 1 }),
      ]),
    ).toThrow(/duplicate issued_sequence/);
  });

  it('never mutates the previous projection', () => {
    const p0 = emptyProjection();
    const p1 = applyQueueEvent(p0, base[0]!);
    expect(p0.last_sequence).toBe(0);
    expect(p1).not.toBe(p0);
  });
});

// ---------------------------------------------------------------------------
// Property: identical authorized event sequences always produce identical state
// (seeded PRNG — reproducible, no external dependency)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random but LEGAL event history by driving the real transition table. */
function randomHistory(seed: number, length: number): QueueEventForReplay[] {
  const rnd = mulberry32(seed);
  const events: QueueEventForReplay[] = [
    ev(1, 'queue.open', { from_state: 'closed', to_state: 'open' }),
  ];
  const states: Record<string, TicketState> = {};
  let issued = 0;
  const ticketActions = TRANSITION_RULES.filter(
    (r) => r.from !== TicketState.MISSED || r.action !== QueueAction.TICKET_RESUME,
  );
  while (events.length < length) {
    const seq = events.length + 1;
    const ids = Object.keys(states);
    if (ids.length === 0 || rnd() < 0.3) {
      issued += 1;
      const id = `t${issued}`;
      states[id] = TicketState.WAITING;
      events.push(
        ev(seq, 'ticket.create', {
          ticket_id: id,
          public_code: `A${String(issued).padStart(3, '0')}`,
          issued_sequence: issued,
        }),
      );
      continue;
    }
    const id = ids[Math.floor(rnd() * ids.length)]!;
    const options = ticketActions.filter((r) => r.from === states[id]);
    if (options.length === 0) continue;
    const rule = options[Math.floor(rnd() * options.length)]!;
    states[id] = rule.to;
    events.push(
      ev(seq, rule.action, {
        ticket_id: id,
        from_state: rule.from,
        to_state: rule.to,
        counter_id: 'c1',
      }),
    );
  }
  return events;
}

describe('property: replay determinism', () => {
  it('200 random legal histories replay to identical state every time, and match the generator', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const history = randomHistory(seed, 60);
      const a = replayQueueEvents(history);
      const b = replayQueueEvents(JSON.parse(JSON.stringify(history)) as QueueEventForReplay[]);
      expect(b).toEqual(a);
      expect(a.last_sequence).toBe(60);
      // Ordering derived from the replayed state is itself deterministic
      const tickets = Object.values(a.tickets);
      expect(orderWaiting(tickets, [PriorityClass.NORMAL])).toEqual(
        orderWaiting([...tickets].reverse(), [PriorityClass.NORMAL]),
      );
    }
  });
});

describe('replay of M3 audit-only events', () => {
  it('coordinator and sync-conflict events occupy a sequence but change no state', () => {
    const p = replayQueueEvents([
      {
        sequence: 1,
        event_type: 'queue.open',
        payload: { from_state: 'closed', to_state: 'open' },
      },
      { sequence: 2, event_type: 'coordinator.assign', payload: { epoch: 1 } },
      {
        sequence: 3,
        event_type: 'sync.conflict_detected',
        payload: { reason_code: 'stale_epoch' },
      },
      { sequence: 4, event_type: 'coordinator.revoke', payload: { epoch: 2 } },
    ]);
    expect(p.last_sequence).toBe(4);
    expect(p.state).toBe('open');
    expect(p.tickets).toEqual({});
  });

  it('still refuses gaps around audit-only events', () => {
    expect(() =>
      replayQueueEvents([
        {
          sequence: 1,
          event_type: 'queue.open',
          payload: { from_state: 'closed', to_state: 'open' },
        },
        { sequence: 3, event_type: 'coordinator.assign', payload: {} },
      ]),
    ).toThrow();
  });
});
