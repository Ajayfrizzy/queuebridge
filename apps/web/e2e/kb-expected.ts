import { readFileSync } from 'node:fs';

/**
 * Expected Ask Que article sets, read from the compiled knowledge base the API serves
 * (`packages/assist/dist/kb`). Tests that assert "exactly these articles" derive the set from
 * each article's own audience metadata, so they stay exact as the MQ.5 inventory grows.
 */

interface CompiledArticle {
  id: string;
  title: string;
  audiences: string[];
}

const KB_DIR = new URL('../../../packages/assist/dist/kb/', import.meta.url);

function bundle(audience: string): CompiledArticle[] {
  const raw = readFileSync(new URL(`${audience}.json`, KB_DIR), 'utf8');
  return (JSON.parse(raw) as { articles: CompiledArticle[] }).articles;
}

const AUDIENCES = ['visitor', 'reception', 'counter', 'supervisor', 'facility_admin', 'auditor'];
const ALL: CompiledArticle[] = [
  ...new Map(AUDIENCES.flatMap((a) => bundle(a)).map((x) => [x.id, x] as const)).values(),
];

/** Restricted (non-public) article ids for the given audiences, sorted. */
export function expectedRestricted(audiences: readonly string[]): string[] {
  return ALL.filter(
    (a) => !a.audiences.includes('visitor') && a.audiences.some((x) => audiences.includes(x)),
  )
    .map((a) => a.id)
    .sort();
}

/** Titles of public (visitor) articles. */
export const PUBLIC_TITLES: readonly string[] = ALL.filter((a) =>
  a.audiences.includes('visitor'),
).map((a) => a.title);

/** Titles of restricted (staff-only) articles. */
export const RESTRICTED_TITLES: readonly string[] = ALL.filter(
  (a) => !a.audiences.includes('visitor'),
).map((a) => a.title);
