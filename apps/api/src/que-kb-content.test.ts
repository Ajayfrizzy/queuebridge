import { describe, expect, it } from 'vitest';
import {
  MILESTONES,
  Permission,
  QueueAction,
  Role,
  TicketState,
  type KbArticle,
  type PermissionName,
} from '@queuebridge/contracts';
import { TRANSITION_RULES } from '@queuebridge/domain';
import { ROLE_NAMES, answer, operationRoles, type KbBundle } from '@queuebridge/assist';
import { buildCapabilityManifest, type CapabilityFlags } from './que/capabilities.js';
import { loadKnowledgeBase } from './que/kb.js';

/**
 * MQ.5 content checks that need the server (design §11.3 D3 check 4, §11.10a; Group 13.5
 * content parts): the compiled bundles the API actually serves, the capability manifest the
 * server actually builds, and the domain state machine that actually authorizes queue actions.
 * Every "Who can do this" line in an article is compared with those sources, so no article can
 * claim that a role performs a step the API refuses.
 */

const kb = loadKnowledgeBase();
const byId = new Map<string, KbArticle>();
for (const b of Object.values(kb.bundles)) for (const a of b.articles) byId.set(a.id, a);
const ALL = [...byId.values()];
const BUNDLE: KbBundle = { kbVersion: kb.kbVersion, articles: ALL };
const article = (id: string): KbArticle => {
  const a = byId.get(id);
  if (!a) throw new Error(`missing article ${id}`);
  return a;
};
/** Body with blank lines removed (Markdown block spacing is not part of a claim). */
const lines = (id: string): string => article(id).body.replace(/\n{2,}/g, '\n');

const CANONICAL = Object.values(Role);
const names = (roles: readonly string[]): string =>
  CANONICAL.filter((r) => roles.includes(r))
    .map((r) => ROLE_NAMES[r])
    .join(', ');

/** Article step → state-machine transition it describes. */
const OPERATION_CLAIMS: readonly [string, string, QueueAction, TicketState][] = [
  ['staff.counter.calling', 'Call next', QueueAction.TICKET_CALL_NEXT, TicketState.WAITING],
  ['staff.counter.calling', 'Start serving', QueueAction.TICKET_SERVE, TicketState.CALLED],
  ['staff.counter.calling', 'Complete', QueueAction.TICKET_COMPLETE, TicketState.SERVING],
  ['staff.counter.calling', 'Did not come (missed)', QueueAction.TICKET_MISS, TicketState.CALLED],
  ['staff.counter.calling', 'Put on hold', QueueAction.TICKET_PAUSE, TicketState.SERVING],
  [
    'staff.counter.calling',
    'Return a held visitor to the queue',
    QueueAction.TICKET_RESUME,
    TicketState.PAUSED,
  ],
  [
    'staff.counter.calling',
    'Recall a called visitor',
    QueueAction.TICKET_RESUME,
    TicketState.CALLED,
  ],
  [
    'staff.fairness.priority',
    'Change priority',
    QueueAction.TICKET_PRIORITY_OVERRIDE,
    TicketState.WAITING,
  ],
  [
    'staff.fairness.priority',
    'Call out of order',
    QueueAction.TICKET_CALL_SPECIFIC,
    TicketState.WAITING,
  ],
  [
    'staff.transfers',
    'Transfer to another service',
    QueueAction.TICKET_TRANSFER,
    TicketState.SERVING,
  ],
  [
    'staff.transfers',
    'Send to another counter',
    QueueAction.TICKET_COUNTER_TRANSFER,
    TicketState.CALLED,
  ],
  [
    'staff.transfers',
    'Send to another counter',
    QueueAction.TICKET_COUNTER_TRANSFER,
    TicketState.SERVING,
  ],
  [
    'staff.missed.rejoin',
    'Return a missed visitor to the queue',
    QueueAction.TICKET_RESUME,
    TicketState.MISSED,
  ],
];

/** Article "who" section → API permission it describes (plus org_admin, as the API allows). */
const PERMISSION_CLAIMS: readonly [string, string, PermissionName][] = [
  ['staff.walkin', '## Who can do this', 'WALK_IN'],
  ['staff.recovery.assist', '## Who can do this', 'WALK_IN'],
  ['staff.queue.open', '## Who can do this', 'QUEUE_MANAGE'],
  ['staff.coordinator.manage', '## Who can do this', 'QUEUE_MANAGE'],
  ['staff.conflicts.review', '## Who can do this', 'QUEUE_MANAGE'],
  ['staff.recovery.approve', '## Who can do this', 'QUEUE_MANAGE'],
  ['staff.audit.trail', '## Who can open it', 'AUDIT_VIEW'],
  ['staff.recovery.activity', '## Who can open it', 'AUDIT_VIEW'],
];

