import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIENCES, type CapabilityEntry, type KbArticle } from '@queuebridge/contracts';
import { describe, expect, it } from 'vitest';
import { compileKnowledgeBase, type KbLock } from './kb-compile.js';
import {
  kbConsistencyProblems,
  parseCapabilityContract,
  type KbCapabilityContract,
} from './kb-consistency.js';
import { NO_PUSH, manifest } from './fixtures.testkit.js';

/**
 * MQ.6 — Group 13.5 knowledge-base consistency rules against the COMMITTED knowledge base and
 * capability coverage contract. Each rule is shown to accept the committed content and to reject
 * the kind of change a later milestone (M6 SMS/USSD, M7 UI and onboarding) could make without
 * updating its articles. The server-manifest version runs in `apps/api`.
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
const ARTICLES: KbArticle[] = [
  ...new Map(
    AUDIENCES.flatMap((a) => compiled.bundles[a].articles).map((a) => [a.id, a] as const),
  ).values(),
];
const parsed = parseCapabilityContract(
  JSON.parse(readFileSync(join(root, 'capabilities.json'), 'utf8')),
);
const CONTRACT = parsed.contract as KbCapabilityContract;

const SWITCHED_OFF: CapabilityEntry = {
  status: 'live',
  availability: 'unavailable',
  unavailableReason: 'switched_off',
  since: 'MQ',
};
const SMS_NOT_SET_UP: CapabilityEntry = {
  status: 'sandbox',
  availability: 'unavailable',
  unavailableReason: 'not_configured',
  since: 'M6',
};
const USSD_NOT_SET_UP: CapabilityEntry = {
  status: 'sandbox',
  availability: 'unavailable',
  unavailableReason: 'not_configured',
  since: 'M6',
};
const live = (since: CapabilityEntry['since']): CapabilityEntry => ({
  status: 'live',
  availability: 'available',
  since,
});
/** Production defaults, as `buildCapabilityManifest` reports them (VAPID absent, AI off). */
const PRODUCTION = manifest({
  visitor_join: live('M2'),
  ticket_recovery_key: live('M5'),
  staff_assisted_recovery: live('M5'),
  recovery_audit_view: live('M5'),
  self_resume: live('M5'),
  auto_miss: live('M5'),
  offline_coordinator: live('M3'),
  device_health: live('M5'),
  turn_alert_in_app: live('M5'),
  turn_alert_sound: live('M5'),
  turn_alert_vibration: live('M5'),
  turn_alert_web_push: { ...NO_PUSH, since: 'M5' },
  accessibility_prefs: live('M5'),
  // M6.1: built as the TEST-ONLY sandbox; not set up by default (SMS_PROVIDER off)
  sms_turn_alerts: SMS_NOT_SET_UP,
  // M6.2: built as the TEST-ONLY sandbox; not set up by default (USSD_PROVIDER off)
  ussd: USSD_NOT_SET_UP,
  ask_que_ai: SWITCHED_OFF,
});
const TODAY = '2026-11-20';

const check = (
  over: {
    articles?: KbArticle[];
    contract?: KbCapabilityContract;
    manifest?: unknown;
    today?: string;
  } = {},
): string[] =>
  kbConsistencyProblems({
    articles: over.articles ?? ARTICLES,
    contract: over.contract ?? CONTRACT,
    manifest: 'manifest' in over ? over.manifest : PRODUCTION,
    today: over.today ?? TODAY,
  });

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const withArticle = (id: string, change: (a: KbArticle) => KbArticle): KbArticle[] =>
  ARTICLES.map((a) => (a.id === id ? change(clone(a)) : a));

describe('the committed knowledge base is consistent (Group 13.5)', () => {
  it('the capability contract parses and every rule passes against production defaults', () => {
    expect(parsed.problems).toEqual([]);
    expect(check()).toEqual([]);
  });

  it('every rule that needs no server also passes (the build runs these)', () => {
    expect(kbConsistencyProblems({ articles: ARTICLES, contract: CONTRACT })).toEqual([]);
  });
});

