// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * MQ.6 — Group 13.5 stale-content check for UI changes (M7 redesign and onboarding). Articles
 * quote screen text in bold (button labels, headings, field and status labels). Every quoted
 * label must still exist in the screens' source: `apps/web` and the packages it renders text
 * from (`packages/ui`, `packages/domain`). A redesign that renames or removes a control fails
 * here until the article that names it is updated in the same PR.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Screen source with JSX spacing and line breaks normalised. */
const normalise = (s: string): string =>
  s
    .replace(/\{' '\}/g, ' ')
    .replace(/&apos;|’/g, "'")
    .replace(/\s+/g, ' ');

const SCREEN_SOURCE = normalise(
  ['apps/web/src', 'packages/ui/src', 'packages/domain/src']
    .flatMap((d) => walk(join(repo, d)))
    .filter((p) => /\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p) && !p.includes('testkit'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n'),
);

interface Article {
  id: string;
  body: string;
}
const ARTICLES: Article[] = [
  ...new Map(
    ['visitor', 'reception', 'counter', 'supervisor', 'facility_admin', 'auditor']
      .flatMap(
        (a) =>
          (
            JSON.parse(
              readFileSync(require.resolve(`@queuebridge/assist/kb/${a}.json`), 'utf8'),
            ) as { articles: Article[] }
          ).articles,
      )
      .map((a) => [a.id, a] as const),
  ).values(),
];

/** Bold spans, without a trailing colon or full stop. */
function quotedLabels(body: string): string[] {
  return [...body.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) =>
    (m[1] ?? '').replace(/[:.]$/, '').trim(),
  );
}

describe('Group 13.5: every screen label an article quotes exists in the UI (L1)', () => {
  it('finds labels to check (sanity)', () => {
    expect(ARTICLES.length).toBeGreaterThan(40);
    expect(ARTICLES.flatMap((a) => quotedLabels(a.body)).length).toBeGreaterThan(100);
    expect(SCREEN_SOURCE).toContain('Call next');
  });

  it('no article quotes a label the screens no longer show', () => {
    const missing = ARTICLES.flatMap((a) =>
      quotedLabels(a.body)
        .filter((l) => l.length >= 3 && !SCREEN_SOURCE.includes(l))
        .map((l) => `${a.id}: "${l}"`),
    );
    expect(missing).toEqual([]);
  });

  it('detects a renamed control (self-check of the rule)', () => {
    const renamed = SCREEN_SOURCE.replaceAll('Issue walk-in ticket', 'Create walk-in ticket');
    const walkin = ARTICLES.find((a) => a.id === 'staff.walkin');
    expect(walkin).toBeDefined();
    expect(quotedLabels(walkin?.body ?? '').filter((l) => !renamed.includes(l))).toEqual([
      'Issue walk-in ticket',
    ]);
  });
});
