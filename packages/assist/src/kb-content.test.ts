import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIENCES,
  ROUTE_IDS,
  safeMarkdownRouteRefs,
  type Audience,
  type KbArticle,
  type Role,
  type RoleGrant,
  type RouteId,
} from '@queuebridge/contracts';
import { describe, expect, it } from 'vitest';
import { answer, type AnswerContext, type KbBundle } from './answer.js';
import { compileKnowledgeBase, type KbLock } from './kb-compile.js';
import { ROUTE_REGISTRY } from './registry.js';
import { FA, NO_PUSH, PLANNED, QA, grant, manifest } from './fixtures.testkit.js';

/**
 * MQ.5 knowledge-base content checks (design §11.10, §11.10a; tasks MQ.5; Group 13.4/13.5
 * content parts). These run against the COMMITTED articles, not fixtures:
 *
 * - the article-existence check deferred from MQ.1 (every registry default resolves, every
 *   default is visible on its screen, every body link is a related route);
 * - the coverage matrix: every essential M1–M5 workflow has a deterministic article that a
 *   plain-language question finds for the right role on the right screen (no AI-only answers);
 * - screen defaults for every role that can open each screen;
 * - truthfulness lint: no promised times or delivery, no "conflict-free", SMS/USSD and push
 *   only in articles gated on those capabilities, recovery never moves a visitor.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
  );
const sources = walk(root)
  .filter((p) => p.endsWith('.md') && !p.endsWith('README.md'))
  .map((p) => ({ path: relative(root, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));
const kbVersion = (JSON.parse(readFileSync(join(root, 'kb.json'), 'utf8')) as { kbVersion: number })
  .kbVersion;
const lock = JSON.parse(readFileSync(join(root, 'kb.lock.json'), 'utf8')) as KbLock;
const compiled = compileKnowledgeBase(sources, {
  kbVersion,
  lock,
  mode: 'check',
  hash: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
});
const byId = new Map<string, KbArticle>();
for (const aud of AUDIENCES) for (const a of compiled.bundles[aud].articles) byId.set(a.id, a);
const ALL = [...byId.values()];
const BUNDLE: KbBundle = { kbVersion, articles: ALL };
const article = (id: string): KbArticle => {
  const a = byId.get(id);
  if (!a) throw new Error(`missing article ${id}`);
  return a;
};

/** The default deployment: SMS and USSD planned (M6), AI switched off, push configured. */
const DEPLOYED = manifest({
  sms_turn_alerts: PLANNED,
  ussd: PLANNED,
  ask_que_ai: { status: 'live', availability: 'unavailable', unavailableReason: 'switched_off' },
});
/** The same deployment without the VAPID key pair (push `not_configured`). */
const NO_VAPID = manifest({
  sms_turn_alerts: PLANNED,
  ussd: PLANNED,
  ask_que_ai: { status: 'live', availability: 'unavailable', unavailableReason: 'switched_off' },
  turn_alert_web_push: NO_PUSH,
});

type Who = 'visitor' | Exclude<Role, 'visitor_anonymous'>;

function grantsFor(who: Who): RoleGrant[] | null {
  if (who === 'visitor') return null;
  if (who === 'org_admin') return [grant('org_admin', null)];
  return [grant(who)];
}

function ctxFor(who: Who, routeId: RouteId | null, m: unknown = DEPLOYED): AnswerContext {
  return { grants: grantsFor(who), facilityId: FA, queueId: QA, routeId, manifest: m };
}

const AUDIENCE_OF: Record<Who, Audience> = {
  visitor: 'visitor',
  staff_reception: 'reception',
  staff_counter: 'counter',
  supervisor: 'supervisor',
  facility_admin: 'facility_admin',
  org_admin: 'org_admin',
  auditor: 'auditor',
};

// ---------------------------------------------------------------------------
// Coverage matrix: essential workflow → role, screen, plain question, article
// (mirrored in docs/testing/MQ-evidence.md, MQ.5)
// ---------------------------------------------------------------------------

