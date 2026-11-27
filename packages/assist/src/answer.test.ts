import { describe, expect, it } from 'vitest';
import {
  QueAnswerSchema,
  ROUTE_IDS,
  type CapabilityManifest,
  type RoleGrant,
  type RouteId,
} from '@queuebridge/contracts';
import {
  ASK_STAFF,
  NO_MATCH,
  answer,
  audiencesFor,
  buildIndex,
  capabilityNotice,
  gateFor,
  partitionArticles,
  permittedLinks,
  search,
  tokenize,
  type AnswerContext,
} from './index.js';
import {
  ARTICLES,
  BUNDLE,
  FA,
  FB,
  NO_PUSH,
  PLANNED,
  QA,
  grant,
  manifest,
} from './fixtures.testkit.js';

const M = manifest({ sms_turn_alerts: PLANNED, ussd: PLANNED, ask_que_ai: PLANNED });

function ctx(over: Partial<AnswerContext> = {}): AnswerContext {
  return { routeId: null, grants: null, facilityId: null, manifest: M, ...over };
}

const byId = new Map(ARTICLES.map((a) => [a.id, a]));

describe('tokenize and ranking (design §11.4)', () => {
  it('normalizes case, accents, punctuation, stopwords and simple plurals', () => {
    expect(tokenize('How do I RECOVER my Tickets?! Café')).toEqual(['recover', 'ticket', 'cafe']);
    expect(tokenize('status access')).toEqual(['status', 'access']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('is deterministic: identical input gives identical output, ties broken by id', () => {
    const index = buildIndex(ARTICLES);
    const first = search(index, 'recovery', { limit: 10 }).map((h) => h.article.id);
    for (let i = 0; i < 20; i++) {
      expect(search(index, 'recovery', { limit: 10 }).map((h) => h.article.id)).toEqual(first);
    }
    // Reversed input order does not change the ranking
    const rev = search(buildIndex([...ARTICLES].reverse()), 'recovery', { limit: 10 });
    expect(rev.map((h) => h.article.id)).toEqual(first);
  });

  it('ranks a title match above a keyword-only match', () => {
    const hits = search(buildIndex(ARTICLES), 'sync', { limit: 5 }).map((h) => h.article.id);
    expect(hits[0]).toBe('staff.sync.states');
  });

  it('boosts articles linked to the current screen (screen-aware)', () => {
    const index = buildIndex(ARTICLES);
    // Equal scores without context: the tie is broken by id (activity < approve)
    const plain = search(index, 'approver', { limit: 5 }).map((h) => h.article.id);
    expect(plain).toEqual(['staff.recovery.activity', 'staff.recovery.approve']);
    // On the console, the article linked to that screen moves first
    const onConsole = search(index, 'approver', { routeId: 'staff.console', limit: 5 }).map(
      (h) => h.article.id,
    );
    expect(onConsole).toEqual(['staff.recovery.approve', 'staff.recovery.activity']);
    const onAudit = search(index, 'approver', { routeId: 'staff.audit', limit: 5 }).map(
      (h) => h.article.id,
    );
    expect(onAudit).toEqual(['staff.recovery.activity', 'staff.recovery.approve']);
  });

  it('matches nothing for unrelated text and truncates very long queries', () => {
    expect(search(buildIndex(ARTICLES), 'zzqx', {})).toEqual([]);
    expect(() => search(buildIndex(ARTICLES), 'recovery '.repeat(10_000), {})).not.toThrow();
  });
});

describe('deterministic answers and fallback', () => {
  it('answers with matching articles and permitted links', () => {
    const r = answer('lost recovery key', ctx({ routeId: 'visitor.ticket' }), BUNDLE);
    expect(r.mode).toBe('deterministic');
    expect(r.citations).toContain('visitor.recovery.key');
    expect(r.links).toEqual(['visitor.recover']);
    expect(r.kbVersion).toBe(7);
    expect(r.fallbackReason).toBeUndefined();
  });

  it('falls back to the screen defaults and "ask staff" when nothing matches', () => {
    const r = answer('zzqx unrelated', ctx({ routeId: 'visitor.recover' }), BUNDLE);
    expect(r.citations).toEqual(['visitor.recovery.how', 'visitor.recovery.staff']);
    expect(r.text).toContain('No help article matched your question.');
    expect(r.text).toContain(ASK_STAFF);
  });

  it('NO_MATCH leads exactly the answers whose question matched nothing (the panel announces from it)', () => {
    const miss = answer('zzqx unrelated', ctx({ routeId: 'visitor.recover' }), BUNDLE);
    expect(miss.citations.length).toBeGreaterThan(0); // screen defaults are still shown
    expect(miss.text.startsWith(NO_MATCH)).toBe(true);
    const hit = answer('lost recovery key', ctx({ routeId: 'visitor.recover' }), BUNDLE);
    expect(hit.citations.length).toBeGreaterThan(0);
    expect(hit.text.startsWith(NO_MATCH)).toBe(false);
    const empty = answer('  ', ctx({ routeId: 'visitor.recover' }), BUNDLE);
    expect(empty.text.startsWith(NO_MATCH)).toBe(false);
  });
  it('an empty question shows help for this screen', () => {
    const r = answer('  ', ctx({ routeId: 'visitor.recover' }), BUNDLE);
    expect(r.citations).toEqual(['visitor.recovery.how', 'visitor.recovery.staff']);
    expect(r.text).not.toContain('No help article matched');
  });

  it('with no screen and no match: no citations, still a useful answer', () => {
    const r = answer('zzqx', ctx(), BUNDLE);
    expect(r.citations).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.text).toContain(ASK_STAFF);
  });

  it('screen defaults the user may not read are skipped (no leak through defaults)', () => {
    // staff.console defaults include supervisor-only and staff-only articles
    const reception = answer(
      '',
      ctx({
        routeId: 'staff.console',
        grants: [grant('staff_reception')],
        facilityId: FA,
        queueId: QA,
      }),
      BUNDLE,
    );
    expect(reception.citations).toContain('staff.recovery.assist');
    expect(reception.citations).not.toContain('staff.recovery.approve');
    const visitor = answer('', ctx({ routeId: 'staff.console' }), BUNDLE);
    expect(visitor.citations).toEqual([]);
  });
});

describe('role-aware filtering (REQ-F13.5)', () => {
  it('visitors never receive staff articles, even when the query names them', () => {
    const r = answer(
      'staff verification questions service join time approver audit',
      ctx(),
      BUNDLE,
    );
    for (const id of r.citations) expect(byId.get(id)!.audiences).toContain('visitor');
  });

  it('D4: anonymous help never cites the staff verification article', () => {
    for (const q of [
      'verification questions',
      'what will staff ask',
      'service join time',
      'recovery',
    ]) {
      const r = answer(q, ctx({ routeId: 'visitor.recover' }), BUNDLE);
      expect(r.citations).not.toContain('staff.recovery.assist');
      expect(r.text).not.toContain('FIXTURE-STAFF-ONLY-VERIFICATION-CONTENT');
    }
    const staff = answer(
      'verification questions',
      ctx({ grants: [grant('staff_counter')], facilityId: FA }),
      BUNDLE,
    );
    expect(staff.citations[0]).toBe('staff.recovery.assist');
  });

  it('recovery activity is for supervisors, facility admins and auditors only', () => {
    const q = 'recovery activity audit';
    const as = (role: RoleGrant['role']): string[] =>
      answer(q, ctx({ grants: [grant(role)], facilityId: FA }), BUNDLE).citations;
    expect(as('staff_reception')).not.toContain('staff.recovery.activity');
    expect(as('staff_counter')).not.toContain('staff.recovery.activity');
    expect(as('auditor')).toContain('staff.recovery.activity');
    expect(as('supervisor')).toContain('staff.recovery.activity');
    // Auditors never get the staff-assisted action steps
    expect(as('auditor')).not.toContain('staff.recovery.assist');
  });

  it('org_admin receives every staff audience (design §11.2 correction)', () => {
    expect(audiencesFor([grant('org_admin', null)])).toEqual([
      'visitor',
      'reception',
      'counter',
      'supervisor',
      'facility_admin',
      'org_admin',
      'auditor',
    ]);
    const r = answer(
      'approve recovery request',
      ctx({ grants: [grant('org_admin', null)], facilityId: FA }),
      BUNDLE,
    );
    expect(r.citations).toContain('staff.recovery.approve');
  });

  it('names the required role (by role, never a person) instead of linking a forbidden screen', () => {
    const r = answer(
      'sync states',
      ctx({ grants: [grant('staff_reception')], facilityId: FA, queueId: QA }),
      BUNDLE,
    );
    expect(r.citations).toContain('staff.sync.states');
    expect(r.links).toContain('staff.console');
    expect(r.links).not.toContain('staff.connectivity');
    expect(r.text).toContain(
      'Opening connectivity and recovery needs one of these roles: Supervisor, Facility administrator, Auditor (read-only), Organization administrator.',
    );
  });
});

describe('capability gating (decision D1)', () => {
  it('Web Push not configured: never offered, explained with the reliable fallback', () => {
    const m = manifest({ turn_alert_web_push: NO_PUSH });
    const r = answer(
      'push notification alert',
      ctx({ manifest: m, routeId: 'visitor.ticket' }),
      BUNDLE,
    );
    expect(r.citations).not.toContain('visitor.alerts.push');
    expect(r.citations).toContain('visitor.alerts');
    expect(r.text).toContain('Push turn alerts: not set up here.');
    expect(r.text).toContain('the public board and staff calling still show your turn');
    expect(gateFor(m, ['turn_alert_web_push'])).toBe('blocked');
  });

  it('Web Push configured: the push article is offered', () => {
    const r = answer('push notification alert', ctx({ routeId: 'visitor.ticket' }), BUNDLE);
    expect(r.citations[0]).toBe('visitor.alerts.push');
    expect(r.text).not.toContain('not set up here');
  });

  it('planned SMS/USSD: "not available yet", never cited', () => {
    const r = answer('sms text message ussd', ctx(), BUNDLE);
    expect(r.citations).toEqual([]);
    expect(r.text).toContain('SMS turn alerts: not available yet.');
    expect(r.text).toContain('USSD access: not available yet.');
  });

  it('sandbox capability: shown with a test-only label, never as usable', () => {
    const m = manifest({ sms_turn_alerts: { status: 'sandbox', availability: 'available' } });
    const r = answer('sms alerts', ctx({ manifest: m }), BUNDLE);
    expect(r.citations).toContain('visitor.sms.alerts');
    expect(r.text).toContain('SMS turn alerts: sandbox (test only, no real messages).');
  });

  it('fails closed with a missing or malformed manifest (only capability-free articles remain)', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { capabilities: { turn_alert_in_app: { status: 'live' } } },
    ]) {
      const { visible } = partitionArticles(BUNDLE, { grants: null, manifest: bad });
      for (const v of visible) expect(v.article.requiresCapabilities).toEqual([]);
      expect(capabilityNotice(bad, 'turn_alert_in_app')).toBe(
        'In-app turn alerts: not available here.',
      );
    }
  });
});

