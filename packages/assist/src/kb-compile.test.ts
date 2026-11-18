import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIENCES, KbBundleSchema } from '@queuebridge/contracts';
import {
  KbCompileError,
  compileKnowledgeBase,
  parseArticleSource,
  restrictedArticles,
  type KbLock,
  type KbSource,
} from './index.js';

const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function article(over: Record<string, string> = {}, body = '# Title\n\nPlain text.'): string {
  const meta: Record<string, string> = {
    id: 'visitor.test.one',
    title: 'Test article',
    audiences: '[visitor]',
    topics: '[recovery]',
    requiresCapabilities: '[]',
    relatedRoutes: '[visitor.recover]',
    availableSince: 'M5',
    version: '1',
    lastReviewed: '2026-11-17',
    keywords: '[test]',
    ...over,
  };
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== '__omit__')
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

const src = (path: string, text: string): KbSource => ({ path, text });
const update = { kbVersion: 1, lock: null, hash, mode: 'update' as const };

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof KbCompileError) return [...e.problems];
    throw e;
  }
  return [];
}

describe('front-matter parser', () => {
  it('reads scalars, integers and inline lists', () => {
    const { meta, body } = parseArticleSource(article());
    expect(meta['version']).toBe(1);
    expect(meta['audiences']).toEqual(['visitor']);
    expect(meta['requiresCapabilities']).toEqual([]);
    expect(meta['lastReviewed']).toBe('2026-11-17');
    expect(body).toBe('# Title\n\nPlain text.');
  });

  it.each([
    ['no front-matter', '# just a body'],
    ['a malformed line', '---\nid visitor.x\n---\nbody'],
    ['a duplicate key', '---\nid: a.b\nid: a.c\n---\nbody'],
    ['an unterminated list', '---\naudiences: [visitor\n---\nbody'],
  ])('rejects %s', (_l, text) => {
    expect(() => parseArticleSource(text)).toThrow();
  });
});

describe('compilation and validation', () => {
  it('compiles valid sources into one schema-valid bundle per audience', () => {
    const out = compileKnowledgeBase(
      [
        src('visitor/visitor.test.one.md', article()),
        src(
          'counter/staff.test.two.md',
          article({
            id: 'staff.test.two',
            audiences: '[counter, supervisor]',
            relatedRoutes: '[staff.console]',
          }),
        ),
      ],
      update,
    );
    expect(Object.keys(out.bundles).sort()).toEqual([...AUDIENCES].sort());
    for (const b of Object.values(out.bundles)) expect(KbBundleSchema.parse(b)).toEqual(b);
    expect(out.bundles.visitor.articles.map((a) => a.id)).toEqual(['visitor.test.one']);
    expect(out.bundles.counter.articles.map((a) => a.id)).toEqual(['staff.test.two']);
    expect(out.bundles.reception.articles).toEqual([]);
    expect(out.lock.articles['staff.test.two']?.version).toBe(1);
  });

  it.each([
    ['a path outside <audience>/<id>.md', 'visitor.test.one.md', article(), 'expected <audience>'],
    ['a file name that is not the id', 'visitor/other.id.md', article(), 'file name must equal'],
    [
      'a folder that is not an audience of the article',
      'counter/visitor.test.one.md',
      article(),
      'folder "counter"',
    ],
    [
      'an invalid audience',
      'visitor/visitor.test.one.md',
      article({ audiences: '[everyone]' }),
      'audiences',
    ],
    ['a missing field', 'visitor/visitor.test.one.md', article({ title: '__omit__' }), 'title'],
    ['an unknown field', 'visitor/visitor.test.one.md', article({ tenant: 'x' }), 'Unrecognized'],
    [
      'an unknown capability',
      'visitor/visitor.test.one.md',
      article({ requiresCapabilities: '[teleport]' }),
      'requiresCapabilities',
    ],
    [
      'an unsafe body (HTML)',
      'visitor/visitor.test.one.md',
      article({}, '<script>x</script>'),
      'raw HTML',
    ],
    [
      'an external link',
      'visitor/visitor.test.one.md',
      article({}, '[x](https://example.com)'),
      'URLs',
    ],
    [
      'a link to an unregistered route',
      'visitor/visitor.test.one.md',
      article({}, '[x](route:supervisor.home)'),
      'unknown RouteId',
    ],
  ])('rejects %s', (_l, path, text, expected) => {
    const p = problems(() => compileKnowledgeBase([src(path, text)], update));
    expect(p.join('\n')).toContain(expected);
  });

  it('rejects duplicate article ids', () => {
    const p = problems(() =>
      compileKnowledgeBase(
        [
          src('visitor/visitor.test.one.md', article()),
          src('reception/visitor.test.one.md', article({ audiences: '[reception, visitor]' })),
        ],
        update,
      ),
    );
    expect(p.join('\n')).toContain('duplicate article id visitor.test.one');
  });
});