describe('C rules: capability coverage contract', () => {
  it('C0 rejects a malformed contract', () => {
    expect(parseCapabilityContract(null).problems).toEqual([
      'C0 capabilities.json is not an object',
    ]);
    expect(parseCapabilityContract({ contractVersion: 2, capabilities: {} }).problems).toContain(
      'C0 contractVersion must be 1',
    );
    const bad = parseCapabilityContract({
      contractVersion: 1,
      capabilities: {
        a: { status: 'gone', defaultAvailability: 'available', articles: [] },
        b: { status: 'live', defaultAvailability: 'maybe', articles: [] },
        c: { status: 'live', defaultAvailability: 'available', articles: [1] },
      },
    });
    expect(bad.problems).toEqual([
      'C0 a: unknown status',
      'C0 b: unknown defaultAvailability',
      'C0 c: articles must be a list of article ids',
    ]);
  });

  it('C1 a capability added to the manifest (for example in M6) without a contract entry fails', () => {
    const c = clone(CONTRACT);
    delete c.capabilities['ussd'];
    c.capabilities['fax_alerts'] = {
      status: 'planned',
      defaultAvailability: 'not_implemented',
      articles: ['visitor.ussd'],
    };
    expect(check({ contract: c })).toEqual(
      expect.arrayContaining([
        'C1 ussd: missing from capabilities.json',
        'C1 fax_alerts: not a manifest capability',
      ]),
    );
  });

  it('C2 every capability is documented by an existing article', () => {
    const c = clone(CONTRACT);
    c.capabilities['device_health']!.articles = [];
    c.capabilities['ussd']!.articles = ['visitor.ussd.menu'];
    const p = check({ contract: c });
    expect(p).toContain('C2 device_health: no article documents it');
    expect(p).toContain('C2 ussd: article visitor.ussd.menu does not exist');
  });

  it('C3 a newly gated article must be recorded under its capability', () => {
    const a = withArticle('visitor.offline', (x) => ({
      ...x,
      requiresCapabilities: ['device_health'],
    }));
    expect(check({ articles: a })).toContain(
      'C3 visitor.offline: requires device_health but is not listed under it',
    );
  });

  it('C4 a capability whose status changes (live SMS after M6.1: sandbox → live) fails until its articles are reviewed', () => {
    const m = manifest({ ...clone(PRODUCTION).capabilities, sms_turn_alerts: live('M6') });
    const p = check({ manifest: m });
    expect(p.find((x) => x.startsWith('C4 sms_turn_alerts'))).toMatch(
      /visitor\.alerts\.sms, staff\.sms\.alerts.*reviewed for sandbox/,
    );
    expect(p.some((x) => x.startsWith('C5 sms_turn_alerts'))).toBe(true);
    // The stale sandbox articles are caught on their own too: they still say "test mode"
    expect(p).toContain(
      'A4 visitor.alerts.sms: sms_turn_alerts is live; the article still calls it sandbox or test mode',
    );
    expect(p).toContain(
      'A4 staff.sms.alerts: sms_turn_alerts is live; the article still calls it sandbox or test mode',
    );
  });
  it('C4 the path to compliance: rewrite the articles for live, update the contract', () => {
    const m = manifest({ ...clone(PRODUCTION).capabilities, sms_turn_alerts: live('M6') });
    const c = clone(CONTRACT);
    c.capabilities['sms_turn_alerts'] = {
      status: 'live',
      defaultAvailability: 'available',
      articles: ['visitor.alerts.sms', 'staff.sms.alerts'],
    };
    let a = withArticle('visitor.alerts.sms', (x) => ({
      ...x,
      version: x.version + 1,
      body: '# Text message alerts\n\nYou can ask for a text message when you are called.',
    }));
    a = a.map((x) =>
      x.id === 'staff.sms.alerts'
        ? {
            ...x,
            version: x.version + 1,
            body: '# Text message alerts\n\nThe visitor alert panel shows the text message state.',
          }
        : x,
    );
    expect(check({ manifest: m, contract: c, articles: a })).toEqual([]);
  });
  it('A1 and A2 guarded the planned → sandbox change (USSD in M6.2): the old article fails now', () => {
    const v1 = withArticle('visitor.ussd', (x) => ({
      ...x,
      body: '# USSD\n\nUSSD access is not offered here. Without a smartphone, ask staff for a walk-in ticket.',
    }));
    const p = check({ articles: v1 });
    expect(p).toContain('A1 visitor.ussd: says the feature is unavailable, but ussd is sandbox');
    expect(p).toContain('A2 visitor.ussd: ussd is sandbox; the article must say so');
    // and a contract still saying planned is caught against the sandbox manifest
    const c = clone(CONTRACT);
    c.capabilities['ussd'] = {
      status: 'planned',
      defaultAvailability: 'not_implemented',
      articles: ['visitor.ussd'],
    };
    expect(check({ contract: c }).some((x) => x.startsWith('C4 ussd'))).toBe(true);
  });

  it('C5 a change of default availability fails until the articles are reviewed', () => {
    const m = manifest({ ...clone(PRODUCTION).capabilities, turn_alert_web_push: live('M5') });
    expect(check({ manifest: m })).toContain(
      'C5 turn_alert_web_push: default availability is available but capabilities.json says not_configured: review the articles, then capabilities.json',
    );
  });

  it('C4 a capability missing from the server manifest fails', () => {
    const m = clone(PRODUCTION) as { capabilities: Record<string, unknown> };
    delete m.capabilities['auto_miss'];
    expect(check({ manifest: m })).toContain('C4 auto_miss: missing from the server manifest');
  });
});

