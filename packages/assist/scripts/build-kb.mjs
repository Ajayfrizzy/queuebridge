/* global process, console -- Node build script (not covered by the TypeScript config) */
// Compile packages/assist/knowledge into dist/kb/<audience>.json (MQ.2; design §11.2, §11.5).
// Usage: node scripts/build-kb.mjs            -> check the lock and emit bundles (build / CI)
//        node scripts/build-kb.mjs --update   -> verify version discipline and rewrite the lock
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KbCompileError, compileKnowledgeBase } from '../dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const kbDir = join(root, 'knowledge');
const outDir = join(root, 'dist', 'kb');
const update = process.argv.includes('--update');

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

let compiled;
try {
  compiled = compileKnowledgeBase(sources, {
    kbVersion,
    lock,
    mode: update ? 'update' : 'check',
    hash: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
  });
} catch (e) {
  if (e instanceof KbCompileError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
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
console.log(`knowledge base v${compiled.kbVersion}: ${sources.length} articles compiled`);