describe('no tenant-sensitive or data-like content (design §11.5.1)', () => {
  it.each([
    ['an email address', 'Write to help@clinic.example.org'],
    ['a phone number', 'Call +234 803 123 4567'],
    ['a UUID', 'Facility 0193a000-0000-7000-8000-00000000000a'],
    ['a ticket code', 'Your code is AB123'],
    ['a template placeholder', 'Welcome to {{facility}}'],
    ['a template placeholder', 'Welcome to ${org}'],
    ['a recovery key or token-like secret', 'Key ABCDEFGHJKMNPQRSTVWXYZ234567ABCD'],
  ])('rejects %s', (label, body) => {
    const p = problems(() =>
      compileKnowledgeBase([src('visitor/visitor.test.one.md', article({}, body))], update),
    );
    expect(p.join('\n')).toContain(`contains ${label}`);
  });

  it('accepts ordinary procedural text with numbers', () => {
    const body = 'Wait up to 15 minutes. The grace window is 5 minutes by default (300 seconds).';
    expect(() =>
      compileKnowledgeBase([src('visitor/visitor.test.one.md', article({}, body))], update),
    ).not.toThrow();
  });
});

describe('D4: staff-only phrases never reach public articles', () => {
  const staff = (phrases: string): KbSource =>
    src(
      'reception/staff.test.verify.md',
      article(
        {
          id: 'staff.test.verify',
          audiences: '[reception, counter]',
          relatedRoutes: '[staff.console]',
          privatePhrases: phrases,
        },
        '# Verify\n\nThey name the correct service.',
      ),
    );

  it('fails when a public article contains a staff-only phrase (case-insensitive)', () => {
    const leak = src(
      'visitor/visitor.test.one.md',
      article({}, 'Staff check that you name the Correct Service.'),
    );
    const p = problems(() => compileKnowledgeBase([staff('[correct service]'), leak], update));
    expect(p.join('\n')).toContain(
      'public article contains staff-only content from staff.test.verify',
    );
  });

  it('strips privatePhrases from the compiled output', () => {
    const out = compileKnowledgeBase(
      [staff('[correct service]'), src('visitor/visitor.test.one.md', article())],
      update,
    );
    expect(JSON.stringify(out.bundles)).not.toContain('privatePhrases');
    expect(JSON.stringify(out.bundles.visitor)).not.toContain('correct service');
  });

  it('refuses privatePhrases on a public article', () => {
    const p = problems(() =>
      compileKnowledgeBase(
        [src('visitor/visitor.test.one.md', article({ privatePhrases: '[secret]' }))],
        update,
      ),
    );
    expect(p.join('\n')).toContain('cannot declare privatePhrases');
  });
});