describe('D3 check 4 for article steps: roles named = state machine', () => {
  it.each(OPERATION_CLAIMS.map((c) => [`${c[0]}: ${c[1]}`, c] as const))('%s', (_n, c) => {
    const [id, label, action, from] = c;
    const roles = operationRoles({ action, from }, TRANSITION_RULES);
    expect(roles.length).toBeGreaterThan(0);
    expect(lines(id)).toContain(`- ${label}: ${names(roles)}.`);
  });

  it.each(PERMISSION_CLAIMS.map((c) => [`${c[0]} (${c[2]})`, c] as const))('%s', (_n, c) => {
    const [id, heading, permission] = c;
    const roles = [...Permission[permission], Role.ORG_ADMIN];
    expect(lines(id)).toContain(`${heading}\n${names(roles)}.`);
  });

  it('every article with a role section is checked above (no unchecked role claims)', () => {
    const checked = new Set([...OPERATION_CLAIMS, ...PERMISSION_CLAIMS].map((c) => c[0]));
    for (const a of ALL) {
      if (/^## Who can (do this|open it)$/m.test(a.body)) expect(checked, a.id).toContain(a.id);
    }
  });

  it('facility administrators are never told they call or serve visitors', () => {
    const calling = article('staff.counter.calling').body;
    for (const line of calling.split('\n').filter((l) => l.startsWith('- ') && l.includes(': '))) {
      expect(line).not.toContain('Facility administrator');
    }
    expect(article('staff.roles.workflows').body).toContain('Does not call or serve visitors.');
  });
});

describe('capability gating against the manifest the server builds', () => {
  const NOW = new Date('2026-11-18T12:00:00Z');
  const flags = (over: Partial<CapabilityFlags> = {}): CapabilityFlags => ({
    visitorJoinOperational: true,
    webPushAvailable: false,
    aiAvailable: 'off',
    ...over,
  });
  const DEFAULT = buildCapabilityManifest(flags(), NOW);
  const WITH_PUSH = buildCapabilityManifest(flags({ webPushAvailable: true }), NOW);
  const visitor = (q: string, m: unknown): ReturnType<typeof answer> =>
    answer(q, { grants: null, facilityId: null, routeId: 'visitor.ticket', manifest: m }, BUNDLE);

  it('every capability an article needs is in the manifest', () => {
    for (const a of ALL) {
      for (const c of a.requiresCapabilities) expect(DEFAULT.capabilities[c], a.id).toBeDefined();
    }
  });

  it('only SMS and USSD articles depend on a planned capability, and none is shown', () => {
    const planned = ALL.filter((a) =>
      a.requiresCapabilities.some((c) => DEFAULT.capabilities[c]?.status === 'planned'),
    ).map((a) => a.id);
    expect(planned.sort()).toEqual(['visitor.alerts.sms', 'visitor.ussd']);
    for (const [q, id] of [
      ['sms text message', 'visitor.alerts.sms'],
      ['ussd', 'visitor.ussd'],
    ] as const) {
      const out = visitor(q, WITH_PUSH);
      expect(out.citations).not.toContain(id);
      expect(out.text).toMatch(/not available yet/);
    }
  });

  it('no live article is older than the capability it describes', () => {
    const order = (m: string): number => (MILESTONES as readonly string[]).indexOf(m);
    for (const a of ALL) {
      for (const c of a.requiresCapabilities) {
        const since = DEFAULT.capabilities[c]?.since;
        if (since)
          expect(order(a.availableSince), `${a.id} / ${c}`).toBeGreaterThanOrEqual(order(since));
      }
    }
  });

  it('push help follows the deployment: withheld without VAPID, offered with it', () => {
    expect(visitor('push notification', DEFAULT).citations).not.toContain('visitor.alerts.push');
    expect(visitor('push notification', DEFAULT).text).toContain(
      'Push turn alerts: not set up here.',
    );
    expect(visitor('push notification', WITH_PUSH).citations).toContain('visitor.alerts.push');
  });

  it('the AI setting article never presents AI as available', () => {
    const a = article('admin.que_ai');
    expect(a.requiresCapabilities).toEqual([]);
    expect(a.body).toMatch(/off by default/);
    expect(a.body).toMatch(/does not switch AI on by itself/);
    expect(DEFAULT.capabilities.ask_que_ai.availability).toBe('unavailable');
  });

  it('online joining switched off: the join article is withheld, not described as usable', () => {
    const off = buildCapabilityManifest(flags({ visitorJoinOperational: false }), NOW);
    expect(visitor('how do I get a ticket', off).citations).not.toContain('visitor.join.status');
  });
});
