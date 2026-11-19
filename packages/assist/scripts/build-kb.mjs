/* global process, console -- Node build script (not covered by the TypeScript config) */
// Compile packages/assist/knowledge into dist/kb/<audience>.json (MQ.2; design §11.2, §11.5).
// Usage: node scripts/build-kb.mjs            -> check the lock and emit bundles (build / CI)
//        node scripts/build-kb.mjs --update   -> verify version discipline and rewrite the lock
//        node scripts/build-kb.mjs --base-lock <file>
//                                              -> also verify version discipline against the
//                                                 base branch's lock (CI, MQ.6 rule V2)
// Every build also checks the capability coverage contract (knowledge/capabilities.json) and the
// route rules that need no server (MQ.6, Group 13.5: C0–C3, R1–R3).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KbCompileError,
  compileKnowledgeBase,
  kbConsistencyProblems,
  parseCapabilityContract,
} from '../dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const kbDir = join(root, 'knowledge');
const outDir = join(root, 'dist', 'kb');
const update = process.argv.includes('--update');
const baseIdx = process.argv.indexOf('--base-lock');
const baseLockPath = baseIdx > 0 ? process.argv[baseIdx + 1] : null;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = walk(kbDir)
  .filter((p) => p.endsWith('.md') && relative(kbDir, p) !== 'README.md')
  .map((p) => ({ path: relative(kbDir, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));
const { kbVersion } = JSON.parse(readFileSync(join(kbDir, 'kb.json'), 'utf8'));
const lockPath = join(kbDir, 'kb.lock.json');
let lock = null;
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch {
  lock = null;
}

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
let compiled;
try {
  compiled = compileKnowledgeBase(sources, {
    kbVersion,
    lock,
    mode: update ? 'update' : 'check',
    hash,
  });
  if (baseLockPath) {
    // V2: against the base branch, every content change needs an article version bump, no
    // version goes backwards, and any change to the set bumps kbVersion. A lock regenerated
    // from scratch cannot hide a missing bump here.
    const base = JSON.parse(readFileSync(baseLockPath, 'utf8'));
    compileKnowledgeBase(sources, { kbVersion, lock: base, mode: 'update', hash });
    console.log(
      `version discipline verified against ${baseLockPath} (kbVersion ${base.kbVersion})`,
    );
  }
} catch (e) {
  if (e instanceof KbCompileError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

// Capability coverage contract and route rules (no server needed here; C4–C5, A1–A3 run in the
// API tests against the manifest the server builds)
const contractPath = join(kbDir, 'capabilities.json');
const parsed = parseCapabilityContract(JSON.parse(readFileSync(contractPath, 'utf8')));
const allArticles = [
  ...new Map(
    Object.values(compiled.bundles)
      .flatMap((b) => b.articles)
      .map((a) => [a.id, a]),
  ).values(),
];
const consistency = parsed.contract
  ? [
      ...parsed.problems,
      ...kbConsistencyProblems({ articles: allArticles, contract: parsed.contract }),
    ]
  : parsed.problems;
if (consistency.length > 0) {
  console.error(`knowledge base is inconsistent (Group 13.5):\n- ${consistency.join('\n- ')}`);
  process.exit(1);
}

if (update) {
  writeFileSync(lockPath, `${JSON.stringify(compiled.lock, null, 2)}\n`);
  console.log(`kb.lock.json updated (kbVersion ${compiled.kbVersion})`);
}
mkdirSync(outDir, { recursive: true });
const index = { kbVersion: compiled.kbVersion, bundles: {} };
for (const [audience, bundle] of Object.entries(compiled.bundles)) {
  writeFileSync(join(outDir, `${audience}.json`), JSON.stringify(bundle));
  index.bundles[audience] = bundle.articles.length;
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
writeFileSync(join(outDir, 'capabilities.json'), JSON.stringify(parsed.contract));
console.log(`knowledge base v${compiled.kbVersion}: ${sources.length} articles compiled`);
