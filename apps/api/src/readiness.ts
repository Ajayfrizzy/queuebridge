import type { FacilityReadiness, ReadinessIssueCode } from '@queuebridge/contracts';
import type { Db } from './db.js';

/**
 * Visitor registration is delivered in M2. Until then a join link/QR must never be presented
 * as operational, regardless of how complete the configuration is. M2 flips this constant
 * when `POST /queues/:id/join` exists.
 */
export const VISITOR_JOIN_OPERATIONAL = false;
export const VISITOR_JOIN_REASON =
  'Visitor registration is not available yet. The link and QR code are for preparation only.';

export interface ReadinessInput {
  facilityActive: boolean;
  services: { id: string; name: string; status: 'active' | 'inactive' }[];
  counters: { id: string; name: string; active: boolean }[];
  capabilities: { counter_id: string; service_id: string }[];
}

/**
 * Pure derivation of facility readiness and operational eligibility.
 *
 * Eligibility rule (reused by the M2 routing engine): a counter may serve a service only if
 * the facility, the counter AND the service are all active AND an explicit capability exists.
 * Inactive counters/services keep their capability rows (configuration is preserved) but are
 * never eligible.
 */
export function computeReadiness(input: ReadinessInput): FacilityReadiness {
  const serviceActive = new Map(input.services.map((s) => [s.id, s.status === 'active']));
  const counterActive = new Map(input.counters.map((c) => [c.id, c.active]));

  const caps = input.capabilities.filter(
    (c) => serviceActive.has(c.service_id) && counterActive.has(c.counter_id),
  );
  const eligible = caps.filter(
    (c) =>
      input.facilityActive &&
      serviceActive.get(c.service_id) === true &&
      counterActive.get(c.counter_id) === true,
  );

  const services = input.services.map((s) => {
    const configured = caps.filter((c) => c.service_id === s.id);
    const activeCounters = eligible.filter((c) => c.service_id === s.id);
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      operational: activeCounters.length > 0,
      active_counter_count:
        input.facilityActive && s.status === 'active' ? activeCounters.length : 0,
      configured_counter_count: configured.length,
    };
  });

  const counters = input.counters.map((c) => {
    const configured = caps.filter((x) => x.counter_id === c.id);
    const active = eligible.filter((x) => x.counter_id === c.id);
    return {
      id: c.id,
      name: c.name,
      active: c.active,
      operational: active.length > 0,
      active_service_count: active.length,
      configured_service_count: configured.length,
    };
  });

  const issues: { code: ReadinessIssueCode; message: string }[] = [];
  const add = (code: ReadinessIssueCode, message: string): void => {
    issues.push({ code, message });
  };
  if (!input.facilityActive) add('facility_inactive', 'The facility is not active.');
  if (input.services.length === 0) add('no_services', 'Add at least one service.');
  else if (!input.services.some((s) => s.status === 'active'))
    add('no_active_services', 'Activate at least one service.');
  if (input.counters.length === 0) add('no_counters', 'Add at least one counter.');
  else if (!input.counters.some((c) => c.active))
    add('no_active_counters', 'Activate at least one counter.');

  const configurationReady = eligible.length > 0;
  if (
    !configurationReady &&
    input.services.some((s) => s.status === 'active') &&
    input.counters.some((c) => c.active)
  ) {
    add(
      'no_active_counter_serves_active_service',
      'No active counter is set to serve an active service. Tick a service on an active counter.',
    );
  }

  return {
    configuration_ready: configurationReady,
    facility_active: input.facilityActive,
    services,
    counters,
    issues,
    visitor_join: { operational: VISITOR_JOIN_OPERATIONAL, reason: VISITOR_JOIN_REASON },
  };
}

/** Load readiness strictly within one organization + facility (callers authorize first). */
export async function loadReadiness(
  db: Db,
  organizationId: string,
  facilityId: string,
  facilityStatus: string,
): Promise<FacilityReadiness> {
  const [services, counters, capabilities] = await Promise.all([
    db<{ id: string; name: string; status: 'active' | 'inactive' }[]>`
      SELECT id, name, status FROM services
       WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}
       ORDER BY created_at, name`,
    db<{ id: string; name: string; active: boolean }[]>`
      SELECT id, name, active FROM counters
       WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}
       ORDER BY created_at, name`,
    db<{ counter_id: string; service_id: string }[]>`
      SELECT csc.counter_id, csc.service_id
        FROM counter_service_capabilities csc
        JOIN counters c ON c.id = csc.counter_id
       WHERE c.facility_id = ${facilityId} AND c.organization_id = ${organizationId}`,
  ]);
  return computeReadiness({
    facilityActive: facilityStatus === 'active',
    services,
    counters,
    capabilities,
  });
}
