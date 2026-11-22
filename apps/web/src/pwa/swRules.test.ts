import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRECACHE_GLOB_PATTERNS,
  PUBLIC_FACILITY_URL,
  QUE_CAPABILITIES_URL,
  QUE_PUBLIC_KB_URL,
  RUNTIME_CACHING,
} from './swRules.js';

const O = 'http://localhost:4173';
const cached = (url: string): string[] =>
  RUNTIME_CACHING.filter((r) => r.urlPattern.test(url)).map((r) => r.options.cacheName);

describe('service-worker runtime caching (MQ.2 correction of the public-facility rule)', () => {
  it('caches the real public facility path', () => {
    expect(PUBLIC_FACILITY_URL.test(`${O}/api/v1/public/facilities/acme-health/main-clinic`)).toBe(
      true,
    );
    expect(cached(`${O}/api/v1/public/facilities/acme-health/main-clinic`)).toEqual([
      'facility-public-data',
    ]);
    expect(cached(`https://api.example.org/api/v1/public/facilities/a1/b2`)).toEqual([
      'facility-public-data',
    ]);
  });

  it('the old (wrong) path shape matches nothing, and it never matched a real route', () => {
    expect(cached(`${O}/api/v1/facilities/0193a000-0000-7000-8000-00000000000a/public`)).toEqual(
      [],
    );
  });

  it.each([
    ['the live board', '/api/v1/public/facilities/acme/main/board'],
    ['the SSE stream', '/api/v1/public/facilities/acme/main/stream'],
    ['a query string', '/api/v1/public/facilities/acme/main?x=1'],
    ['the restricted Ask Que bundle', '/api/v1/que/kb'],
    ['the restricted bundle with a known list', '/api/v1/que/kb?known=staff.sync.states:1'],
    ['the session', '/api/v1/auth/me'],
    ['a visitor ticket status (bearer token)', '/api/v1/tickets/A123/status'],
    ['a recovery request', '/api/v1/tickets/recover'],
    ['the staff queue console data', '/api/v1/queues/0193a000-0000-7000-8000-0000000000a1'],
    ['the push capability', '/api/v1/push/capability'],
  ])('never caches %s', (_l, path) => {
    expect(cached(`${O}${path}`)).toEqual([]);
  });

  it('caches the public Ask Que bundle and the capability manifest (exact paths)', () => {
    expect(QUE_PUBLIC_KB_URL.test(`${O}/api/v1/que/kb/public`)).toBe(true);
    expect(QUE_PUBLIC_KB_URL.test(`${O}/api/v1/que/kb/public/x`)).toBe(false);
    expect(QUE_CAPABILITIES_URL.test(`${O}/api/v1/que/capabilities`)).toBe(true);
    expect(cached(`${O}/api/v1/que/kb/public`)).toEqual(['que-public-kb']);
    expect(cached(`${O}/api/v1/que/capabilities`)).toEqual(['que-capabilities']);
  });

  it('online freshness: facility details and capabilities are network-first; the KB is SWR', () => {
    const handler = (name: string): string | undefined =>
      RUNTIME_CACHING.find((r) => r.options.cacheName === name)?.handler;
    expect(handler('facility-public-data')).toBe('NetworkFirst');
    expect(handler('que-capabilities')).toBe('NetworkFirst');
    expect(handler('que-public-kb')).toBe('StaleWhileRevalidate');
  });

  it('every rule is bounded (expiry and entry limits)', () => {
    for (const r of RUNTIME_CACHING) {
      expect(r.options.expiration.maxEntries).toBeGreaterThan(0);
      expect(r.options.expiration.maxAgeSeconds).toBeGreaterThan(0);
    }
  });

  it('vite.config.ts uses exactly these rules and precache patterns', () => {
    const cfg = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/runtimeCaching:\s*\[\s*\.\.\.RUNTIME_CACHING,/);
    expect(cfg).toContain('globPatterns: PRECACHE_GLOB_PATTERNS');
    expect(cfg).not.toMatch(/api\\\/v1\\\/facilities/);
    expect(PRECACHE_GLOB_PATTERNS.join()).toContain('json');
  });
});
