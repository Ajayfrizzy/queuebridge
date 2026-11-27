import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Package boundary (AGENTS.md §2, ADR-011): `assist` imports `contracts` only and performs no
 * I/O. Checked statically over the shipped sources (tests and test fixtures excluded).
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(SRC).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts'),
);

describe('packages/assist boundary', () => {
  it('has sources to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files)('%s imports only @queuebridge/contracts or local modules', (f) => {
    const src = readFileSync(join(SRC, f), 'utf8');
    const specs = [...src.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map(
      (m) => m[1] ?? m[2] ?? '',
    );
    for (const s of specs) {
      expect(s === '@queuebridge/contracts' || s.startsWith('./')).toBe(true);
    }
  });

  it.each(files)('%s performs no I/O, inference, storage, randomness or clock reads', (f) => {
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const banned of [
      /\bfetch\s*\(/,
      /XMLHttpRequest|WebSocket|EventSource|navigator\./,
      /indexedDB|localStorage|sessionStorage|caches\./,
      /\bprocess\./,
      /\brequire\s*\(/,
      /Math\.random|Date\.now|new Date\(|performance\.now/,
    ]) {
      expect(src).not.toMatch(banned);
    }
  });
});
