import type { RoleGrant } from '@queuebridge/contracts';
import { Role } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { problems } from '../errors.js';

/** The authenticated principal, derived entirely server-side from the session cookie. */
export interface AuthContext {
  sessionId: string;
  /** Absolute end of this server-side session (offline caches must not outlive it). */
  sessionExpiresAt: Date;
  staffUserId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  email: string;
  displayName: string;
  roles: RoleGrant[];
}

/**
 * Named permissions. `org_admin` implicitly satisfies every permission inside its own
 * organization; every other role must hold one of the listed roles at the facility.
 */
export const Permission = {
  /** Read facility configuration (services, counters, join link). */
  FACILITY_READ: [
    Role.STAFF_RECEPTION,
    Role.STAFF_COUNTER,
    Role.SUPERVISOR,
    Role.FACILITY_ADMIN,
    Role.AUDITOR,
  ],
  /** Create/modify services, counters and counter capabilities. */
  FACILITY_CONFIGURE: [Role.FACILITY_ADMIN],
  /** List staff, invite staff, assign/revoke facility roles. */
  STAFF_MANAGE: [Role.FACILITY_ADMIN],
  /** View queue sessions and the staff queue console (read-only for auditors). */
  QUEUE_VIEW: [
    Role.STAFF_RECEPTION,
    Role.STAFF_COUNTER,
    Role.SUPERVISOR,
    Role.FACILITY_ADMIN,
    Role.AUDITOR,
  ],
  /** Open, pause, close and reopen queue sessions. */
  QUEUE_MANAGE: [Role.SUPERVISOR, Role.FACILITY_ADMIN],
  /**
   * Connectivity and recovery dashboard, device health and the conflict-review list (F9).
   * Auditors may inspect; they can never act (acting requires QUEUE_MANAGE).
   */
  OPERATIONS_VIEW: [Role.SUPERVISOR, Role.FACILITY_ADMIN, Role.AUDITOR],
  /**
   * Read-only audit view, export and integrity verification (REQ-F8.5). Auditors read; nobody
   * can write through these endpoints.
   */
  AUDIT_VIEW: [Role.AUDITOR, Role.SUPERVISOR, Role.FACILITY_ADMIN],
  /** Staff-assisted walk-in registration. */
  WALK_IN: [Role.STAFF_RECEPTION, Role.STAFF_COUNTER, Role.SUPERVISOR, Role.FACILITY_ADMIN],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionName = keyof typeof Permission;

export function isOrgAdmin(auth: AuthContext): boolean {
  return auth.roles.some((r) => r.role === Role.ORG_ADMIN && r.facility_id === null);
}

export function facilityRoles(auth: AuthContext, facilityId: string): Role[] {
  return auth.roles.filter((r) => r.facility_id === facilityId).map((r) => r.role);
}

export interface FacilityRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  timezone: string;
  status: 'active' | 'inactive' | 'suspended';
  created_at: Date;
}

/**
 * Resolve a facility for the caller and enforce a permission.
 *
 * - The lookup is always scoped by the *session's* organization_id, so a facility in
 *   another organization is indistinguishable from a facility that does not exist (404).
 * - A caller with no role at the facility also gets 404 (no existence confirmation).
 * - A caller with a role that is insufficient for the action gets 403.
 */
export async function requireFacilityPermission(
  db: Db,
  auth: AuthContext,
  facilityId: string,
  permission: PermissionName,
): Promise<FacilityRow> {
  const rows = await db<FacilityRow[]>`
    SELECT id, organization_id, name, slug, timezone, status, created_at
      FROM facilities
     WHERE id = ${facilityId} AND organization_id = ${auth.organizationId}`;
  const facility = rows[0];
  if (!facility) throw problems.notFound();

  if (isOrgAdmin(auth)) return facility;

  const held = facilityRoles(auth, facilityId);
  if (held.length === 0) throw problems.notFound();

  const allowed: readonly Role[] = Permission[permission];
  if (!held.some((r) => allowed.includes(r))) throw problems.forbidden();
  return facility;
}

/** Organization-wide actions (create facility, deactivate staff). */
export function requireOrgAdmin(auth: AuthContext): void {
  if (!isOrgAdmin(auth)) throw problems.forbidden();
}

/**
 * Roles used to evaluate ticket state-machine rules at a facility.
 * An organization administrator acts with supervisor authority for queue operations; every
 * other principal uses exactly the roles granted at that facility. Never derived from input.
 */
export function queueActorRoles(auth: AuthContext, facilityId: string): Role[] {
  const held = facilityRoles(auth, facilityId);
  return isOrgAdmin(auth) ? [...new Set([...held, Role.SUPERVISOR, Role.FACILITY_ADMIN])] : held;
}