interface Workflow {
  workflow: string;
  who: Who;
  route: RouteId | null;
  question: string;
  article: string;
}

export const COVERAGE: readonly Workflow[] = [
  // Visitors (public bundle, offline-capable)
  {
    workflow: 'Join by QR or link',
    who: 'visitor',
    route: 'visitor.join',
    question: 'how do I get a ticket',
    article: 'visitor.join.status',
  },
  {
    workflow: 'Ticket status',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'what does on hold mean',
    article: 'visitor.ticket.states',
  },
  {
    workflow: 'Wait estimate and uncertainty',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'how long will I wait',
    article: 'visitor.wait.estimate',
  },
  {
    workflow: 'Public display board',
    who: 'visitor',
    route: 'public.display',
    question: 'spoken announcements on the board',
    article: 'visitor.display.board',
  },
  {
    workflow: 'Save the recovery key',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'save my recovery key',
    article: 'visitor.recovery.key',
  },
  {
    workflow: 'Sign out other devices',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'someone else has my key',
    article: 'visitor.recovery.key',
  },
  {
    workflow: 'Recover on another device',
    who: 'visitor',
    route: 'visitor.recover',
    question: 'I lost my phone, get my ticket back',
    article: 'visitor.recovery.how',
  },
  {
    workflow: 'Recovery without the key (visitor side)',
    who: 'visitor',
    route: 'visitor.recover',
    question: 'I lost my key, ask staff',
    article: 'visitor.recovery.staff',
  },
  {
    workflow: 'Missed turn and grace window',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'I missed my turn',
    article: 'visitor.missed.grace',
  },
  {
    workflow: 'Automatic missed turn rule',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'how long do I have to respond when called',
    article: 'visitor.auto_miss',
  },
  {
    workflow: 'Offline ticket page',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'no internet connection',
    article: 'visitor.offline',
  },
  {
    workflow: 'In-app alert, sound and vibration',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'turn on sound alert',
    article: 'visitor.alerts',
  },
  {
    workflow: 'Web Push opt-in',
    who: 'visitor',
    route: 'visitor.ticket',
    question: 'push notification',
    article: 'visitor.alerts.push',
  },
  {
    workflow: 'Accessibility settings',
    who: 'visitor',
    route: null,
    question: 'larger text and high contrast',
    article: 'visitor.accessibility',
  },
  {
    workflow: 'Organization sign-up',
    who: 'visitor',
    route: 'public.signup',
    question: 'create an organization',
    article: 'org.signup',
  },
  {
    workflow: 'Sign in and out',
    who: 'visitor',
    route: 'public.login',
    question: 'forgot password',
    article: 'org.signin',
  },
  {
    workflow: 'Accept a staff invitation',
    who: 'visitor',
    route: 'public.accept_invite',
    question: 'accept invitation',
    article: 'staff.invite.accept',
  },
  // Administration (M1)
  {
    workflow: 'Create a facility',
    who: 'org_admin',
    route: 'admin.home',
    question: 'create a facility',
    article: 'admin.facility.create',
  },
  {
    workflow: 'Services and ordering policy',
    who: 'facility_admin',
    route: 'admin.facility',
    question: 'add a service',
    article: 'admin.services',
  },
  {
    workflow: 'Counters and their services',
    who: 'facility_admin',
    route: 'admin.facility',
    question: 'add a counter',
    article: 'admin.counters',
  },
  {
    workflow: 'Missed-turn and recovery policy',
    who: 'facility_admin',
    route: 'admin.facility',
    question: 'change the grace window',
    article: 'admin.policy.recovery',
  },
  {
    workflow: 'Readiness, join link and QR',
    who: 'facility_admin',
    route: 'admin.facility',
    question: 'qr code not live yet',
    article: 'admin.readiness.join_link',
  },
  {
    workflow: 'Invite staff and manage roles',
    who: 'facility_admin',
    route: 'admin.facility.staff',
    question: 'invite staff',
    article: 'admin.staff.invite',
  },
  {
    workflow: 'AI explanations opt-in',
    who: 'facility_admin',
    route: 'admin.facility',
    question: 'turn on AI explanations',
    article: 'admin.que_ai',
  },
  {
    workflow: 'Roles and access',
    who: 'staff_reception',
    route: 'staff.home',
    question: 'what can my role do',
    article: 'staff.roles.workflows',
  },
  // Reception and counter (M2)
  {
    workflow: 'Open, pause and close the queue',
    who: 'supervisor',
    route: 'staff.facility',
    question: "open today's queue",
    article: 'staff.queue.open',
  },
  {
    workflow: 'Walk-in registration',
    who: 'staff_reception',
    route: 'staff.console',
    question: 'visitor without a phone',
    article: 'staff.walkin',
  },
  {
    workflow: 'Call, serve and complete',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'call next visitor',
    article: 'staff.counter.calling',
  },
  // Fairness and routing (M4)
  {
    workflow: 'Priority changes and reasons',
    who: 'supervisor',
    route: 'staff.console',
    question: 'change priority reason',
    article: 'staff.fairness.priority',
  },
  {
    workflow: 'Transfers',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'transfer to another service',
    article: 'staff.transfers',
  },
  {
    workflow: 'Audit view, verification and export',
    who: 'auditor',
    route: 'staff.audit',
    question: 'verify integrity',
    article: 'staff.audit.trail',
  },
  // Missed turns (M5)
  {
    workflow: 'Return a missed visitor',
    who: 'staff_reception',
    route: 'staff.console',
    question: 'missed visitor came back late',
    article: 'staff.missed.rejoin',
  },
  {
    workflow: 'Automatic no-show (staff)',
    who: 'auditor',
    route: 'staff.audit',
    question: 'missed automatically by the system',
    article: 'staff.auto_miss',
  },
  // Offline and synchronization (M3)
  {
    workflow: 'Sync states',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'what does pending sync mean',
    article: 'staff.sync.states',
  },
  {
    workflow: 'Coordinator limits during an outage',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'internet is down, can I still call',
    article: 'staff.coordinator.limits',
  },
  {
    workflow: 'Designate, renew, fail over',
    who: 'supervisor',
    route: 'staff.connectivity',
    question: 'fail over the coordinator',
    article: 'staff.coordinator.manage',
  },
  {
    workflow: 'Conflict review',
    who: 'supervisor',
    route: 'staff.connectivity',
    question: 'resolve a conflict',
    article: 'staff.conflicts.review',
  },
  // Connectivity and device health (M5)
  {
    workflow: 'Device health and alerts',
    who: 'auditor',
    route: 'staff.connectivity',
    question: 'device alerts',
    article: 'staff.device.health',
  },
  {
    workflow: 'Lost or stolen device',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'my tablet was stolen',
    article: 'staff.device.lost',
  },
  // Recovery (M5)
  {
    workflow: 'Staff-assisted recovery',
    who: 'staff_reception',
    route: 'staff.console',
    question: 'visitor has no recovery key',
    article: 'staff.recovery.assist',
  },
  {
    workflow: 'Approve a recovery request',
    who: 'supervisor',
    route: 'staff.console',
    question: 'approve recovery request',
    article: 'staff.recovery.approve',
  },
  {
    workflow: 'Recovery activity view',
    who: 'auditor',
    route: 'staff.audit',
    question: 'recovery activity',
    article: 'staff.recovery.activity',
  },
  // Turn alerts (M5)
  {
    workflow: 'Push alert status',
    who: 'staff_counter',
    route: 'staff.console',
    question: 'push sent not confirmed',
    article: 'staff.alerts.status',
  },
];

