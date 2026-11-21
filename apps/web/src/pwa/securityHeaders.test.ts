// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, WEB_SECURITY_HEADERS } from './securityHeaders.js';

const directives = new Map(
  CONTENT_SECURITY_POLICY.split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name ?? '', values];
  }),
);

describe('M7.2 web security headers', () => {
  it('the CSP allows no other origin and forbids framing, plugins and base changes', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*|'unsafe-inline'|'unsafe-eval'/);
  });

  it('includes HSTS, framing, referrer, permissions and nosniff', () => {
    expect(Object.keys(WEB_SECURITY_HEADERS).sort()).toEqual(
      [
        'Content-Security-Policy',
        'Permissions-Policy',
        'Referrer-Policy',
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
      ].sort(),
    );
    expect(WEB_SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
    expect(WEB_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    // the turn-alert sound must not be blocked (autoplay is deliberately not restricted)
    expect(WEB_SECURITY_HEADERS['Permissions-Policy']).not.toContain('autoplay');
  });

  it('the deployment requirement document states exactly these values', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(
      resolve(here, '../../../../docs/deployment/web-security-headers.md'),
      'utf8',
    );
    for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) {
      expect(doc, name).toContain(`\`${name}\``);
      expect(doc, name).toContain(`\`${value}\``);
    }
  });
  it('Zod runs jitless, configured before anything else (no eval probe under the CSP)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(resolve(here, '../main.tsx'), 'utf8');
    expect(main.split('\n')[0]).toBe("import './zodConfig.js';");
    expect(readFileSync(resolve(here, '../zodConfig.ts'), 'utf8')).toContain('jitless: true');
  });
});