describe('lifecycle status, deployment availability and unavailable reason are separate', () => {
  const withCap = (id: string, e: CapabilityEntry): unknown =>
    manifest({ ...clone(PRODUCTION).capabilities, [id]: e });

  it.each(['sms_turn_alerts', 'ussd'] as const)(
    '%s cannot become operational without its article and contract being reviewed',
    (id) => {
      const article = id === 'ussd' ? 'visitor.ussd' : 'visitor.alerts.sms';
      const m = withCap(id, live('M6'));
      // Contract not reviewed: status and availability contradictions
      const stale = check({ manifest: m });
      expect(stale.some((x) => x.startsWith(`C4 ${id}:`))).toBe(true);
      expect(stale.some((x) => x.startsWith(`C5 ${id}:`))).toBe(true);
      // Contract updated, article not: both articles still say "test mode"
      const c = clone(CONTRACT);
      c.capabilities[id] = {
        status: 'live',
        defaultAvailability: 'available',
        articles: CONTRACT.capabilities[id]?.articles ?? [article],
      };
      expect(check({ manifest: m, contract: c })).toContain(
        `A4 ${article}: ${id} is live; the article still calls it sandbox or test mode`,
      );
    },
  );

  it('a different server-computed unavailable reason is a contradiction (C5)', () => {
    const m = withCap('turn_alert_web_push', {
      status: 'live',
      availability: 'unavailable',
      unavailableReason: 'switched_off',
      since: 'M5',
    });
    const p = check({ manifest: m });
    expect(p).toContain(
      'C5 turn_alert_web_push: default availability is switched_off but capabilities.json says not_configured: review the articles, then capabilities.json',
    );
    expect(p.filter((x) => x.startsWith('C4'))).toEqual([]);
  });

  it('an unavailable entry without a reason fails closed (C5)', () => {
    const m = withCap('turn_alert_web_push', {
      status: 'live',
      availability: 'unavailable',
    } as CapabilityEntry);
    expect(check({ manifest: m }).some((x) => x.startsWith('C5 turn_alert_web_push:'))).toBe(true);
  });

  it('a status change with the same availability is caught by C4 alone (status ≠ availability)', () => {
    const m = withCap('device_health', {
      status: 'preview',
      availability: 'available',
      since: 'M5',
    });
    const p = check({ manifest: m });
    expect(p.some((x) => x.startsWith('C4 device_health:'))).toBe(true);
    expect(p.filter((x) => x.startsWith('C5'))).toEqual([]);
  });

  it('deployment differences that the articles allow are not contract violations when only content rules apply', () => {
    // Push configured, joining switched off, AI sandbox: availability differs from the
    // production defaults, but no article contradicts it
    const m = manifest({
      ...clone(PRODUCTION).capabilities,
      turn_alert_web_push: live('M5'),
      visitor_join: {
        status: 'live',
        availability: 'unavailable',
        unavailableReason: 'switched_off',
        since: 'M2',
      },
      ask_que_ai: { status: 'sandbox', availability: 'available', since: 'MQ' },
    });
    const content = kbConsistencyProblems({
      articles: ARTICLES,
      contract: CONTRACT,
      manifest: m,
    }).filter((x) => !x.startsWith('C4 ') && !x.startsWith('C5 '));
    expect(content).toEqual([]);
  });
});

