/* global process, console, URL -- Node build script (not covered by the TypeScript config) */
// M7.2 (design §14.6; REQ-F15.5): measure the built bundles and enforce thresholds derived from
// the recorded baseline (bundle-baseline.json). Run after `vite build`:
//   pnpm --filter @queuebridge/web bundle:check
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;
const base = JSON.parse(readFileSync(`${root}bundle-baseline.json`, 'utf8'));
// `gzip -9` (the same tool the baseline was measured with; present on macOS and Linux CI)
const gz = (f) => execFileSync('gzip', ['-9', '-c', `${dist}/${f}`], { maxBuffer: 1 << 26 }).length;
const html = readFileSync(`${dist}/index.html`, 'utf8');
const entryJs = /<script type="module"[^>]*src="\/([^"]+\.js)"/.exec(html)?.[1];
const entryCss = /<link rel="stylesheet"[^>]*href="\/([^"]+\.css)"/.exec(html)?.[1];
const assets = readdirSync(`${dist}/assets`);
const landingJs = assets.find((f) => /^LandingPage-.*\.js$/.test(f));
const landingCss = assets.find((f) => /^LandingPage-.*\.css$/.test(f));
const problems = [];
if (!entryJs || !entryCss) problems.push('entry script or stylesheet not found in index.html');
if (!landingJs)
  problems.push('no separate LandingPage chunk: the landing page must be lazy-loaded');
const m = {
  entryJs: entryJs ? gz(entryJs) : 0,
  entryCss: entryCss ? gz(entryCss) : 0,
  landingJs: landingJs ? gz(`assets/${landingJs}`) : 0,
  landingCss: landingCss ? gz(`assets/${landingCss}`) : 0,
};
const entrySrc = entryJs ? readFileSync(`${dist}/${entryJs}`, 'utf8') : '';
// Landing-only code must not be in the entry every route downloads
for (const marker of ['Queues that keep moving when the connection doesn', 'i18next']) {
  if (entrySrc.includes(marker)) problems.push(`entry contains landing-only code ("${marker}")`);
}
if (html.includes('LandingPage-')) problems.push('index.html preloads the landing chunk');
const limit = (v, t) => Math.floor(v * (1 + t));
const checks = [
  ['entry JS', m.entryJs, limit(base.before.entryJs, base.entryTolerance)],
  ['entry CSS', m.entryCss, limit(base.before.entryCss, base.entryTolerance)],
  ['landing JS', m.landingJs, limit(base.landing.js, base.landingTolerance)],
  ['landing CSS', m.landingCss, limit(base.landing.css, base.landingTolerance)],
];
for (const [name, v, max] of checks) {
  console.log(`${name.padEnd(12)} ${String(v).padStart(8)} B gzip  (limit ${max})`);
  if (v > max) problems.push(`${name} ${v} B exceeds ${max} B`);
}
if (problems.length > 0) {
  console.error(`bundle-check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('bundle-check: PASS');
