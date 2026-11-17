import type { KbArticle, RestrictedKbResponse } from '@queuebridge/contracts';

/** TEST FIXTURES ONLY (not knowledge-base content). */

const USER = '0193a000-0000-7000-8000-0000000000e1';
const DIGEST = 'a'.repeat(64);
const H = 3600_000;

export function art(id: string, version = 1): KbArticle {
  return {
    id,
    title: `T ${id}`,
    audiences: ['counter'],
    topics: ['connectivity'],
    requiresCapabilities: [],
    relatedRoutes: [],
    availableSince: 'M5',
    version,
    lastReviewed: '2026-11-17',
    keywords: [],
    body: '# Body',
  };
}

export function response(over: Partial<RestrictedKbResponse> = {}): RestrictedKbResponse {
  const articles = over.articles ?? [art('staff.a.one'), art('staff.b.two')];
  return {
    userId: USER,
    roleDigest: DIGEST,
    audiences: ['counter'],
    kbVersion: 1,
    issuedAt: '2020-01-01T00:00:00.000Z',
    authorizedUntil: '2020-01-01T12:00:00.000Z',
    validForMs: 12 * H,
    index: articles.map((a) => ({ id: a.id, version: a.version })),
    articles,
    ...over,
  };
}
