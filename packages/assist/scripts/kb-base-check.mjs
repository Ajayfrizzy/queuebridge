/* global process, console -- Node build script (not covered by the TypeScript config) */
// MQ.6 rule V2: knowledge-base version discipline against the base branch (CI).
//
// Usage: node packages/assist/scripts/kb-base-check.mjs <base-ref>
//   <base-ref>  a ref or commit that must resolve, for example `origin/staging`
//
// Compares the working tree's articles with the lock at the MERGE BASE of HEAD and <base-ref>:
// - pull_request runs check out the merge commit, whose merge base with the base tip is the tip;
// - push runs check out the branch head, whose merge base is where it left the base branch, so
//   articles changed on the base branch since then are not mistaken for changes here.
// Fails (exit 1) when the ref does not resolve, there is no merge base (shallow or unrelated
// history), the base lock is unreadable or malformed, or the articles break version discipline.
// A base that has no knowledge base yet (for example `main` before the first release) is
// reported explicitly and has nothing to compare; the normal lock check still runs in the build.
// Git is called without a shell, so the ref is never interpolated into a command line.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = 'packages/assist/knowledge/kb.lock.json';
const here = dirname(fileURLToPath(import.meta.url));
const fail = (msg) => {
  console.error(`kb-base-check: FAIL — ${msg}`);
  process.exit(1);
};
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const ref = process.argv[2];
if (!ref || ref.startsWith('-')) fail('usage: kb-base-check.mjs <base-ref>');

let base;
try {
  base = git('rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`);
} catch {
  fail(`base ref "${ref}" does not resolve to a commit (not fetched, or misspelt)`);
}
let mergeBase;
try {
  mergeBase = git('merge-base', 'HEAD', base);
} catch {
  fail(`no merge base between HEAD and ${ref} (shallow clone or unrelated history)`);
}

let text;
try {
  git('cat-file', '-e', `${mergeBase}:${LOCK}`);
  text = git('show', `${mergeBase}:${LOCK}`);
} catch {
  console.log(
    `kb-base-check: ${ref} has no knowledge-base lock at the merge base ${mergeBase.slice(0, 7)}: ` +
      'nothing to compare (the knowledge base is introduced by this change)',
  );
  process.exit(0);
}
let lock;
try {
  lock = JSON.parse(text);
} catch {
  fail(`the base lock at ${mergeBase.slice(0, 7)} is not valid JSON`);
}
const versionsOk =
  lock &&
  Number.isInteger(lock.kbVersion) &&
  lock.kbVersion >= 1 &&
  typeof lock.articles === 'object' &&
  lock.articles !== null &&
  Object.values(lock.articles).every(
    (a) => a && Number.isInteger(a.version) && typeof a.hash === 'string',
  );
if (!versionsOk) fail(`the base lock at ${mergeBase.slice(0, 7)} is malformed`);

const dir = mkdtempSync(join(tmpdir(), 'kb-base-'));
const file = join(dir, 'kb.lock.json');
writeFileSync(file, text);
try {
  console.log(`kb-base-check: comparing with ${ref} at merge base ${mergeBase.slice(0, 7)}`);
  execFileSync(process.execPath, [join(here, 'build-kb.mjs'), '--base-lock', file], {
    stdio: 'inherit',
  });
} catch {
  fail('version discipline against the base branch (see the problems above)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
