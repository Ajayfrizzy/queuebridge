import { Role } from './enums.js';

/**
 * Named API permissions (MQ.1, design §11.3, decision D3).
 *
 * Moved unchanged from `apps/api/src/auth/rbac.ts` so the API and the Ask Que route registry use
 * one definition. The API still enforces every permission server-side (`requireFacilityPermission`);
 * any other consumer (Ask Que, UI hints) is advisory only.
 *
 * `org_admin` implicitly satisfies every permission inside its own organization; every other
 * role must hold one of the listed roles at the facility.
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

/** Every permission name, in declaration order. */
export const PERMISSION_NAMES = Object.keys(Permission) as PermissionName[];
