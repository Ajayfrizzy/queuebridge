import { describe, expect, it } from 'vitest';
import { PriorityClass, QueueAction, TicketState } from '@queuebridge/contracts';
import {
  counterIneligibility,
  decideNextCall,
  openCapableCounters,
  ORDERING_RULE,
  orderWaiting,
  verifyRoutingDecisions,
  type CounterForRouting,
  type OrderableTicket,
  type QueueEventForReplay,
} from './index.js';

const { NORMAL, PRIORITY, URGENT } = PriorityClass;
const t = (
  id: string,
  issued: number,
  wait: string | null,
  cls: PriorityClass = NORMAL,
  state: TicketState = TicketState.WAITING,
): OrderableTicket => ({
  id,
  issued_sequence: issued,
  wait_since: wait,
  priority_class: cls,
  state,
});
const at = (m: number): string => new Date(Date.UTC(2026, 10, 9, 9, m)).toISOString();

describe('ordering: priority class → waiting age → issue number → id', () => {
  it('equal priority is first come, first served by waiting age', () => {
    const order = orderWaiting([t('c', 3, at(3)), t('a', 1, at(1)), t('b', 2, at(2))], [NORMAL]);
    expect(order.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('a transfer keeping its original join time takes its place by waiting age, not issue number', () => {
    const native = [t('n1', 1, at(5)), t('n2', 2, at(6))];
    const transferred = t('tr', 3, at(2)); // joined elsewhere at 09:02, issued here third
    expect(orderWaiting([...native, transferred], [NORMAL]).map((x) => x.id)).toEqual([
      'tr',
      'n1',
      'n2',
    ]);
  });

  it('enabled classes go first in published order; FIFO within each class', () => {
    const order = orderWaiting(
      [
        t('n1', 1, at(1)),
        t('p1', 2, at(2), PRIORITY),
        t('u1', 3, at(3), URGENT),
        t('p2', 4, at(4), PRIORITY),
      ],
      [URGENT, PRIORITY, NORMAL],
    );
    expect(order.map((x) => x.id)).toEqual(['u1', 'p1', 'p2', 'n1']);
  });

  it('a class the policy does not enable can never jump the queue', () => {
    const order = orderWaiting([t('n1', 1, at(1)), t('u1', 2, at(2), URGENT)], [NORMAL]);
    expect(order.map((x) => x.id)).toEqual(['n1', 'u1']);
  });

  it('ties on waiting age fall back to issue number, then id — total and input-order independent', () => {
    const same = [t('b', 2, at(1)), t('a', 2, at(1)), t('c', 1, at(1))];
    const one = orderWaiting(same, [NORMAL]).map((x) => x.id);
    const two = orderWaiting([...same].reverse(), [NORMAL]).map((x) => x.id);
    expect(one).toEqual(['c', 'a', 'b']);
    expect(two).toEqual(one);
  });

  it('excludes non-waiting tickets and never mutates its input', () => {
    const input = [t('x', 1, at(1), NORMAL, TicketState.PAUSED), t('y', 2, at(2))];
    const copy = JSON.stringify(input);
    expect(orderWaiting(input, [NORMAL]).map((x) => x.id)).toEqual(['y']);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe('decideNextCall explains its decision', () => {
  it('records rule, policy version, class order, candidates and the selected rank keys', () => {
    const d = decideNextCall([t('n1', 1, at(1)), t('p1', 2, at(2), PRIORITY)], {
      version: 'v3',
      priority_order: [PRIORITY, NORMAL],
    });
    expect(d?.ticket.id).toBe('p1');
    expect(d?.explanation).toEqual({
      rule: ORDERING_RULE,
      policy_version: 'v3',
      priority_order: [PRIORITY, NORMAL],
      candidates: 2,
      selected: { priority_class: PRIORITY, wait_since: at(2), issued_sequence: 2 },
    });
    expect(decideNextCall([], { version: 'v1', priority_order: [NORMAL] })).toBeNull();
  });
});

describe('counter eligibility', () => {
  const c = (o: Partial<CounterForRouting> = {}): CounterForRouting => ({
    id: 'c',
    active: true,
    availability: 'open',
    service_ids: ['s'],
    busy_with: null,
    ...o,
  });
  it.each([
    [c(), null],
    [c({ active: false }), 'inactive'],
    [c({ availability: 'closed' }), 'closed'],
    [c({ service_ids: ['other'] }), 'not_capable'],
    [c({ busy_with: 'G001' }), 'busy'],
  ] as const)('%#', (counter, why) => {
    expect(counterIneligibility(counter, 's')).toBe(why);
  });
  it('a closed or inactive counter is never "open and capable"; a busy one still is', () => {
    const all = [
      c({ id: 'a' }),
      c({ id: 'b', availability: 'closed' }),
      c({ id: 'd', active: false }),
      c({ id: 'e', busy_with: 'G1' }),
    ];
    expect(openCapableCounters(all, 's').map((x) => x.id)).toEqual(['a', 'e']);
  });
});

// ---------------------------------------------------------------------------
// Deterministic replay of recorded routing decisions
// ---------------------------------------------------------------------------

let seq = 0;
const ev = (event_type: string, payload: Record<string, unknown>): QueueEventForReplay => ({
  sequence: ++seq,
  event_type,
  payload,
});
const create = (id: string, issued: number, wait: string | null): QueueEventForReplay =>
  ev('ticket.create', {
    ticket_id: id,
    public_code: id.toUpperCase(),
    issued_sequence: issued,
    ...(wait ? { wait_since: wait } : {}),
  });
const routing = (version: string): Record<string, unknown> => ({
  rule: ORDERING_RULE,
  policy_version: version,
});
const call = (id: string, version: string): QueueEventForReplay =>
  ev(QueueAction.TICKET_CALL_NEXT, {
    ticket_id: id,
    from_state: 'waiting',
    to_state: 'called',
    counter_id: 'c1',
    routing: routing(version),
  });

function history(build: () => QueueEventForReplay[]): QueueEventForReplay[] {
  seq = 0;
  return [ev('queue.open', { from_state: 'closed', to_state: 'open' }), ...build()];
}

const POLICIES = new Map([
  ['v1', { priority_order: [NORMAL] }],
  ['v2', { priority_order: [PRIORITY, NORMAL] }],
]);

describe('verifyRoutingDecisions', () => {
  it('accepts history whose every call is exactly what the cited policy selects — across a policy change and an override', () => {
    const h = history(() => [
      create('a', 1, at(1)),
      create('b', 2, at(2)),
      create('c', 3, at(3)),
      call('a', 'v1'),
      ev('policy.changed', { from_version: 'v1', to_version: 'v2' }),
      ev(QueueAction.TICKET_PRIORITY_OVERRIDE, {
        ticket_id: 'c',
        from_class: NORMAL,
        to_class: PRIORITY,
      }),
      call('c', 'v2'), // c is priority now and v2 serves priority first
      call('b', 'v2'),
    ]);
    expect(verifyRoutingDecisions(h, POLICIES)).toEqual({
      valid: true,
      verified: 3,
      not_replayable: 0,
      mismatches: [],
      error: null,
    });
  });

  it('detects a call that is NOT what the rule selects (e.g. a rewritten event)', () => {
    const h = history(() => [create('a', 1, at(1)), create('b', 2, at(2)), call('b', 'v1')]);
    const r = verifyRoutingDecisions(h, POLICIES);
    expect(r.valid).toBe(false);
    expect(r.mismatches).toEqual([{ sequence: 4, reason: 'rule selects a, event called b' }]);
  });

  it('the same history under a different policy snapshot gives a different, detected answer', () => {
    const h = history(() => [
      create('a', 1, at(1)),
      create('b', 2, at(2)),
      ev(QueueAction.TICKET_PRIORITY_OVERRIDE, {
        ticket_id: 'b',
        from_class: NORMAL,
        to_class: PRIORITY,
      }),
      call('a', 'v2'), // claims v2, but under v2 the priority ticket b goes first
    ]);
    expect(verifyRoutingDecisions(h, POLICIES).mismatches[0]?.reason).toBe(
      'rule selects b, event called a',
    );
    expect(verifyRoutingDecisions(h, new Map([['v2', { priority_order: [NORMAL] }]])).valid).toBe(
      true,
    );
  });

  it('an unknown policy version is a mismatch, never silently accepted', () => {
    const h = history(() => [create('a', 1, at(1)), call('a', 'v9')]);
    expect(verifyRoutingDecisions(h, POLICIES).mismatches).toEqual([
      { sequence: 3, reason: 'unknown policy v9' },
    ]);
  });

  it('routing overrides must record what the rule would have chosen', () => {
    const specific = (id: string, wouldHave: string): QueueEventForReplay =>
      ev(QueueAction.TICKET_CALL_SPECIFIC, {
        ticket_id: id,
        from_state: 'waiting',
        to_state: 'called',
        counter_id: 'c1',
        routing: routing('v1'),
        override: { kind: 'routing', would_have_called: wouldHave },
      });
    expect(
      verifyRoutingDecisions(
        history(() => [create('a', 1, at(1)), create('b', 2, at(2)), specific('b', 'a')]),
        POLICIES,
      ).valid,
    ).toBe(true);
    expect(
      verifyRoutingDecisions(
        history(() => [create('a', 1, at(1)), create('b', 2, at(2)), specific('b', 'b')]),
        POLICIES,
      ).valid,
    ).toBe(false);
  });

  it('pre-M4 calls (no routing explanation, or tickets without wait_since) are counted as not replayable, not as verified', () => {
    const old = history(() => [
      create('a', 1, null),
      ev(QueueAction.TICKET_CALL_NEXT, {
        ticket_id: 'a',
        from_state: 'waiting',
        to_state: 'called',
        counter_id: 'c1',
      }),
      create('b', 2, null),
      call('b', 'v1'),
    ]);
    expect(verifyRoutingDecisions(old, POLICIES)).toMatchObject({
      valid: true,
      verified: 0,
      not_replayable: 2,
    });
  });

  it('an illegal history is an error (invalid), not a pass', () => {
    const h = history(() => [
      create('a', 1, at(1)),
      ev(QueueAction.TICKET_COMPLETE, {
        ticket_id: 'a',
        from_state: 'serving',
        to_state: 'completed',
      }),
    ]);
    const r = verifyRoutingDecisions(h, POLICIES);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/state mismatch/);
  });

  it('a released ticket returns to the head of the line with its waiting age intact', () => {
    const h = history(() => [
      create('a', 1, at(1)),
      create('b', 2, at(2)),
      call('a', 'v1'),
      ev(QueueAction.TICKET_RELEASE, {
        ticket_id: 'a',
        from_state: 'called',
        to_state: 'waiting',
        counter_id: null,
      }),
      call('a', 'v1'), // a is oldest again
    ]);
    expect(verifyRoutingDecisions(h, POLICIES)).toMatchObject({ valid: true, verified: 2 });
  });
});

describe('property: routing decisions replay deterministically under random histories', () => {
  it('300 random sessions — recorded decisions always verify, and a single swapped call is always caught', () => {
    let s = 7;
    const rnd = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 300; round++) {
      const policies = new Map([
        ['p', { priority_order: rnd() < 0.5 ? [NORMAL] : [URGENT, PRIORITY, NORMAL] }],
      ]);
      const order = policies.get('p')?.priority_order ?? [NORMAL];
      const events: QueueEventForReplay[] = history(() => []);
      const waiting = new Map<string, OrderableTicket>();
      let issued = 0;
      for (let i = 0; i < 25; i++) {
        const roll = rnd();
        if (roll < 0.45 || waiting.size === 0) {
          issued++;
          const id = `t${issued}`;
          const w = at(Math.floor(rnd() * 50)); // transfers can carry older join times
          waiting.set(id, t(id, issued, w));
          events.push(create(id, issued, w));
        } else if (roll < 0.6) {
          const ids = [...waiting.keys()];
          const id = ids[Math.floor(rnd() * ids.length)] as string;
          const cur = waiting.get(id) as OrderableTicket;
          const to = [NORMAL, PRIORITY, URGENT].filter((c) => c !== cur.priority_class)[
            Math.floor(rnd() * 2)
          ] as PriorityClass;
          events.push(
            ev(QueueAction.TICKET_PRIORITY_OVERRIDE, {
              ticket_id: id,
              from_class: cur.priority_class,
              to_class: to,
            }),
          );
          waiting.set(id, { ...cur, priority_class: to });
        } else {
          const next = decideNextCall([...waiting.values()], {
            version: 'p',
            priority_order: order,
          });
          if (!next) continue;
          events.push(call(next.ticket.id, 'p'));
          waiting.delete(next.ticket.id);
        }
      }
      const ok = verifyRoutingDecisions(events, policies);
      expect(ok.valid, `round ${round}`).toBe(true);
      // Tamper: change the ticket of one call to another ticket that was waiting at that time
      const calls = events
        .map((e, i) => [e, i] as const)
        .filter(([e]) => e.event_type === QueueAction.TICKET_CALL_NEXT);
      const victim = calls.find(([e, i]) => {
        const later = events
          .slice(0, i)
          .filter((x) => x.event_type === 'ticket.create')
          .map((x) => x.payload['ticket_id']);
        return later.some(
          (id) =>
            id !== e.payload['ticket_id'] &&
            !events
              .slice(0, i)
              .some(
                (x) =>
                  x.event_type === QueueAction.TICKET_CALL_NEXT && x.payload['ticket_id'] === id,
              ),
        );
      });
      if (!victim) continue;
      const [ve, vi] = victim;
      const alt = events
        .slice(0, vi)
        .filter((x) => x.event_type === 'ticket.create')
        .map((x) => x.payload['ticket_id'] as string)
        .find(
          (id) =>
            id !== ve.payload['ticket_id'] &&
            !events
              .slice(0, vi)
              .some(
                (x) =>
                  x.event_type === QueueAction.TICKET_CALL_NEXT && x.payload['ticket_id'] === id,
              ),
        );
      const tampered = events.map((e, i) =>
        i === vi ? { ...e, payload: { ...e.payload, ticket_id: alt } } : e,
      );
      const bad = verifyRoutingDecisions(tampered, policies);
      expect(bad.valid, `tamper round ${round}`).toBe(false);
    }
  });
});
