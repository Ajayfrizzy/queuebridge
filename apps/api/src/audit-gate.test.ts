import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Scoped dependency-audit gate (infra/scripts/audit-gate.js). Deterministic: every pnpm command
 * is replaced by a fixture; no network.
 *
 * The exception rules are exercised with the MQ.2 GHSA-fc5q-39xc-vjpf exception exactly as it
 * was approved (`testing/audit-policy.fixture.json`). The committed policy holds no exception
 * since 2026-11-20 (the advisory was withdrawn upstream on 2026-11-18); the last block of tests
 * shows that, with it, the gate accepts nothing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface RunResult {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  error?: Error & { code?: string };
}
interface GateResult {
  ok: boolean;
  accepted: string[];
  blocked: string[];
}
interface Gate {
  evaluate(deps: {
    run: (args: string[]) => RunResult;
    policy: unknown;
    now: number;
    readManifest: (importer: string) => unknown;
  }): GateResult;
  validatePolicy(policy: unknown): string[];
}
interface Finding {
  version: string;
  paths: string[];
}
interface Exception {
  advisory: string;
  module: string;
  severity: string;
  vulnerableVersions: string;
  patchedVersions: string;
  approvedOn: string;
  expiresAt: string;
  devOnlyTopLevel: string[];
  findings: Finding[];
}
interface Policy {
  policyVersion: number;
  maxValidityDays: number;
  exceptions: Exception[];
}

let gate: Gate;
/** The exception rules' fixture (never read by the gate itself). */
const POLICY = JSON.parse(
  readFileSync(join(ROOT, 'apps/api/src/testing/audit-policy.fixture.json'), 'utf8'),
) as Policy;
/** The policy the gate actually reads in CI. */
const COMMITTED = JSON.parse(
  readFileSync(join(ROOT, 'infra/security/audit-policy.json'), 'utf8'),
) as Policy;
const EXC = POLICY.exceptions[0]!;
const NOW = Date.parse('2026-11-20T12:00:00Z');

