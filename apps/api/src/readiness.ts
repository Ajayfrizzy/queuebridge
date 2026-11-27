import type { FacilityReadiness, ReadinessIssueCode } from '@queuebridge/contracts';
import type { Db } from './db.js';

/**
 * Visitor registration exists since M2 (`POST /queues/:id/join`). The join link is operational
 * only when configuration is ready AND at least one service with an eligible counter has an OPEN
 * queue session today. The platform capability flag stays explicit so the capability manifest
 * (MQ) can read it.
 */
export const VISITOR_JOIN_OPERATIONAL = true;
export const VISITOR_JOIN_REASONS = {
  live: 'Visitors can join now using this link or QR code.',
  configuration: 'Finish setup first: an active counter must serve an active service.',
  no_open_queue:
    'No queue is open today. Open a queue from the staff console before sharing this link.',
} as const;

export interface ReadinessInput {
  facilityActive: boolean;
  services: { id: string; name: string; status: 'active' | 'inactive' }[];
  counters: { id: string; name: string; active: boolean }[];
  capabilities: { counter_id: string; service_id: string }[];
  /** Services that have an OPEN queue session today (facility time zone). */
  openQueueServiceIds?: string[];
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
    visitor_join: visitorJoin(configurationReady, services, input.openQueueServiceIds ?? []),
  };
}

function visitorJoin(
  configurationReady: boolean,
  services: { id: string; operational: boolean }[],
  openQueueServiceIds: string[],
): FacilityReadiness['visitor_join'] {
  if (!VISITOR_JOIN_OPERATIONAL || !configurationReady) {
    return { operational: false, reason: VISITOR_JOIN_REASONS.configuration };
  }
  const open = new Set(openQueueServiceIds);
  const live = services.some((s) => s.operational && open.has(s.id));
  return live
    ? { operational: true, reason: VISITOR_JOIN_REASONS.live }
    : { operational: false, reason: VISITOR_JOIN_REASONS.no_open_queue };
}

/** Load readiness strictly within one organization + facility (callers authorize first). */
export async function loadReadiness(
  db: Db,
  organizationId: string,
  facilityId: string,
  facilityStatus: string,
): Promise<FacilityReadiness> {
  const [services, counters, capabilities, openQueues] = await Promise.all([
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
    db<{ service_id: string }[]>`
      SELECT qs.service_id FROM queue_sessions qs JOIN facilities f ON f.id = qs.facility_id
       WHERE qs.facility_id = ${facilityId} AND qs.organization_id = ${organizationId}
         AND qs.state = 'open' AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date`,
  ]);
  return computeReadiness({
    facilityActive: facilityStatus === 'active',
    services,
    counters,
    capabilities,
    openQueueServiceIds: openQueues.map((q) => q.service_id),
  });
}
