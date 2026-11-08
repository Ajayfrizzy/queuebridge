import { Role, type SessionUser } from '@queuebridge/contracts';

/**
 * UI-only permission hints. The API enforces authorization on every request; these helpers
 * merely avoid showing controls that would be rejected.
 */
export function isOrgAdmin(user: SessionUser): boolean {
  return user.roles.some((r) => r.role === Role.ORG_ADMIN && r.facility_id === null);
}

export function isFacilityAdmin(user: SessionUser, facilityId: string): boolean {
  return (
    isOrgAdmin(user) ||
    user.roles.some((r) => r.role === Role.FACILITY_ADMIN && r.facility_id === facilityId)
  );
}

export const ROLE_LABELS: Record<string, string> = {
  org_admin: 'Organization administrator',
  facility_admin: 'Facility administrator',
  supervisor: 'Supervisor',
  staff_counter: 'Counter operator',
  staff_reception: 'Reception',
  auditor: 'Auditor (read-only)',
};

export const INVITABLE_ROLES = [
  'staff_reception',
  'staff_counter',
  'supervisor',
  'facility_admin',
  'auditor',
] as const;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** UI hint only — the API authorizes every command. */
export function hasFacilityRole(
  user: SessionUser,
  facilityId: string,
  roles: readonly string[],
): boolean {
  if (isOrgAdmin(user)) return true;
  return user.roles.some((r) => r.facility_id === facilityId && roles.includes(r.role));
}

export const QUEUE_MANAGER_ROLES = ['supervisor', 'facility_admin'] as const;
export const COUNTER_ROLES = ['staff_counter', 'supervisor'] as const;
export const WALK_IN_ROLES = [
  'staff_reception',
  'staff_counter',
  'supervisor',
  'facility_admin',
] as const;