beforeAll(async () => {
  gate = (await import(pathToFileURL(join(ROOT, 'infra/scripts/audit-gate.js')).href)) as Gate;
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Advisory {
  module_name: string;
  severity: string;
  github_advisory_id?: string;
  vulnerable_versions: string;
  patched_versions: string;
  findings: Finding[];
}

function picomatchAdvisory(): Advisory {
  return {
    module_name: 'picomatch',
    severity: 'high',
    github_advisory_id: 'GHSA-fc5q-39xc-vjpf',
    vulnerable_versions: '<=4.0.7',
    patched_versions: '<0.0.0',
    findings: clone(EXC.findings),
  };
}

/** A `pnpm audit --json` body; metadata counts are derived so the fixture is consistent. */
function audit(
  advisories: Record<string, Advisory>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const vulnerabilities: Record<string, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const a of Object.values(advisories))
    vulnerabilities[a.severity] = (vulnerabilities[a.severity] ?? 0) + a.findings.length;
  return {
    actions: [],
    advisories,
    muted: [],
    metadata: { vulnerabilities, dependencies: 730 },
    ...overrides,
  };
}

const DEV_MANIFESTS: Record<string, unknown> = (() => {
  const out: Record<string, unknown> = {};
  for (const f of EXC.findings) {
    for (const p of f.paths) {
      const [importer, top] = p.split(' > ');
      const name = (top ?? '').replace(/@[^@]+$/, '');
      const m = (out[importer!] ??= { devDependencies: {} as Record<string, string> }) as {
        devDependencies: Record<string, string>;
      };
      m.devDependencies[name] = 'x';
    }
  }
  return out;
})();

const PROD_TREE = [
  { name: 'queuebridge', path: '/repo' },
  {
    name: '@queuebridge/api',
    path: '/repo/apps/api',
    dependencies: {
      fastify: { version: '5.0.0', dependencies: { 'fast-uri': { version: '3.0.0' } } },
    },
  },
];

interface Scenario {
  audit?: unknown;
  auditResult?: RunResult;
  prod?: unknown;
  prodResult?: RunResult;
  latest?: unknown;
  viewResult?: RunResult;
  policy?: unknown;
  now?: number;
  manifests?: Record<string, unknown>;
}

function run(s: Scenario = {}): GateResult & { calls: string[][] } {
  const calls: string[][] = [];
  const ok = (v: unknown, status = 0): RunResult => ({
    status,
    signal: null,
    stdout: JSON.stringify(v),
  });
  const r = gate.evaluate({
    policy: s.policy ?? POLICY,
    now: s.now ?? NOW,
    readManifest: (importer) => (s.manifests ?? DEV_MANIFESTS)[importer],
    run: (args) => {
      calls.push(args);
      if (args[0] === 'audit')
        return s.auditResult ?? ok(s.audit ?? audit({ 1: picomatchAdvisory() }), 1);
      if (args[1] === 'ls') return s.prodResult ?? ok(s.prod ?? PROD_TREE);
      if (args[0] === 'view') return s.viewResult ?? ok({ latest: s.latest ?? '4.0.7' });
      throw new Error(`unexpected command ${args.join(' ')}`);
    },
  });
  return { ...r, calls };
}

const blockedText = (r: GateResult): string => r.blocked.join('\n');

describe('1. accepts exactly the approved exception', () => {
  it('passes the approved advisory, versions and paths, and says so', () => {
    const r = run();
    expect(r.blocked).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toContain('GHSA-fc5q-39xc-vjpf');
    expect(r.accepted[0]).toContain('2.3.2 (7 paths), 4.0.7 (215 paths)');
    // The full audit, the production tree and the upstream release were all consulted
    expect(r.calls.map((c) => c.join(' '))).toEqual([
      'audit --json',
      '-r ls picomatch --prod --depth Infinity --json',
      'view picomatch dist-tags --json',
    ]);
  });

  it('a clean audit passes and the stale exception is reported for removal', () => {
    const r = run({ audit: audit({}) });
    expect(r.ok).toBe(true);
    expect(r.accepted.join()).toContain('no longer reported');
  });

  it('low and moderate advisories never block (same threshold as before)', () => {
    const moderate: Advisory = {
      ...picomatchAdvisory(),
      module_name: 'glob',
      severity: 'moderate',
      github_advisory_id: 'GHSA-3g3m-2fjr-6pw4',
      findings: [{ version: '11.1.0', paths: ['. > glob@11.1.0'] }],
    };
    expect(run({ audit: audit({ 1: picomatchAdvisory(), 2: moderate }) }).ok).toBe(true);
  });
});

describe('2. rejects any other high or critical advisory', () => {
  it.each(['high', 'critical'])('%s advisory on another package', (severity) => {
    const other: Advisory = {
      module_name: 'fastify',
      severity,
      github_advisory_id: 'GHSA-2222-3333-4444',
      vulnerable_versions: '<5.9.9',
      patched_versions: '>=5.9.9',
      findings: [{ version: '5.0.0', paths: ['apps/api > fastify@5.0.0'] }],
    };
    const r = run({ audit: audit({ 1: picomatchAdvisory(), 2: other }) });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain('GHSA-2222-3333-4444 (fastify');
    expect(blockedText(r)).toContain('no approved exception');
  });

  it('another advisory on picomatch itself', () => {
    const second = { ...picomatchAdvisory(), github_advisory_id: 'GHSA-9999-8888-7777' };
    const r = run({ audit: audit({ 1: picomatchAdvisory(), 2: second }) });
    expect(blockedText(r)).toContain(
      'GHSA-9999-8888-7777 (picomatch, high): no approved exception',
    );
  });

  it('an advisory without a GHSA id', () => {
    const anon = picomatchAdvisory();
    delete anon.github_advisory_id;
    expect(blockedText(run({ audit: audit({ 7: anon }) }))).toContain(
      'advisory 7 (picomatch, high): no approved exception',
    );
  });
});

describe('3. rejects a newly introduced vulnerable version', () => {
  it('picomatch 3.0.1 appearing anywhere blocks', () => {
    const a = picomatchAdvisory();
    a.findings.push({ version: '3.0.1', paths: ['apps/web > vite@6.4.5 > picomatch@3.0.1'] });
    expect(blockedText(run({ audit: audit({ 1: a }) }))).toContain('version 3.0.1 is not approved');
  });
});

describe('4. rejects a new dependency path', () => {
  it('a new path under an approved version blocks', () => {
    const a = picomatchAdvisory();
    a.findings[1]!.paths.push('apps/web > vite@6.4.5 > some-new-plugin@1.0.0 > picomatch@4.0.7');
    expect(blockedText(run({ audit: audit({ 1: a }) }))).toContain(
      'path not approved: apps/web > vite@6.4.5 > some-new-plugin',
    );
  });

  it('a path added to the policy but rooted in a non-approved package still blocks', () => {
    const policy = clone(POLICY);
    const p = 'apps/api > fastify@5.0.0 > picomatch@4.0.7';
    policy.exceptions[0]!.findings[1]!.paths.push(p);
    const a = picomatchAdvisory();
    a.findings[1]!.paths.push(p);
    expect(blockedText(run({ policy, audit: audit({ 1: a }) }))).toContain(
      'path root fastify is not an approved development package',
    );
  });

  it('a path that does not end at the approved package blocks', () => {
    const policy = clone(POLICY);
    const p = 'apps/web > vite@6.4.5 > picomatch@2.3.2';
    policy.exceptions[0]!.findings[1]!.paths.push(p);
    const a = picomatchAdvisory();
    a.findings[1]!.paths.push(p);
    expect(blockedText(run({ policy, audit: audit({ 1: a }) }))).toContain(
      'does not end at picomatch@4.0.7',
    );
  });
});

describe('5. rejects production exposure', () => {
  it('picomatch in a production dependency tree blocks', () => {
    const prod = clone(PROD_TREE) as Record<string, unknown>[];
    (prod[1]!['dependencies'] as Record<string, unknown>)['fastify'] = {
      version: '5.0.0',
      dependencies: {
        micromatch: { version: '4.0.8', dependencies: { picomatch: { version: '2.3.2' } } },
      },
    };
    expect(blockedText(run({ prod }))).toContain('picomatch is in a production dependency tree');
  });

  it('an approved root declared as a production dependency of its importer blocks', () => {
    const manifests = clone(DEV_MANIFESTS) as Record<string, Record<string, unknown>>;
    manifests['apps/web'] = { ...manifests['apps/web'], dependencies: { vite: '6.4.5' } };
    expect(blockedText(run({ manifests }))).toContain(
      'vite is not a devDependency-only package of "apps/web"',
    );
  });

  it('a root missing from devDependencies, or an unreadable manifest, blocks', () => {
    const manifests = clone(DEV_MANIFESTS) as Record<string, Record<string, unknown>>;
    manifests['apps/api'] = { devDependencies: {} };
    expect(blockedText(run({ manifests }))).toContain(
      'is not a devDependency-only package of "apps/api"',
    );
    const missing = clone(DEV_MANIFESTS) as Record<string, unknown>;
    delete missing['.'];
    expect(blockedText(run({ manifests: missing }))).toContain(
      'cannot read package.json of importer "."',
    );
  });
});

describe('6. rejects malformed or incomplete audit data', () => {
  it.each([
    ['not JSON', { status: 1, stdout: 'Error: something' }],
    ['empty output', { status: 1, stdout: '' }],
    ['a JSON array', { status: 1, stdout: '[]' }],
  ])('%s', (_l, auditResult) => {
    expect(run({ auditResult }).ok).toBe(false);
  });

  it.each([
    ['no advisories', audit({}, { advisories: undefined }), 'advisories missing'],
    ['no metadata', audit({}, { metadata: {} }), 'metadata.vulnerabilities missing'],
    ['no muted list', audit({}, { muted: undefined }), 'muted list missing'],
    ['muted findings', audit({}, { muted: [{ id: 1 }] }), 'muting is not allowed'],
    [
      'counts that do not match the findings',
      audit(
        { 1: picomatchAdvisory() },
        { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } } },
      ),
      'incomplete output',
    ],
    [
      'a finding without paths',
      audit({ 1: { ...picomatchAdvisory(), findings: [{ version: '4.0.7', paths: [] }] } }),
      'malformed finding',
    ],
    [
      'an unknown severity',
      audit({ 1: { ...picomatchAdvisory(), severity: 'severe' } }),
      'unknown severity',
    ],
  ])('%s', (_l, body, expected) => {
    const r = run({ audit: body });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain(expected);
  });

  it('a malformed production listing or policy blocks', () => {
    expect(blockedText(run({ prod: { name: 'x' } }))).toContain(
      'production dependency listing is malformed',
    );
    expect(blockedText(run({ prod: [] }))).toContain('production dependency listing is malformed');
    expect(run({ policy: { policyVersion: 2 } }).ok).toBe(false);
    expect(run({ policy: { ...POLICY, exceptions: [{ ...EXC, findings: [] }] } }).ok).toBe(false);
  });
});

