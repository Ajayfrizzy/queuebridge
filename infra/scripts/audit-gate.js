// Scoped dependency-audit gate (MQ.2 security exception; docs/testing/MQ-evidence.md).
//
// Runs the FULL `pnpm audit --json` and fails on every high or critical advisory, except the
// findings that match an approved, unexpired exception in infra/security/audit-policy.json
// EXACTLY: same advisory, module, severity, ranges, versions and dependency paths, every path
// rooted in a devDependency of its importer, the module absent from every production tree, and
// no newer upstream release. Anything unexpected, malformed or unavailable fails closed.
//
// The production gate (`pnpm audit --prod --audit-level high`) stays a separate CI step with no
// exception. This script never edits pnpm configuration and never mutes anything.
//
// Usage: node infra/scripts/audit-gate.js            (CI and local)
// Exit:  0 = no unapproved high/critical finding; 1 = blocked (reasons printed).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const POLICY_PATH = join(ROOT, 'infra', 'security', 'audit-policy.json');

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const BLOCKING = new Set(['high', 'critical']);
const DAY_MS = 24 * 60 * 60 * 1000;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Validate the policy file; returns a list of problems (empty when valid). */
export function validatePolicy(policy) {
  const problems = [];
  if (!isObj(policy) || policy.policyVersion !== 1)
    return ['policy: unknown or missing policyVersion'];
  if (
    !Number.isInteger(policy.maxValidityDays) ||
    policy.maxValidityDays < 1 ||
    policy.maxValidityDays > 90
  ) {
    problems.push('policy: maxValidityDays must be an integer between 1 and 90');
  }
  if (!Array.isArray(policy.exceptions)) return [...problems, 'policy: exceptions must be a list'];
  const seen = new Set();
  for (const [i, e] of policy.exceptions.entries()) {
    const at = `policy.exceptions[${i}]`;
    if (!isObj(e)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    for (const k of [
      'advisory',
      'module',
      'severity',
      'vulnerableVersions',
      'patchedVersions',
      'approvedBy',
      'approvedOn',
      'expiresAt',
      'reason',
      'remediation',
    ]) {
      if (!isStr(e[k])) problems.push(`${at}: ${k} is required`);
    }
    if (isStr(e.advisory) && !/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(e.advisory)) {
      problems.push(`${at}: advisory must be a GHSA id`);
    }
    if (seen.has(e.advisory)) problems.push(`${at}: duplicate advisory ${e.advisory}`);
    seen.add(e.advisory);
    if (!BLOCKING.has(e.severity))
      problems.push(`${at}: only high or critical findings need an exception`);
    const approved = Date.parse(`${e.approvedOn}T00:00:00Z`);
    const expires = Date.parse(e.expiresAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.approvedOn)) || !Number.isFinite(approved)) {
      problems.push(`${at}: approvedOn must be a YYYY-MM-DD date`);
    }
    if (!/Z$/.test(String(e.expiresAt)) || !Number.isFinite(expires)) {
      problems.push(`${at}: expiresAt must be an ISO UTC timestamp`);
    }
    if (Number.isFinite(approved) && Number.isFinite(expires)) {
      if (expires <= approved) problems.push(`${at}: expiresAt must be after approvedOn`);
      if (expires - approved > policy.maxValidityDays * DAY_MS) {
        problems.push(
          `${at}: validity exceeds ${policy.maxValidityDays} days; renew through review`,
        );
      }
    }
    if (
      !Array.isArray(e.devOnlyTopLevel) ||
      e.devOnlyTopLevel.length === 0 ||
      !e.devOnlyTopLevel.every(isStr)
    ) {
      problems.push(`${at}: devOnlyTopLevel must list the approved development packages`);
    }
    if (!Array.isArray(e.findings) || e.findings.length === 0) {
      problems.push(`${at}: findings must list the approved versions and paths`);
    } else {
      for (const f of e.findings) {
        if (
          !isObj(f) ||
          !isStr(f.version) ||
          !Array.isArray(f.paths) ||
          f.paths.length === 0 ||
          !f.paths.every(isStr)
        ) {
          problems.push(`${at}: every finding needs a version and its exact paths`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

function parseJson(label, result, okStatuses) {
  if (!result || result.error)
    return { problem: `${label}: command could not run (${result?.error?.code ?? 'unknown'})` };
  if (result.signal) return { problem: `${label}: command was killed (${result.signal})` };
  if (!okStatuses.includes(result.status))
    return { problem: `${label}: unexpected exit status ${result.status}` };
  if (typeof result.stdout !== 'string' || result.stdout.trim() === '')
    return { problem: `${label}: empty output` };
  try {
    return { value: JSON.parse(result.stdout) };
  } catch {
    return { problem: `${label}: output is not JSON` };
  }
}

/** Structural check of `pnpm audit --json`; returns problems. */
export function validateAuditShape(audit) {
  if (!isObj(audit)) return ['audit: output is not an object'];
  if ('error' in audit)
    return [`audit: pnpm reported an error (${String(audit.error?.code ?? 'unknown')})`];
  const problems = [];
  if (!isObj(audit.advisories)) problems.push('audit: advisories missing');
  if (!isObj(audit.metadata) || !isObj(audit.metadata.vulnerabilities))
    problems.push('audit: metadata.vulnerabilities missing');
  if (!Array.isArray(audit.muted)) problems.push('audit: muted list missing');
  else if (audit.muted.length > 0)
    problems.push('audit: pnpm muted findings; muting is not allowed (use the scoped policy)');
  if (problems.length > 0) return problems;
  const counted = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const [key, a] of Object.entries(audit.advisories)) {
    if (
      !isObj(a) ||
      !isStr(a.module_name) ||
      !SEVERITIES.includes(a.severity) ||
      !Array.isArray(a.findings)
    ) {
      problems.push(`audit: advisory ${key} is malformed or has an unknown severity`);
      continue;
    }
    for (const f of a.findings) {
      if (!isObj(f) || !isStr(f.version) || !Array.isArray(f.paths) || f.paths.length === 0) {
        problems.push(`audit: advisory ${key} has a malformed finding`);
      }
    }
    counted[a.severity] += a.findings.length;
  }
  for (const s of SEVERITIES) {
    if (audit.metadata.vulnerabilities[s] !== counted[s]) {
      problems.push(
        `audit: metadata reports ${audit.metadata.vulnerabilities[s]} ${s} but ${counted[s]} findings are listed (incomplete output)`,
      );
    }
  }
  return problems;
}

/** Names of every package that appears anywhere in a `pnpm -r ls --prod --json` tree. */
function prodTreeContains(projects, moduleName) {
  const stack = [...projects];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const key of [
      'dependencies',
      'optionalDependencies',
      'unsavedDependencies',
      'devDependencies',
    ]) {
      const deps = node[key];
      if (!isObj(deps)) continue;
      for (const [name, child] of Object.entries(deps)) {
        if (name === moduleName) return true;
        if (isObj(child)) stack.push(child);
      }
    }
  }
  return false;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the gate.
 * @param {object} deps
 * @param {(args: string[]) => {status: number|null, signal?: string|null, stdout?: string, error?: Error}} deps.run
 *        runs `pnpm <args>` (injected so tests never touch the network)
 * @param {unknown} deps.policy        parsed audit-policy.json
 * @param {number}  deps.now           current time (ms since epoch)
 * @param {(importer: string) => unknown} deps.readManifest  parsed package.json of an importer
 * @returns {{ ok: boolean, accepted: string[], blocked: string[] }}
 */
export function evaluate({ run, policy, now, readManifest }) {
  const blocked = [];
  const accepted = [];

  const policyProblems = validatePolicy(policy);
  if (policyProblems.length > 0) return { ok: false, accepted, blocked: policyProblems };
  if (!Number.isFinite(now))
    return { ok: false, accepted, blocked: ['clock: current time unavailable'] };

  const auditRes = parseJson('pnpm audit --json', run(['audit', '--json']), [0, 1]);
  if (auditRes.problem) return { ok: false, accepted, blocked: [auditRes.problem] };
  const shape = validateAuditShape(auditRes.value);
  if (shape.length > 0) return { ok: false, accepted, blocked: shape };
  const audit = auditRes.value;

  const byAdvisory = new Map(policy.exceptions.map((e) => [e.advisory, e]));
  const matched = new Set();

  for (const [key, a] of Object.entries(audit.advisories)) {
    if (!BLOCKING.has(a.severity)) continue;
    const label = `${a.github_advisory_id ?? `advisory ${key}`} (${a.module_name}, ${a.severity})`;
    const e = isStr(a.github_advisory_id) ? byAdvisory.get(a.github_advisory_id) : undefined;
    if (!e) {
      blocked.push(`${label}: no approved exception`);
      continue;
    }
    matched.add(e.advisory);
    const problems = [];
    if (a.module_name !== e.module)
      problems.push(`module is ${a.module_name}, approved ${e.module}`);
    if (a.severity !== e.severity)
      problems.push(`severity changed to ${a.severity} (approved ${e.severity})`);
    if (a.vulnerable_versions !== e.vulnerableVersions) {
      problems.push(
        `vulnerable range changed to "${a.vulnerable_versions}" (approved "${e.vulnerableVersions}")`,
      );
    }
    if (a.patched_versions !== e.patchedVersions) {
      problems.push(
        `advisory now lists patched versions "${a.patched_versions}": remediate instead of renewing`,
      );
    }
    if (now >= Date.parse(e.expiresAt))
      problems.push(`exception expired at ${e.expiresAt}: renew through review or remediate`);
    if (now < Date.parse(`${e.approvedOn}T00:00:00Z`))
      problems.push('exception approval date is in the future');

    const approved = new Map(e.findings.map((f) => [f.version, new Set(f.paths)]));
    for (const f of a.findings) {
      const allowedPaths = approved.get(f.version);
      if (!allowedPaths) {
        problems.push(`version ${f.version} is not approved`);
        continue;
      }
      for (const p of f.paths) {
        if (!allowedPaths.has(p)) {
          problems.push(`path not approved: ${p}`);
          continue;
        }
        const parts = p.split(' > ');
        const importer = parts[0];
        const top = (parts[1] ?? '').replace(/@[^@]+$/, '');
        if (parts.at(-1) !== `${e.module}@${f.version}`)
          problems.push(`path does not end at ${e.module}@${f.version}: ${p}`);
        if (!e.devOnlyTopLevel.includes(top)) {
          problems.push(`path root ${top} is not an approved development package: ${p}`);
          continue;
        }
        let manifest;
        try {
          manifest = readManifest(importer);
        } catch {
          manifest = null;
        }
        if (!isObj(manifest)) {
          problems.push(`cannot read package.json of importer "${importer}"`);
          continue;
        }
        const inDev = isObj(manifest.devDependencies) && top in manifest.devDependencies;
        const inProd = ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
          (k) => isObj(manifest[k]) && top in manifest[k],
        );
        if (!inDev || inProd)
          problems.push(`${top} is not a devDependency-only package of "${importer}"`);
      }
    }
    if (problems.length > 0) {
      for (const pr of [...new Set(problems)]) blocked.push(`${label}: ${pr}`);
      continue;
    }

    // Production trees must not contain the module at all
    const prod = parseJson(
      `pnpm -r ls ${e.module} --prod`,
      run(['-r', 'ls', e.module, '--prod', '--depth', 'Infinity', '--json']),
      [0],
    );
    if (prod.problem) {
      blocked.push(`${label}: ${prod.problem}`);
      continue;
    }
    if (
      !Array.isArray(prod.value) ||
      prod.value.length === 0 ||
      !prod.value.every((p) => isObj(p) && isStr(p.name))
    ) {
      blocked.push(`${label}: production dependency listing is malformed`);
      continue;
    }
    if (prodTreeContains(prod.value, e.module)) {
      blocked.push(`${label}: ${e.module} is in a production dependency tree`);
      continue;
    }

    // An upstream release above every approved version may fix it: remediate, do not continue
    const view = parseJson(
      `pnpm view ${e.module} dist-tags`,
      run(['view', e.module, 'dist-tags', '--json']),
      [0],
    );
    if (view.problem) {
      blocked.push(`${label}: upstream release metadata unavailable (${view.problem})`);
      continue;
    }
    const latest = isObj(view.value) ? view.value.latest : undefined;
    const highest = e.findings
      .map((f) => f.version)
      .filter((v) => SEMVER.test(v))
      .sort(compareVersions)
      .at(-1);
    if (!isStr(latest) || !SEMVER.test(latest) || !highest) {
      blocked.push(`${label}: upstream release metadata is ambiguous (latest "${String(latest)}")`);
      continue;
    }
    if (compareVersions(latest, highest) > 0) {
      blocked.push(
        `${label}: ${e.module}@${latest} is published (newer than ${highest}); check it for the fix and remediate`,
      );
      continue;
    }

    const counts = a.findings.map((f) => `${f.version} (${f.paths.length} paths)`).join(', ');
    accepted.push(
      `${label}: approved development-only exception until ${e.expiresAt} — ${e.module} ${counts}; production trees clean; latest upstream ${latest}`,
    );
  }

  for (const e of policy.exceptions) {
    if (!matched.has(e.advisory)) {
      accepted.push(
        `${e.advisory}: no longer reported by the audit — remove this exception from the policy`,
      );
    }
  }
  return { ok: blocked.length === 0, accepted, blocked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runPnpm(args) {
  return spawnSync('pnpm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 300_000,
  });
}

function readManifestFile(importer) {
  if (importer !== '.' && !/^(apps|packages)\/[a-z0-9-]+$/.test(importer))
    throw new Error('unexpected importer');
  return JSON.parse(readFileSync(join(ROOT, importer, 'package.json'), 'utf8'));
}

function main() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  } catch {
    console.error('audit-gate: BLOCKED — infra/security/audit-policy.json is missing or not JSON');
    process.exit(1);
  }
  const result = evaluate({
    run: runPnpm,
    policy,
    now: Date.now(),
    readManifest: readManifestFile,
  });
  for (const line of result.accepted) console.log(`audit-gate: ACCEPTED — ${line}`);
  for (const line of result.blocked) console.error(`audit-gate: BLOCKED — ${line}`);
  console.log(
    result.ok
      ? 'audit-gate: PASS — no unapproved high or critical advisory'
      : `audit-gate: FAIL — ${result.blocked.length} blocking problem(s)`,
  );
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
