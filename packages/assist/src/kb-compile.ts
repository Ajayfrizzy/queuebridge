import {
  AUDIENCES,
  KbArticleSchema,
  type Audience,
  type KbArticle,
  type KbBundleFile,
} from '@queuebridge/contracts';

/**
 * Knowledge-base compiler (MQ.2; design §11.2, §11.5.1, decision D4). Pure: the build script
 * (`scripts/build-kb.mjs`) reads the Markdown sources and the lock file, passes a hash function
 * in, and writes the result. Nothing here touches the file system.
 *
 * Sources live in `knowledge/<audience>/<article-id>.md`: front-matter between `---` lines, then
 * the Safe Markdown body. Every article must pass `KbArticleSchema` and the content checks below,
 * and every content change must bump the article `version` (enforced against `kb.lock.json`).
 */

export interface KbSource {
  /** Path relative to `knowledge/`, e.g. `visitor/visitor.recovery.how.md`. */
  path: string;
  text: string;
}

/** Last compiled state, committed as `knowledge/kb.lock.json`. */
export interface KbLock {
  kbVersion: number;
  articles: Record<string, { version: number; hash: string }>;
}

export interface CompiledKnowledgeBase {
  kbVersion: number;
  bundles: Record<Audience, KbBundleFile>;
  lock: KbLock;
}

export class KbCompileError extends Error {
  public readonly problems: readonly string[];
  public constructor(problems: readonly string[]) {
    super(`knowledge base did not compile:\n- ${problems.join('\n- ')}`);
    this.name = 'KbCompileError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Front-matter (strict subset: `key: value`, inline lists `[a, b]`, integers, quoted strings)
// ---------------------------------------------------------------------------

function parseScalar(raw: string): string | number {
  const v = raw.trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  const q = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return q ? (q[1] ?? '') : v;
}

function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error('unterminated list');
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseScalar(x));
  }
  return parseScalar(v);
}

export function parseArticleSource(text: string): { meta: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!m) throw new Error('missing front-matter (--- ... ---)');
  const meta: Record<string, unknown> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`invalid front-matter line: ${line}`);
    const key = kv[1] ?? '';
    if (Object.prototype.hasOwnProperty.call(meta, key)) throw new Error(`duplicate key: ${key}`);
    meta[key] = parseValue(kv[2] ?? '');
  }
  return { meta, body: (m[2] ?? '').trim() };
}

// ---------------------------------------------------------------------------
// Content checks (design §11.5.1): no tenant-sensitive or data-like content
// ---------------------------------------------------------------------------