describe('7. rejects expired or over-long approval', () => {
  const expires = Date.parse(EXC.expiresAt);

  it('valid until the expiry instant, blocked from it on', () => {
    expect(run({ now: expires - 1 }).ok).toBe(true);
    const r = run({ now: expires });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain('exception expired at 2026-12-15T00:00:00Z');
    expect(run({ now: Date.parse('2027-06-01T00:00:00Z') }).ok).toBe(false);
  });

  it('the committed policy expires on 2026-12-15 and cannot be extended past the maximum validity', () => {
    expect(EXC.expiresAt).toBe('2026-12-15T00:00:00Z');
    const policy = clone(POLICY);
    policy.exceptions[0]!.expiresAt = '2027-06-01T00:00:00Z';
    expect(gate.validatePolicy(policy).join()).toContain('validity exceeds 45 days');
    expect(run({ policy, now: NOW }).ok).toBe(false);
  });

  it('an approval dated in the future, or a missing clock, blocks', () => {
    expect(blockedText(run({ now: Date.parse('2026-11-16T12:00:00Z') }))).toContain(
      'approval date is in the future',
    );
    expect(run({ now: Number.NaN }).ok).toBe(false);
  });
});

describe('8. rejects unrecognized advisory metadata', () => {
  it.each([
    ['severity raised to critical', { severity: 'critical' }, 'severity changed to critical'],
    ['a widened vulnerable range', { vulnerable_versions: '<=5.0.0' }, 'vulnerable range changed'],
    ['a different module', { module_name: 'micromatch' }, 'module is micromatch'],
  ])('%s', (_l, change, expected) => {
    const a = { ...picomatchAdvisory(), ...change };
    const r = run({ audit: audit({ 1: a }) });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain(expected);
  });
});