describe('version discipline against kb.lock.json', () => {
  const base = [src('visitor/visitor.test.one.md', article())];
  const lock: KbLock = compileKnowledgeBase(base, update).lock;
  const changed = [src('visitor/visitor.test.one.md', article({}, '# Title\n\nNew text.'))];

  it('check mode accepts an up-to-date lock', () => {
    expect(() => compileKnowledgeBase(base, { ...update, lock, mode: 'check' })).not.toThrow();
  });

  it('refuses a content change without an article version bump', () => {
    const p = problems(() => compileKnowledgeBase(changed, { ...update, kbVersion: 2, lock }));
    expect(p.join('\n')).toContain('content changed without a version bump');
  });

  it('refuses an article change without a kbVersion bump', () => {
    const bumped = [
      src('visitor/visitor.test.one.md', article({ version: '2' }, '# Title\n\nNew text.')),
    ];
    const p = problems(() => compileKnowledgeBase(bumped, { ...update, kbVersion: 1, lock }));
    expect(p.join('\n')).toContain('bump kbVersion');
    expect(() => compileKnowledgeBase(bumped, { ...update, kbVersion: 2, lock })).not.toThrow();
  });

  it('refuses versions that go backwards and an added article without a kbVersion bump', () => {
    const lock2 = compileKnowledgeBase(
      [src('visitor/visitor.test.one.md', article({ version: '3' }))],
      { ...update, kbVersion: 4 },
    ).lock;
    const p = problems(() => compileKnowledgeBase(base, { ...update, kbVersion: 3, lock: lock2 }));
    expect(p.join('\n')).toContain('kbVersion went backwards');
    expect(p.join('\n')).toContain('version went backwards');
    const added = [
      ...base,
      src('visitor/visitor.test.two.md', article({ id: 'visitor.test.two' })),
    ];
    expect(problems(() => compileKnowledgeBase(added, { ...update, lock })).join('\n')).toContain(
      'bump kbVersion',
    );
  });

  it('check mode refuses a stale or missing lock', () => {
    const bumped = [
      src('visitor/visitor.test.one.md', article({ version: '2' }, '# Title\n\nNew text.')),
    ];
    expect(
      problems(() =>
        compileKnowledgeBase(bumped, { ...update, kbVersion: 2, lock, mode: 'check' }),
      ).join('\n'),
    ).toContain('kb.lock.json is stale');
    expect(
      problems(() => compileKnowledgeBase(base, { ...update, lock: null, mode: 'check' })).join(
        '\n',
      ),
    ).toContain('kb.lock.json is missing');
  });

  it('a version-only bump is allowed (hash excludes version)', () => {
    const v2 = [src('visitor/visitor.test.one.md', article({ version: '2' }))];
    const out = compileKnowledgeBase(v2, { ...update, kbVersion: 2, lock });
    expect(out.lock.articles['visitor.test.one']?.hash).toBe(
      lock.articles['visitor.test.one']?.hash,
    );
  });
});

describe('restricted article selection', () => {
  it('excludes public articles, de-duplicates and sorts by id', () => {
    const out = compileKnowledgeBase(
      [
        src('visitor/visitor.test.one.md', article({ audiences: '[visitor, counter]' })),
        src(
          'counter/staff.b.two.md',
          article({ id: 'staff.b.two', audiences: '[counter, supervisor]', relatedRoutes: '[]' }),
        ),
        src(
          'auditor/staff.a.one.md',
          article({ id: 'staff.a.one', audiences: '[auditor]', relatedRoutes: '[]' }),
        ),
      ],
      update,
    );
    expect(restrictedArticles(out.bundles, ['counter', 'supervisor']).map((a) => a.id)).toEqual([
      'staff.b.two',
    ]);
    expect(restrictedArticles(out.bundles, ['counter', 'auditor']).map((a) => a.id)).toEqual([
      'staff.a.one',
      'staff.b.two',
    ]);
    expect(restrictedArticles(out.bundles, ['visitor'])).toEqual([]);
    expect(restrictedArticles(out.bundles, [])).toEqual([]);
  });
});

describe('the committed knowledge base', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) =>
      statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
    );
  const sources = walk(root)
    .filter((p) => p.endsWith('.md') && !p.endsWith('README.md'))
    .map((p) => src(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8')));
  const kbVersion = (
    JSON.parse(readFileSync(join(root, 'kb.json'), 'utf8')) as { kbVersion: number }
  ).kbVersion;
  const lock = JSON.parse(readFileSync(join(root, 'kb.lock.json'), 'utf8')) as KbLock;

  it('compiles in check mode against the committed lock', () => {
    const out = compileKnowledgeBase(sources, { kbVersion, lock, hash, mode: 'check' });
    expect(out.kbVersion).toBe(kbVersion);
    // Public bundle: visitor articles only; never the staff verification procedure (D4)
    for (const a of out.bundles.visitor.articles) expect(a.audiences).toContain('visitor');
    expect(out.bundles.visitor.articles.map((a) => a.id)).not.toContain('staff.recovery.assist');
    expect(JSON.stringify(out.bundles.visitor).toLowerCase()).not.toContain('correct service');
    // The verification procedure is for the roles that assist (WALK_IN), never auditors
    const assist = out.bundles.reception.articles.find((a) => a.id === 'staff.recovery.assist');
    expect(assist?.audiences).toEqual(['reception', 'counter', 'supervisor', 'facility_admin']);
    expect(out.bundles.auditor.articles.map((a) => a.id)).not.toContain('staff.recovery.assist');
  });
});
