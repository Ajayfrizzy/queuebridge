import { QueueAction, type ServicePolicy } from '@queuebridge/contracts';
import { canonicalJson } from '@queuebridge/domain';
import type { Db } from '../db.js';
import { appendEvent, lockSessions } from './events.js';

/**
 * Server-managed fairness policy versions (REQ-F3.1, REQ-F5.6).
 *
 * Every policy a service has ever had is an immutable row in `service_policy_versions`; the
 * service row holds the current snapshot. Version labels are assigned here (`v1`, `v2`, …) —
 * never by clients — so a label always identifies exactly one rule set.
 */

/** Policy contents that matter for decisions (the label itself is not part of the comparison). */
const substance = (p: ServicePolicy): string => canonicalJson({ ...p, version: undefined });

export function samePolicy(a: ServicePolicy, b: ServicePolicy): boolean {
  return substance(a) === substance(b);
}

/** Record version 1 of a newly created service. Returns the policy with its server label. */
export async function recordInitialPolicy(
  tx: Db,
  ids: { organizationId: string; facilityId: string; serviceId: string; actorId: string },
  policy: ServicePolicy,
): Promise<ServicePolicy> {
  const labelled: ServicePolicy = { ...policy, version: 'v1' };
  await tx`
    INSERT INTO service_policy_versions
      (organization_id, facility_id, service_id, version_number, version_label, policy, created_by)
    VALUES (${ids.organizationId}, ${ids.facilityId}, ${ids.serviceId}, 1, 'v1',
            ${tx.json(labelled as never)}, ${ids.actorId})`;
  return labelled;
}

/**
 * Create the next version for a service whose row is LOCKED by the caller. Also appends an
 * audit-only `policy.changed` event to each of today's sessions of the service, so every
 * session's own log shows when its rules changed (and decisions after it cite the new label).
 */
export async function recordPolicyChange(
  tx: Db,
  ids: { organizationId: string; facilityId: string; serviceId: string; actorId: string },
  previous: ServicePolicy,
  next: ServicePolicy,
): Promise<ServicePolicy> {
  const rows = await tx<{ n: number; labels: string[] }[]>`
    SELECT COALESCE(MAX(version_number), 0)::int AS n, COALESCE(array_agg(version_label), '{}') AS labels
      FROM service_policy_versions WHERE service_id = ${ids.serviceId}`;
  let number = (rows[0]?.n ?? 0) + 1;
  const taken = new Set(rows[0]?.labels ?? []);
  if (number === 1) {
    // A service created outside the API (e.g. seed data) has no history yet: keep the rules in
    // force until now under the label decisions already cite, so they stay explainable
    await tx`
      INSERT INTO service_policy_versions
        (organization_id, facility_id, service_id, version_number, version_label, policy, created_by)
      VALUES (${ids.organizationId}, ${ids.facilityId}, ${ids.serviceId}, 1, ${previous.version},
              ${tx.json(previous as never)}, NULL)`;
    taken.add(previous.version);
    number = 2;
  }
  // Pre-M4 labels were client-chosen; never reuse one
  while (taken.has(`v${number}`)) number++;
  const label = `v${number}`;
  const labelled: ServicePolicy = { ...next, version: label };
  await tx`
    INSERT INTO service_policy_versions
      (organization_id, facility_id, service_id, version_number, version_label, policy, created_by)
    VALUES (${ids.organizationId}, ${ids.facilityId}, ${ids.serviceId}, ${number}, ${label},
            ${tx.json(labelled as never)}, ${ids.actorId})`;

  const todays = await tx<{ id: string }[]>`
    SELECT qs.id FROM queue_sessions qs JOIN facilities f ON f.id = qs.facility_id
     WHERE qs.service_id = ${ids.serviceId} AND qs.organization_id = ${ids.organizationId}
       AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date`;
  const locked = await lockSessions(
    tx,
    ids.organizationId,
    todays.map((t) => t.id),
  );
  for (const session of locked.values()) {
    await appendEvent(tx, session, {
      eventType: QueueAction.POLICY_CHANGED,
      actorId: ids.actorId,
      operationId: null,
      payload: {
        service_id: ids.serviceId,
        from_version: previous.version,
        to_version: label,
        priority_order: labelled.priority_order,
        transfer_placement: labelled.transfer_placement,
      },
    });
  }
  return labelled;
}

/** All policy snapshots of a service keyed by label (for decision replay). */
export async function policySnapshots(
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<Map<string, ServicePolicy>> {
  const rows = await db<{ version_label: string; policy: ServicePolicy }[]>`
    SELECT version_label, policy FROM service_policy_versions
     WHERE service_id = ${serviceId} AND organization_id = ${organizationId}`;
  return new Map(rows.map((r) => [r.version_label, r.policy]));
}
