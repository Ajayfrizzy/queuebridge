import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { type KbArticle, type RoleGrant, type RouteId } from '@queuebridge/contracts';
import {
  answer,
  kbConsistencyProblems,
  parseCapabilityContract,
  type KbBundle,
  type KbCapabilityContract,
} from '@queuebridge/assist';
import { parseEnv } from './env.js';
import {
  buildCapabilityManifest,
  capabilityFlags,
  type CapabilityFlags,
} from './que/capabilities.js';
import { loadKnowledgeBase } from './que/kb.js';

/**
 * MQ.6 — Group 13.5 knowledge-base consistency against the manifest the SERVER builds. This is
 * the CI gate for the incremental maintenance rule: a later milestone that changes a capability
 * (M6 SMS turn alerts and USSD, a new channel, AI availability) fails here until the affected
 * articles are reviewed and `packages/assist/knowledge/capabilities.json` is updated in the same
 * PR. Production defaults come from the real environment schema with no optional settings.
 */

const require = createRequire(import.meta.url);
const kb = loadKnowledgeBase();
const ARTICLES: KbArticle[] = [
  ...new Map(
    Object.values(kb.bundles)
      .flatMap((b) => b.articles)
      .map((a) => [a.id, a] as const),
  ).values(),
];
const BUNDLE: KbBundle = { kbVersion: kb.kbVersion, articles: ARTICLES };
const parsed = parseCapabilityContract(
  JSON.parse(readFileSync(require.resolve('@queuebridge/assist/kb/capabilities.json'), 'utf8')),
);
const CONTRACT = parsed.contract as KbCapabilityContract;
const NOW = new Date('2026-11-19T12:00:00Z');
const TODAY = new Date().toISOString().slice(0, 10);

/** Production defaults: the real env schema, required settings only (TEST-ONLY placeholders). */
const PRODUCTION_ENV = parseEnv({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  NODE_ENV: 'production',
  AUDIT_SIGNING_KEY_ID: 'test-only-key',
  AUDIT_SIGNING_KEY: 'test-audit-signing-key-at-least-32-characters',
});
const PRODUCTION = buildCapabilityManifest(capabilityFlags(PRODUCTION_ENV), NOW);

describe('Group 13.5: articles and the server manifest agree', () => {
  it('the committed contract parses', () => {
    expect(parsed.problems).toEqual([]);
  });

  it('every rule passes against the manifest the server builds with production defaults', () => {
    expect(
      kbConsistencyProblems({
        articles: ARTICLES,
        contract: CONTRACT,
        manifest: PRODUCTION,
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it('every capability an article requires is in the manifest, and planned ones are never shown', () => {
    for (const a of ARTICLES) {
      for (const c of a.requiresCapabilities)
        expect(PRODUCTION.capabilities[c], a.id).toBeDefined();
    }
    for (const [id, e] of Object.entries(PRODUCTION.capabilities)) {
      if (e.status !== 'planned') continue;
      for (const articleId of CONTRACT.capabilities[id]?.articles ?? []) {
        const out = answer(
          ARTICLES.find((a) => a.id === articleId)?.title ?? articleId,
          { grants: null, facilityId: null, routeId: 'visitor.ticket', manifest: PRODUCTION },
          BUNDLE,
        );
        expect(out.citations, `${articleId} is shown although ${id} is planned`).not.toContain(
          articleId,
        );
      }
    }
  });

  it.each([
    ['web push configured', { webPushAvailable: true }],
    ['online joining switched off', { visitorJoinOperational: false }],
    ['TEST-ONLY sandbox AI', { aiAvailable: 'sandbox' as const }],
  ])('no wording or dating contradiction with %s', (_name, over) => {
    const flags: CapabilityFlags = { ...capabilityFlags(PRODUCTION_ENV), ...over };
    const m = buildCapabilityManifest(flags, NOW);
    // C4/C5 compare with production defaults only; the content rules hold in every deployment
    const problems = kbConsistencyProblems({
      articles: ARTICLES,
      contract: CONTRACT,
      manifest: m,
    }).filter((p) => !p.startsWith('C4 ') && !p.startsWith('C5 '));
    expect(problems).toEqual([]);
  });
});

describe('Group 13.5 fixture: VAPID absent (design §11.2, decision D1)', () => {
  it('the manifest reports Web Push live / unavailable / not_configured', () => {
    expect(PRODUCTION.capabilities.turn_alert_web_push).toMatchObject({
      status: 'live',
      availability: 'unavailable',
      unavailableReason: 'not_configured',
    });
  });

  const grants: [string, RoleGrant[] | null, RouteId][] = [
    ['visitor', null, 'visitor.ticket'],
    [
      'counter',
      [{ role: 'staff_counter', facility_id: '0193a000-0000-7000-8000-00000000000a' }],
      'staff.console',
    ],
    [
      'supervisor',
      [{ role: 'supervisor', facility_id: '0193a000-0000-7000-8000-00000000000a' }],
      'staff.connectivity',
    ],
  ];
  it.each(grants)('no answer offers push as usable (%s)', (_who, g, routeId) => {
    for (const q of [
      'push notification',
      'push alert',
      'notify me in the background',
      'push sent not confirmed',
      '',
    ]) {
      const out = answer(
        q,
        {
          grants: g,
          facilityId: '0193a000-0000-7000-8000-00000000000a',
          routeId,
          manifest: PRODUCTION,
        },
        BUNDLE,
      );
      for (const id of CONTRACT.capabilities['turn_alert_web_push']?.articles ?? []) {
        expect(out.citations, `"${q}"`).not.toContain(id);
      }
      expect(out.text).not.toMatch(/Push turn alerts: (?!not set up here)/);
    }
  });
});
