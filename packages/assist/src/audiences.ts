import {
  AUDIENCES,
  Permission,
  Role,
  type Audience,
  type PermissionName,
  type RoleGrant,
} from '@queuebridge/contracts';

/**
 * Audience and permission helpers for Ask Que (design §11.2, §11.3).
 *
 * These read the server-derived role grants of the session (`/auth/me`), never client claims,
 * and they are advisory: every API endpoint still authorizes on its own. They mirror
 * `apps/api/src/auth/rbac.ts` (verified exhaustively by the API's D3 consistency test).
 */

const ROLE_AUDIENCE: Readonly<Record<Role, Audience>> = {
  [Role.VISITOR_ANONYMOUS]: 'visitor',
  [Role.STAFF_RECEPTION]: 'reception',
  [Role.STAFF_COUNTER]: 'counter',
  [Role.SUPERVISOR]: 'supervisor',
  [Role.FACILITY_ADMIN]: 'facility_admin',
  [Role.ORG_ADMIN]: 'org_admin',
  [Role.AUDITOR]: 'auditor',
};

/**
 * Version of the role → audience mapping (including the `org_admin` expansion). Part of the
 * server-issued role fingerprint (D2, design §11.5.4): changing the mapping must bump this so
 * every cached restricted bundle is invalidated.
 */
export const AUDIENCE_MAPPING_VERSION = 1;

/** Staff audiences an organization administrator receives (design §11.2, corrected 2026-11-16). */
export const ORG_ADMIN_AUDIENCES: readonly Audience[] = [
  'reception',
  'counter',
  'supervisor',
  'facility_admin',
  'org_admin',
  'auditor',
];

export function audienceForRole(role: Role): Audience {
  return ROLE_AUDIENCE[role];
}

/** True for an organization-wide `org_admin` grant (same rule as the API's `isOrgAdmin`). */
export function isOrgAdmin(grants: readonly RoleGrant[] | null): boolean {
  return (grants ?? []).some((g) => g.role === Role.ORG_ADMIN && g.facility_id === null);
}

/**
 * Audiences whose articles the user may read: `visitor` (public) for everyone, plus the union of
 * staff audiences over every facility where the user holds a role. Anonymous visitors (`null`)
 * get `visitor` only. Links are still filtered per facility (`holdsPermission`).
 */
export function audiencesFor(grants: readonly RoleGrant[] | null): Audience[] {
  const set = new Set<Audience>(['visitor']);
  for (const g of grants ?? []) {
    if (g.role === Role.ORG_ADMIN) {
      if (g.facility_id === null) ORG_ADMIN_AUDIENCES.forEach((a) => set.add(a));
      continue;
    }
    set.add(ROLE_AUDIENCE[g.role]);
  }
  return AUDIENCES.filter((a) => set.has(a));
}

/** Roles the user holds at one facility (no org-wide expansion). */
export function rolesAtFacility(grants: readonly RoleGrant[] | null, facilityId: string): Role[] {
  return (grants ?? []).filter((g) => g.facility_id === facilityId).map((g) => g.role);
}

/**
 * Whether the grants satisfy a named permission at a facility: `org_admin` satisfies every
 * permission; otherwise a role held at that facility must be listed. Mirrors
 * `requireFacilityPermission` (which additionally checks the facility belongs to the session's
 * organization — something only the server can know).
 */
export function holdsPermission(
  grants: readonly RoleGrant[] | null,
  facilityId: string | null,
  permission: PermissionName,
): boolean {
  if (grants === null || facilityId === null) return false;
  if (isOrgAdmin(grants)) return true;
  const allowed: readonly Role[] = Permission[permission];
  return rolesAtFacility(grants, facilityId).some((r) => allowed.includes(r));
}

/**
 * Roles used for ticket state-machine rules at a facility. Same rule as the API's
 * `queueActorRoles`: an organization administrator acts with supervisor and facility-admin
 * authority; everyone else uses exactly the roles granted at that facility.
 */
export function queueActorRolesAt(
  grants: readonly RoleGrant[] | null,
  facilityId: string | null,
): Role[] {
  if (grants === null || facilityId === null) return [];
  const held = rolesAtFacility(grants, facilityId);
  return isOrgAdmin(grants) ? [...new Set([...held, Role.SUPERVISOR, Role.FACILITY_ADMIN])] : held;
}

/** Plain role names for "which role is required" text (REQ-F13.1.3); never individuals. */
export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  [Role.VISITOR_ANONYMOUS]: 'Visitor',
  [Role.STAFF_RECEPTION]: 'Reception',
  [Role.STAFF_COUNTER]: 'Counter operator',
  [Role.SUPERVISOR]: 'Supervisor',
  [Role.FACILITY_ADMIN]: 'Facility administrator',
  [Role.ORG_ADMIN]: 'Organization administrator',
  [Role.AUDITOR]: 'Auditor (read-only)',
};