const DATA_PATTERNS: readonly [string, RegExp][] = [
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['a phone number', /\+?\d[\d\s().-]{7,}\d/],
  ['a UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a ticket code', /\b[A-Z]{1,3}[0-9]{3,4}\b/],
  ['a template placeholder', /\{\{|\}\}|\$\{|<%|%>/],
  ['a recovery key or token-like secret', /\b[A-Z2-7]{16,}\b|\b[A-Za-z0-9_-]{32,}\b/],
];

function textOf(a: KbArticle): string {
  return [a.title, ...a.keywords, a.body].join('\n');
}

/** Front-matter keys that are build-time only and never shipped. */
const BUILD_ONLY_KEYS = ['privatePhrases'] as const;

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content hash of an article, excluding `version` (so a version-only bump is allowed). */
export function articleContentHash(a: KbArticle, hash: (s: string) => string): string {
  const { version: _version, ...rest } = a;
  return hash(canonical(rest));
}

export interface CompileOptions {
  kbVersion: number;
  /** Committed lock, or null for the very first compilation. */
  lock: KbLock | null;
  /** SHA-256 (hex) provided by the caller. */
  hash: (s: string) => string;
  /** `check`: the lock must already describe this content exactly (CI); `update`: produce a new one. */
  mode: 'check' | 'update';
}

export function compileKnowledgeBase(
  sources: readonly KbSource[],
  opts: CompileOptions,
): CompiledKnowledgeBase {
  const problems: string[] = [];
  const articles: KbArticle[] = [];
  const privateByArticle = new Map<string, string[]>();

  if (!Number.isInteger(opts.kbVersion) || opts.kbVersion < 1) {
    problems.push('kbVersion must be a positive integer');
  }

  for (const src of [...sources].sort((x, y) => (x.path < y.path ? -1 : 1))) {
    const pm = /^([a-z_]+)\/([a-z0-9_.]+)\.md$/.exec(src.path);
    if (!pm) {
      problems.push(`${src.path}: expected <audience>/<article-id>.md`);
      continue;
    }
    const folder = pm[1] as Audience;
    const fileId = pm[2] ?? '';
    let parsed: { meta: Record<string, unknown>; body: string };
    try {
      parsed = parseArticleSource(src.text);
    } catch (e) {
      problems.push(`${src.path}: ${(e as Error).message}`);
      continue;
    }
    const meta = { ...parsed.meta };
    const privatePhrases = meta['privatePhrases'];
    for (const k of BUILD_ONLY_KEYS) delete meta[k];
    const result = KbArticleSchema.safeParse({ ...meta, body: parsed.body });
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`${src.path}: ${issue.path.join('.') || '(article)'}: ${issue.message}`);
      }
      continue;
    }
    const a = result.data;
    if (a.id !== fileId)
      problems.push(`${src.path}: file name must equal the article id (${a.id})`);
    if (!(AUDIENCES as readonly string[]).includes(folder) || !a.audiences.includes(folder)) {
      problems.push(`${src.path}: folder "${folder}" must be one of the article's audiences`);
    }
    if (new Set(a.audiences).size !== a.audiences.length) {
      problems.push(`${src.path}: duplicate audience`);
    }
    for (const [label, re] of DATA_PATTERNS) {
      if (re.test(textOf(a))) problems.push(`${src.path}: contains ${label}`);
    }
    if (privatePhrases !== undefined) {
      if (!Array.isArray(privatePhrases) || privatePhrases.some((p) => typeof p !== 'string')) {
        problems.push(`${src.path}: privatePhrases must be a list of strings`);
      } else if (a.audiences.includes('visitor')) {
        problems.push(`${src.path}: a public (visitor) article cannot declare privatePhrases`);
      } else {
        privateByArticle.set(
          a.id,
          (privatePhrases as string[]).map((p) => p.toLowerCase()),
        );
      }
    }
    articles.push(a);
  }

  const ids = articles.map((a) => a.id);
  for (const id of new Set(ids)) {
    if (ids.filter((x) => x === id).length > 1) problems.push(`duplicate article id ${id}`);
  }

  // D4: public articles never contain staff-only verification content
  for (const a of articles.filter((x) => x.audiences.includes('visitor'))) {
    const t = textOf(a).toLowerCase();
    for (const [owner, phrases] of privateByArticle) {
      for (const p of phrases) {
        if (p.length > 0 && t.includes(p)) {
          problems.push(`${a.id}: public article contains staff-only content from ${owner}`);
        }
      }
    }
  }

  // Version discipline against the committed lock
  const lockArticles: KbLock['articles'] = {};
  for (const a of articles) {
    lockArticles[a.id] = { version: a.version, hash: articleContentHash(a, opts.hash) };
  }
  const next: KbLock = { kbVersion: opts.kbVersion, articles: lockArticles };
  const prev = opts.lock;
  if (prev) {
    if (opts.kbVersion < prev.kbVersion) problems.push('kbVersion went backwards');
    let changed = Object.keys(prev.articles).length !== Object.keys(lockArticles).length;
    for (const [id, cur] of Object.entries(lockArticles)) {
      const old = prev.articles[id];
      if (!old) {
        changed = true;
        continue;
      }
      if (cur.version < old.version) problems.push(`${id}: version went backwards`);
      if (cur.hash !== old.hash && cur.version <= old.version) {
        problems.push(`${id}: content changed without a version bump`);
      }
      if (cur.version !== old.version) changed = true;
    }
    if (changed && opts.kbVersion <= prev.kbVersion) {
      problems.push('articles changed: bump kbVersion in knowledge/kb.json');
    }
    if (opts.mode === 'check' && canonical(prev) !== canonical(next)) {
      problems.push(
        'knowledge/kb.lock.json is stale: run `pnpm --filter @queuebridge/assist kb:lock`',
      );
    }
  } else if (opts.mode === 'check') {
    problems.push(
      'knowledge/kb.lock.json is missing: run `pnpm --filter @queuebridge/assist kb:lock`',
    );
  }

  if (problems.length > 0) throw new KbCompileError(problems);

  const sorted = [...articles].sort((x, y) => (x.id < y.id ? -1 : 1));
  const bundles = {} as Record<Audience, KbBundleFile>;
  for (const audience of AUDIENCES) {
    bundles[audience] = {
      kbVersion: opts.kbVersion,
      audience,
      articles: sorted.filter((a) => a.audiences.includes(audience)),
    };
  }
  return { kbVersion: opts.kbVersion, bundles, lock: next };
}

/**
 * Restricted articles for a set of audiences (design §11.5): every article for at least one of
 * the audiences, excluding public (visitor) articles, which ship in the public bundle. Sorted
 * and de-duplicated by id.
 */
export function restrictedArticles(
  bundles: Readonly<Record<Audience, KbBundleFile>>,
  audiences: readonly Audience[],
): KbArticle[] {
  const byId = new Map<string, KbArticle>();
  for (const aud of audiences) {
    if (aud === 'visitor') continue;
    for (const a of bundles[aud]?.articles ?? []) {
      if (!a.audiences.includes('visitor')) byId.set(a.id, a);
    }
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
}