describe('no unauthorized links or articles (exhaustive over roles, facilities and screens)', () => {
  const roleSets: (RoleGrant[] | null)[] = [
    null,
    [grant('staff_reception')],
    [grant('staff_counter')],
    [grant('supervisor')],
    [grant('facility_admin')],
    [grant('auditor')],
    [grant('org_admin', null)],
    [grant('staff_counter'), grant('auditor', FB)],
    [grant('supervisor', FB)],
  ];
  const manifests: CapabilityManifest[] = [
    M,
    manifest({ turn_alert_web_push: NO_PUSH, ...{ device_health: NO_PUSH } }),
  ];
  const queries = ['', 'recovery', 'audit approver', 'sync offline', 'push alert', 'zzqx', 'roles'];
  const screens: (RouteId | null)[] = [null, ...ROUTE_IDS];

  it('every answer is schema-valid, read-only and within the user’s authority', () => {
    let checked = 0;
    for (const grants of roleSets) {
      const audiences = new Set(audiencesFor(grants));
      for (const facilityId of [FA, FB, null]) {
        for (const m of manifests) {
          for (const routeId of screens) {
            for (const q of queries) {
              const c = ctx({ grants, facilityId, queueId: QA, routeId, manifest: m });
              const r = answer(q, c, BUNDLE);
              // Strict schema: no extra fields (no actions), deterministic mode, no AI fallback
              expect(QueAnswerSchema.parse(r)).toEqual(r);
              expect(r.mode).toBe('deterministic');
              expect(r.fallbackReason).toBeUndefined();
              const allowedLinks = new Set(permittedLinks(c));
              for (const l of r.links) expect(allowedLinks.has(l)).toBe(true);
              for (const id of r.citations) {
                const art = byId.get(id)!;
                expect(art.audiences.some((a) => audiences.has(a))).toBe(true);
                expect(gateFor(m, art.requiresCapabilities)).not.toBe('blocked');
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(roleSets.length * 3 * manifests.length * screens.length * queries.length);
  });

  it('answering does not mutate the bundle, manifest or context', () => {
    const snapshot = JSON.stringify({ BUNDLE, M });
    const c = ctx({ grants: [grant('supervisor')], facilityId: FA, routeId: 'staff.console' });
    const before = JSON.stringify(c);
    answer('recovery', c, BUNDLE);
    expect(JSON.stringify({ BUNDLE, M })).toBe(snapshot);
    expect(JSON.stringify(c)).toBe(before);
  });
});
