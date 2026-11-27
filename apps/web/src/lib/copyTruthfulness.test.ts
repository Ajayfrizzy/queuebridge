import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 14.9 copy truthfulness: no UI string promises delivery, timing or background vibration
 * (REQ-F14.9; ADR-013). Scans every non-test source file of the web app and the service-worker
 * handler, with comments removed, so only text that can reach a person is checked.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const FILES = [
  ...(function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx?|js)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
    });
  })(SRC),
  join(SRC, '..', 'public', 'push-handler.js'),
];
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const FORBIDDEN: [RegExp, string][] = [
  [/guarantee/i, 'guarantee'],
  [/will (always )?(be )?(notif|alert|deliver|reach|arrive|vibrat)/i, 'a promise of an alert'],
  [/never miss/i, 'never miss'],
  [/always (arrive|reach|deliver|notif|vibrat|work)/i, 'always works'],
  [/(instant|immediate)(ly)? (alert|notif|push)/i, 'instant alerts'],
  [
    /vibrat\w* (even )?(in the background|when (the )?(page|app|browser|screen) is (closed|locked|off))/i,
    'background vibration',
  ],
  [/(push|alert|notification)s? (is|are|was|were) delivered/i, 'a delivery claim'],
];

describe('14.9 no UI string promises delivery or background vibration', () => {
  it('scans the web app and the service worker', () => {
    expect(FILES.length).toBeGreaterThan(40);
    const hits: string[] = [];
    for (const f of FILES) {
      const text = stripComments(readFileSync(f, 'utf8'));
      for (const [re, what] of FORBIDDEN) {
        const m = re.exec(text);
        if (m) hits.push(`${relative(SRC, f)}: ${what} ("${m[0]}")`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the push copy states the limits plainly', () => {
    const panel = readFileSync(join(SRC, 'components', 'PushAlertPanel.tsx'), 'utf8');
    expect(panel).toContain('Push is best effort');
    expect(panel).toContain('may arrive late or not at all');
    expect(panel).toContain('the reliable way');
    const staff = readFileSync(join(SRC, 'components', 'TurnAlertStatus.tsx'), 'utf8');
    expect(staff).toContain('The public board and calling aloud remain the reliable fallback.');
    expect(staff).toContain("sent: 'Push sent, not confirmed'");
  });
});