describe('9. rejects command failures', () => {
  it.each([
    [
      'the command cannot start',
      { status: null, error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) },
      'could not run (ENOENT)',
    ],
    [
      'the command is killed',
      { status: null, signal: 'SIGTERM', stdout: '' },
      'was killed (SIGTERM)',
    ],
    ['an unexpected exit status', { status: 2, stdout: '{}' }, 'unexpected exit status 2'],
    [
      'pnpm reports an error (exit 1, like a finding)',
      {
        status: 1,
        stdout: JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'request failed' } }),
      },
      'pnpm reported an error (ECONNREFUSED)',
    ],
  ])('audit: %s', (_l, auditResult, expected) => {
    const r = run({ auditResult: auditResult as RunResult });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain(expected);
  });

  it('the production listing or the registry lookup failing blocks (fail closed)', () => {
    expect(blockedText(run({ prodResult: { status: 1, stdout: '' } }))).toContain(
      'unexpected exit status 1',
    );
    const r = run({ viewResult: { status: 1, stdout: '' } });
    expect(blockedText(r)).toContain('upstream release metadata unavailable');
  });
});

describe('10. upstream fix or changed vulnerability status', () => {
  it('the advisory listing a patched version blocks and asks for remediation', () => {
    const a = { ...picomatchAdvisory(), patched_versions: '>=4.0.8' };
    expect(blockedText(run({ audit: audit({ 1: a }) }))).toContain('remediate instead of renewing');
  });

  it('a newer upstream release blocks and asks for remediation', () => {
    const r = run({ latest: '4.0.8' });
    expect(r.ok).toBe(false);
    expect(blockedText(r)).toContain('picomatch@4.0.8 is published (newer than 4.0.7)');
    expect(run({ latest: '5.0.0' }).ok).toBe(false);
  });

  it('ambiguous upstream metadata blocks', () => {
    for (const latest of ['4.0.8-beta.1', 'latest', '', null, 407]) {
      const viewResult = { status: 0, stdout: JSON.stringify({ latest }) };
      expect(blockedText(run({ viewResult }))).toContain('ambiguous');
    }
    expect(blockedText(run({ viewResult: { status: 0, stdout: '{"next":"5.0.0"}' } }))).toContain(
      'ambiguous',
    );
  });
});

