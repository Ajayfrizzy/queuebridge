import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_NAMES,
  Permission as SharedPermission,
  Role,
  type PermissionName,
  type RoleGrant,
} from '@queuebridge/contracts';
import { TRANSITION_RULES, transition } from '@queuebridge/domain';
import {
  CONSOLE_OPERATIONS,
  ROUTE_REGISTRY,
  canPerformOperation,
  holdsPermission,
  operationRoles,
  queueActorRolesAt,
} from '@queuebridge/assist';
import {
  Permission,
  queueActorRoles,
  requireFacilityPermission,
  type AuthContext,
  type FacilityRow,
} from './auth/rbac.js';
import type { Db } from './db.js';
import { ApiProblem } from './errors.js';

/**
 * MQ.1 decision D3 — permission synchronization checks against the API's real authorization
 * code. Pure (no database): `requireFacilityPermission` runs with a stub that returns the
 * facility row, so only its role logic is exercised.
 */

const ORG = '0193a000-0000-7000-8000-0000000000c0';
const FA = '0193a000-0000-7000-8000-00000000000a';
const FB = '0193a000-0000-7000-8000-00000000000b';
const FACILITY_ROLES = [
  Role.STAFF_RECEPTION,
  Role.STAFF_COUNTER,
  Role.SUPERVISOR,
  Role.FACILITY_ADMIN,
  Role.AUDITOR,
] as const;

function auth(grants: RoleGrant[]): AuthContext {
  return {
    sessionId: 's',
    sessionExpiresAt: new Date(0),
    staffUserId: 'u',
    organizationId: ORG,
    organizationName: 'Org',
    organizationSlug: 'org',
    email: 'staff@example.test',
    displayName: 'Staff',
    roles: grants,
  };
}

const facilityDb = ((): Db => {
  const row: FacilityRow = {
    id: FA,
    organization_id: ORG,
    name: 'A',
    slug: 'a',
    timezone: 'UTC',
    status: 'active',
    created_at: new Date(0),
  };
  return (async () => [row]) as unknown as Db;
})();
const emptyDb = (async () => []) as unknown as Db;

/** Every grant set: each subset of facility roles at A, optionally org_admin, optionally a role at B. */
function grantSets(): RoleGrant[][] {
  const out: RoleGrant[][] = [];
  for (let mask = 0; mask < 1 << FACILITY_ROLES.length; mask++) {
    const atA = FACILITY_ROLES.filter((_, i) => mask & (1 << i)).map((role) => ({
      role,
      facility_id: FA,
    }));
    for (const extra of [
      [],
      [{ role: Role.ORG_ADMIN, facility_id: null }],
      [{ role: Role.SUPERVISOR, facility_id: FB }],
    ] as RoleGrant[][]) {
      out.push([...atA, ...extra]);
    }
  }
  return out;
}

async function apiAllows(
  db: Db,
  a: AuthContext,
  facility: string,
  p: PermissionName,
): Promise<number> {
  try {
    await requireFacilityPermission(db, a, facility, p);
    return 200;
  } catch (e) {
    if (e instanceof ApiProblem) return e.status;
    throw e;
  }
}

describe('D3 check 1: API permissions', () => {
  it('the API enforces the shared map (same object), unchanged', () => {
    expect(Permission).toBe(SharedPermission);
  });

  it('every permission named by a route handler exists in the shared map, and every permission is used', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'routes');
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // The permission literal of each call (calls span several lines and nest other calls)
      const calls = src.matchAll(
        /(?:requireFacilityPermission|authorizeQueue|staffRef|authorizeCounter)\([\s\S]{0,240}?'([A-Z][A-Z_]+)'/g,
      );
      for (const c of calls) used.add(c[1]!);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const p of used) expect(PERMISSION_NAMES).toContain(p);
    expect([...used].sort()).toEqual([...PERMISSION_NAMES].sort());
  });
});

describe('D3: Que permission helpers agree with the API, exhaustively', () => {
  it('holdsPermission ⇔ requireFacilityPermission succeeds (every role set × permission)', async () => {
    let n = 0;
    for (const grants of grantSets()) {
      const a = auth(grants);
      for (const p of PERMISSION_NAMES) {
        const status = await apiAllows(facilityDb, a, FA, p);
        expect([200, 403, 404]).toContain(status);
        expect(holdsPermission(grants, FA, p)).toBe(status === 200);
        n++;
      }
    }
    expect(n).toBe(grantSets().length * PERMISSION_NAMES.length);
  });

  it('D3 check 5: a facility outside the session organization is a 404 for the API and never permitted to Que', async () => {
    for (const grants of grantSets()) {
      for (const p of PERMISSION_NAMES) {
        expect(await apiAllows(emptyDb, auth(grants), FB, p)).toBe(404);
        const onlyA = grants.every((g) => g.facility_id === FA);
        if (onlyA) expect(holdsPermission(grants, FB, p)).toBe(false);
      }
    }
  });

  it('queueActorRolesAt ⇔ the API queueActorRoles (every role set)', () => {
    for (const grants of grantSets()) {
      expect([...queueActorRolesAt(grants, FA)].sort()).toEqual(
        [...queueActorRoles(auth(grants), FA)].sort(),
      );
    }
  });
});

describe('D3 check 4: state-machine operation roles', () => {
  const policies = [...new Set(TRANSITION_RULES.flatMap((r) => r.requiresPolicy ?? []))];

  it('every console operation exists in the domain transition table', () => {
    for (const op of CONSOLE_OPERATIONS) {
      expect(TRANSITION_RULES.some((r) => r.action === op.action && r.from === op.from)).toBe(true);
      expect(operationRoles(op, TRANSITION_RULES).length).toBeGreaterThan(0);
    }
    expect(ROUTE_REGISTRY['staff.console'].operations).toBe(CONSOLE_OPERATIONS);
  });

  it('the role Que names for each operation is exactly what the state machine allows', () => {
    for (const op of CONSOLE_OPERATIONS) {
      const named = operationRoles(op, TRANSITION_RULES);
      for (const role of Object.values(Role)) {
        if (role === Role.ORG_ADMIN) continue;
        const ok = transition({
          currentState: op.from,
          action: op.action,
          actorRole: role,
          satisfiedPolicies: policies,
        }).success;
        expect(named.includes(role)).toBe(ok);
      }
      // org_admin is named exactly when it can act through queueActorRoles (supervisor authority)
      const orgOk = queueActorRoles(auth([{ role: Role.ORG_ADMIN, facility_id: null }]), FA).some(
        (r) =>
          transition({
            currentState: op.from,
            action: op.action,
            actorRole: r,
            satisfiedPolicies: policies,
          }).success,
      );
      expect(named.includes(Role.ORG_ADMIN)).toBe(orgOk);
    }
  });

  it('canPerformOperation ⇔ API queue-actor roles + domain transition (every role set)', () => {
    for (const grants of grantSets()) {
      const actorRoles = queueActorRoles(auth(grants), FA);
      for (const op of CONSOLE_OPERATIONS) {
        const domainOk = actorRoles.some(
          (r) =>
            transition({
              currentState: op.from,
              action: op.action,
              actorRole: r,
              satisfiedPolicies: policies,
            }).success,
        );
        expect(canPerformOperation(grants, FA, op, TRANSITION_RULES)).toBe(domainOk);
      }
    }
  });

  it('auditors can perform no console operation', () => {
    for (const op of CONSOLE_OPERATIONS) {
      expect(
        canPerformOperation([{ role: Role.AUDITOR, facility_id: FA }], FA, op, TRANSITION_RULES),
      ).toBe(false);
    }
  });
});