describe('A rules: wording matches what can be shown', () => {
  it('A1 a shown article may not say its feature is not available yet', () => {
    const a = withArticle('visitor.alerts', (x) => ({
      ...x,
      body: `${x.body}\n\nThis is not available yet.`,
    }));
    expect(check({ articles: a })).toContain(
      'A1 visitor.alerts: says the feature is unavailable, but turn_alert_in_app is live',
    );
  });

  it('A2 a preview capability must be labelled', () => {
    const m = manifest({
      ...clone(PRODUCTION).capabilities,
      device_health: { status: 'preview', availability: 'available', since: 'M5' },
    });
    const c = clone(CONTRACT);
    c.capabilities['device_health']!.status = 'preview';
    expect(check({ manifest: m, contract: c })).toEqual(
      expect.arrayContaining([
        'A2 staff.device.health: device_health is preview; the article must say so',
      ]),
    );
  });

  it('A3 an article written for a later milestone (M7 onboarding) must stay behind a capability that is not live', () => {
    const a = withArticle('org.signup', (x) => ({ ...x, availableSince: 'M7' }));
    expect(check({ articles: a })).toContain(
      'A3 org.signup: dated M7, later than any live capability, but not gated on one that is not live',
    );
    // The SMS and USSD articles are dated M6 and gated on planned capabilities: accepted
    expect(check().filter((p) => p.startsWith('A3'))).toEqual([]);
  });
});

describe('R rules: routes', () => {
  it('R1 an article may only relate routes its audiences can open', () => {
    const a = withArticle('staff.walkin', (x) => ({
      ...x,
      audiences: ['reception'],
      relatedRoutes: ['staff.console', 'staff.audit'],
    }));
    expect(check({ articles: a })).toContain(
      'R1 staff.walkin: none of its audiences can open staff.audit',
    );
  });

  it('R2 a body link must be a related route', () => {
    const a = withArticle('visitor.offline', (x) => ({
      ...x,
      body: `${x.body}\n\nSee [the board](route:public.display).`,
    }));
    expect(check({ articles: a })).toContain(
      'R2 visitor.offline: links public.display, which is not a related route',
    );
  });

  it('R3 a screen default whose article is removed fails', () => {
    const a = ARTICLES.filter((x) => x.id !== 'staff.audit.trail');
    expect(check({ articles: a })).toEqual(
      expect.arrayContaining(['R3 staff.audit: default article staff.audit.trail does not exist']),
    );
  });
});

describe('V rules: review metadata', () => {
  it('V1 a review date in the future fails', () => {
    expect(check({ today: '2026-11-17' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^V1 org\.signup: reviewed in the future/)]),
    );
  });
});
