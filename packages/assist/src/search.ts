import type { KbArticle, RouteId } from '@queuebridge/contracts';

/**
 * Deterministic in-browser keyword search (design §11.4): a tokenized index over title, keywords
 * and headings with TF-IDF-style ranking. No network, no randomness, no clock: the same query,
 * articles and context always give the same order (ties broken by article id).
 */

/** Maximum query length considered (longer input is truncated, never rejected). */
export const MAX_QUERY_CHARS = 500;

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be but by can do does for from how i if in is it its me my no not of on ' +
    'or our so that the their then there this to was we what when where which who why will ' +
    'with you your'
  ).split(' '),
);

const FIELD_WEIGHT = { title: 3, keywords: 2, headings: 2 } as const;
/** Multiplier for an article linked to the current screen (screen-aware ranking). */
export const SCREEN_BOOST = 1.25;

function fold(token: string): string {
  // Light, deterministic plural folding: "tickets" → "ticket", but not "access" or "status"
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lowercase, strip diacritics and punctuation, drop stopwords and 1-character tokens. */
export function tokenize(text: string): string[] {
  return text
    .slice(0, MAX_QUERY_CHARS * 20)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(fold);
}

function headingsOf(body: string): string {
  return body
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, ''))
    .join(' ');
}

interface IndexedArticle {
  article: KbArticle;
  fields: Record<keyof typeof FIELD_WEIGHT, Map<string, number>>;
  terms: Set<string>;
}

export interface SearchIndex {
  readonly docs: readonly IndexedArticle[];
  readonly df: ReadonlyMap<string, number>;
}

function counts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function buildIndex(articles: readonly KbArticle[]): SearchIndex {
  const df = new Map<string, number>();
  const docs = articles.map((article) => {
    const fields = {
      title: counts(tokenize(article.title)),
      keywords: counts(article.keywords.flatMap((k) => tokenize(k))),
      headings: counts(tokenize(headingsOf(article.body))),
    };
    const terms = new Set<string>([
      ...fields.title.keys(),
      ...fields.keywords.keys(),
      ...fields.headings.keys(),
    ]);
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    return { article, fields, terms };
  });
  return { docs, df };
}

export interface SearchHit {
  article: KbArticle;
  score: number;
}

/**
 * Ranked matches for a query. Only articles that share at least one term score above zero;
 * articles related to `routeId` are boosted. Returns at most `limit` hits.
 */
export function search(
  index: SearchIndex,
  query: string,
  options: { routeId?: RouteId | null; limit?: number } = {},
): SearchHit[] {
  const q = [...new Set(tokenize(query.slice(0, MAX_QUERY_CHARS)))];
  if (q.length === 0) return [];
  const n = index.docs.length;
  const hits: SearchHit[] = [];
  for (const d of index.docs) {
    let score = 0;
    for (const t of q) {
      if (!d.terms.has(t)) continue;
      const idf = Math.log(1 + n / (index.df.get(t) ?? 1));
      for (const f of Object.keys(FIELD_WEIGHT) as (keyof typeof FIELD_WEIGHT)[]) {
        const tf = d.fields[f].get(t) ?? 0;
        if (tf > 0) score += FIELD_WEIGHT[f] * (1 + Math.log(tf)) * idf;
      }
    }
    if (score <= 0) continue;
    if (options.routeId && d.article.relatedRoutes.includes(options.routeId)) {
      score *= SCREEN_BOOST;
    }
    hits.push({ article: d.article, score });
  }
  hits.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.article.id < b.article.id ? -1 : 1,
  );
  return hits.slice(0, Math.max(0, options.limit ?? 5));
}