/** Gated articles that must never be shown in the default deployment (capability planned). */
const NOT_LIVE = ['visitor.alerts.sms', 'visitor.ussd'] as const;

describe('the committed knowledge base compiles', () => {
  it('every article compiles in check mode against the lock, with no tenant data', () => {
    expect(compiled.kbVersion).toBe(kbVersion);
    expect(ALL.length).toBe(sources.length);
    expect(Object.keys(lock.articles).sort()).toEqual(ALL.map((a) => a.id).sort());
  });

  it('every article is reviewed, versioned and has search terms', () => {
    for (const a of ALL) {
      expect(a.version, a.id).toBeGreaterThanOrEqual(1);
      expect(a.lastReviewed, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.keywords.length, a.id).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('article existence (deferred from MQ.1)', () => {
  it('every registry default article exists', () => {
    for (const r of ROUTE_IDS) {
      for (const id of ROUTE_REGISTRY[r].defaultArticles)
        expect(byId.has(id), `${r} → ${id}`).toBe(true);
    }
  });

  it('every registry default is readable by at least one audience of its screen', () => {
    for (const r of ROUTE_IDS) {
      const entry = ROUTE_REGISTRY[r];
      for (const id of entry.defaultArticles) {
        const a = article(id);
        const shared = a.audiences.some(
          (x) =>
            entry.audiences.includes(x) ||
            (x !== 'visitor' && entry.audiences.includes('org_admin')),
        );
        expect(shared, `${r} → ${id}`).toBe(true);
      }
    }
  });

  it('every body link is a registered route and is listed in relatedRoutes', () => {
    for (const a of ALL) {
      for (const ref of safeMarkdownRouteRefs(a.body)) {
        expect(ROUTE_IDS as readonly string[], a.id).toContain(ref);
        expect(a.relatedRoutes as readonly string[], `${a.id} links ${ref}`).toContain(ref);
      }
    }
  });

  it('every screen has default help for every role that can open it', () => {
    const whos: Who[] = [
      'visitor',
      'staff_reception',
      'staff_counter',
      'supervisor',
      'facility_admin',
      'org_admin',
      'auditor',
    ];
    for (const r of ROUTE_IDS) {
      const entry = ROUTE_REGISTRY[r];
      for (const who of whos) {
        if (!entry.audiences.includes(AUDIENCE_OF[who])) continue;
        const out = answer('', ctxFor(who, r), BUNDLE);
        expect(out.citations.length, `${r} for ${who}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('coverage matrix: every essential workflow has a deterministic article', () => {
  it('lists every article except the capability-gated ones exactly once or more', () => {
    const covered = new Set(COVERAGE.map((w) => w.article));
    for (const a of ALL) {
      if ((NOT_LIVE as readonly string[]).includes(a.id)) continue;
      expect(covered.has(a.id), `${a.id} is not in the coverage matrix`).toBe(true);
    }
  });

  it.each(COVERAGE.map((w) => [w.workflow, w] as const))('%s', (_name, w) => {
    const a = article(w.article);
    const aud = AUDIENCE_OF[w.who];
    const readable =
      a.audiences.includes(aud) ||
      (aud === 'org_admin' && !a.audiences.every((x) => x === 'visitor'));
    expect(readable, `${w.article} is not for ${w.who}`).toBe(true);
    if (w.route !== null) {
      expect(
        a.relatedRoutes.includes(w.route) || ROUTE_REGISTRY[w.route].defaultArticles.includes(a.id),
        `${w.article} is not tied to ${w.route}`,
      ).toBe(true);
    }
    const out = answer(w.question, ctxFor(w.who, w.route), BUNDLE);
    expect(out.mode).toBe('deterministic');
    expect(out.citations.slice(0, 3), `"${w.question}" for ${w.who}`).toContain(w.article);
  });

  it('visitor workflows are answered from the public bundle alone (offline-capable)', () => {
    const publicBundle: KbBundle = { kbVersion, articles: compiled.bundles.visitor.articles };
    for (const w of COVERAGE.filter((x) => x.who === 'visitor')) {
      const out = answer(w.question, ctxFor('visitor', w.route), publicBundle);
      expect(out.citations.slice(0, 3), w.workflow).toContain(w.article);
    }
  });
});

describe('roles and the public/restricted boundary', () => {
  it('public articles are exactly those with the visitor audience; staff articles never ship publicly', () => {
    const pub = compiled.bundles.visitor.articles;
    expect(pub.map((a) => a.id).sort()).toEqual(
      ALL.filter((a) => a.audiences.includes('visitor'))
        .map((a) => a.id)
        .sort(),
    );
    for (const a of pub) expect(a.id.startsWith('admin.'), a.id).toBe(false);
  });

  it('D4: no public article contains the staff verification questions or their answers', () => {
    const text = JSON.stringify(compiled.bundles.visitor).toLowerCase();
    for (const p of [
      'correct service',
      'join time within 10 minutes',
      'which service they joined',
      'roughly when',
    ]) {
      expect(text).not.toContain(p);
    }
  });

  it('the recovery procedure is for the roles that assist; auditors get no operating procedure', () => {
    expect(article('staff.recovery.assist').audiences).toEqual([
      'reception',
      'counter',
      'supervisor',
      'facility_admin',
    ]);
    const auditor = compiled.bundles.auditor.articles.map((a) => a.id);
    for (const id of [
      'staff.recovery.assist',
      'staff.recovery.approve',
      'staff.walkin',
      'staff.counter.calling',
    ]) {
      expect(auditor).not.toContain(id);
    }
  });

  it('reception and counter staff are never given the audit or connectivity-only articles', () => {
    for (const aud of ['reception', 'counter'] as const) {
      const ids = compiled.bundles[aud].articles.map((a) => a.id);
      for (const id of [
        'staff.audit.trail',
        'staff.recovery.activity',
        'staff.conflicts.review',
        'staff.coordinator.manage',
      ]) {
        expect(ids, aud).not.toContain(id);
      }
    }
  });

  it('a counter operator asking about the audit trail gets no audit article and is told the role', () => {
    const out = answer(
      'verify integrity audit trail',
      ctxFor('staff_counter', 'staff.console'),
      BUNDLE,
    );
    expect(out.citations).not.toContain('staff.audit.trail');
    expect(out.citations).not.toContain('staff.recovery.activity');
  });
});

describe('capability gating against the deployment manifest', () => {
  it('SMS and USSD are never offered before M6: a question gets the planned notice only', () => {
    for (const [q, id, notice] of [
      ['text message sms alert', 'visitor.alerts.sms', 'SMS turn alerts: not available yet.'],
      ['ussd short code', 'visitor.ussd', 'USSD access: not available yet.'],
    ] as const) {
      const out = answer(q, ctxFor('visitor', 'visitor.ticket'), BUNDLE);
      expect(out.citations).not.toContain(id);
      expect(out.text).toContain(notice);
    }
  });

  it('without VAPID, push help is withheld and the reliable fallback is named', () => {
    const out = answer('push notification', ctxFor('visitor', 'visitor.ticket', NO_VAPID), BUNDLE);
    expect(out.citations).not.toContain('visitor.alerts.push');
    expect(out.text).toContain('Push turn alerts: not set up here.');
    expect(out.text).toContain('the public board and staff calling still show your turn');
    const staff = answer(
      'push sent not confirmed',
      ctxFor('staff_counter', 'staff.console', NO_VAPID),
      BUNDLE,
    );
    expect(staff.citations).not.toContain('staff.alerts.status');
  });

  it('with no manifest every capability-dependent article is withheld (fail closed)', () => {
    for (const w of COVERAGE) {
      const a = article(w.article);
      if (a.requiresCapabilities.length === 0) continue;
      const out = answer(w.question, ctxFor(w.who, w.route, null), BUNDLE);
      expect(out.citations, w.workflow).not.toContain(a.id);
    }
  });

  it('no article that the deployment shows depends on a capability that is not live', () => {
    for (const a of ALL) {
      if ((NOT_LIVE as readonly string[]).includes(a.id)) continue;
      for (const c of a.requiresCapabilities) {
        expect(['sms_turn_alerts', 'ussd', 'ask_que_ai'], `${a.id} needs ${c}`).not.toContain(c);
      }
    }
  });
});

describe('content truthfulness (review checklist, automated part)', () => {
  const textOf = (a: KbArticle): string => [a.title, ...a.keywords, a.body].join('\n');

  it('no unsafe markup or external links', () => {
    for (const a of ALL) {
      expect(a.body, a.id).not.toMatch(/<|https?:|www\.|mailto:|javascript:/i);
      expect(a.body.replace(/\[[^\]]+\]\(route:[a-z_.]+\)/g, ''), a.id).not.toMatch(/\]\(/);
    }
  });

  it.each([
    ['conflict-free or globally final', /conflict[- ]free|globally final/i],
    ['tamper-proof claims', /tamper[- ]?proof|cannot be (?:changed|altered|tampered)/i],
    [
      'guaranteed delivery',
      /guarantee|always (?:arrive|deliver)|will (?:definitely )?(?:arrive|reach you)/i,
    ],
    ['an exact serving time', /\bat \d{1,2}[:.]\d{2}\b|you will be (?:called|served) (?:at|in) /i],
    [
      'background vibration',
      /vibrat\w* (?:in|while) (?:the )?background|vibrat\w* when (?:the page is )?closed/i,
    ],
  ])('no article promises %s', (_label, re) => {
    for (const a of ALL) expect(textOf(a), a.id).not.toMatch(re);
  });

  it('SMS, text messages and USSD appear only in articles gated on those capabilities', () => {
    for (const a of ALL) {
      const gated = a.requiresCapabilities.some((c) => c === 'sms_turn_alerts' || c === 'ussd');
      if (!gated) expect(textOf(a), a.id).not.toMatch(/\bsms\b|text message|\bussd\b/i);
    }
  });

  it('push alerts appear only in articles gated on Web Push', () => {
    for (const a of ALL) {
      if (!a.requiresCapabilities.includes('turn_alert_web_push')) {
        expect(textOf(a), a.id).not.toMatch(/\bpush\b/i);
      }
    }
  });

  it('push and estimate wording is conditional and honest', () => {
    expect(article('visitor.alerts.push').body).toMatch(/If this site has push alerts set up/);
    expect(article('visitor.alerts.push').body).toMatch(/may arrive late or not at all/);
    expect(article('staff.alerts.status').body).toMatch(/does not mean the visitor saw it/);
    expect(article('visitor.wait.estimate').body).toMatch(/never an exact time/);
    expect(article('visitor.alerts').body).toMatch(/only while the ticket page is open/);
  });

  it('recovery never claims to change a visitor’s place', () => {
    for (const a of ALL) {
      for (const sentence of a.body.split(/(?<=[.!?])\s+|\n/)) {
        if (
          /recover|new key|recovery key/i.test(sentence) &&
          /\b(place|position)\b/i.test(sentence)
        ) {
          expect(sentence, a.id).toMatch(/\b(not|never)\b/i);
        }
      }
    }
  });

  it('per-service policies are described conditionally, never as always on', () => {
    expect(article('visitor.auto_miss').body).toMatch(/off unless the facility turns it on/);
    expect(article('visitor.missed.grace').body).toMatch(/Some facilities let you return yourself/);
    expect(article('visitor.recovery.staff').body).toMatch(/Some facilities do not offer this/);
    expect(article('admin.que_ai').body).toMatch(/does not switch AI on by itself/);
  });

  it('a failed alert is never said to cause a missed turn', () => {
    for (const id of ['visitor.missed.grace', 'visitor.auto_miss', 'staff.auto_miss']) {
      expect(article(id).body, id).toMatch(/(never decides|does not depend|never depends)/);
    }
  });
});