describe('policy file and CI wiring', () => {
  it('the fixture is the exception as approved (valid, one advisory, exact paths)', () => {
    expect(gate.validatePolicy(POLICY)).toEqual([]);
    expect(POLICY.exceptions.map((e) => e.advisory)).toEqual(['GHSA-fc5q-39xc-vjpf']);
    expect(EXC.findings.map((f) => [f.version, f.paths.length])).toEqual([
      ['2.3.2', 7],
      ['4.0.7', 215],
    ]);
  });
  it('the committed policy is valid and holds no exception (GHSA-fc5q-39xc-vjpf withdrawn and removed)', () => {
    expect(gate.validatePolicy(COMMITTED)).toEqual([]);
    expect(COMMITTED.exceptions).toEqual([]);
    expect(COMMITTED.maxValidityDays).toBe(POLICY.maxValidityDays);
  });
  it('with the committed policy, the same picomatch finding (if ever re-published) blocks', () => {
    const r = run({ policy: COMMITTED });
    expect(r.ok).toBe(false);
    expect(r.accepted).toEqual([]);
    expect(blockedText(r)).toContain('GHSA-fc5q-39xc-vjpf');
  });
  it('with the committed policy, any new high or critical finding blocks; a clean audit passes', () => {
    for (const severity of ['high', 'critical']) {
      const a: Advisory = {
        module_name: 'left-pad',
        severity,
        github_advisory_id: 'GHSA-xxxx-yyyy-zzzz',
        vulnerable_versions: '<9.9.9',
        patched_versions: '>=9.9.9',
        findings: [{ version: '1.0.0', paths: ['apps/api > left-pad@1.0.0'] }],
      };
      const r = run({ policy: COMMITTED, audit: audit({ 7: a }) });
      expect(r.ok, severity).toBe(false);
      expect(blockedText(r)).toContain('GHSA-xxxx-yyyy-zzzz');
    }
    const clean = run({ policy: COMMITTED, audit: audit({}) });
    expect(clean).toMatchObject({ ok: true, blocked: [], accepted: [] });
  });

  it('no blanket ignore exists in pnpm configuration', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(pkg)).not.toMatch(/ignoreGhsas|ignoreCves|auditConfig/);
    const npmrc = ((): string => {
      try {
        return readFileSync(join(ROOT, '.npmrc'), 'utf8');
      } catch {
        return '';
      }
    })();
    expect(npmrc).not.toMatch(/audit/i);
  });

  it('CI keeps the exception-free production audit and runs the full audit through the gate', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('run: pnpm audit --prod --audit-level high');
    expect(ci).toContain('run: node infra/scripts/audit-gate.js');
    expect(ci).not.toMatch(/continue-on-error|\|\| true/);
  });
});
