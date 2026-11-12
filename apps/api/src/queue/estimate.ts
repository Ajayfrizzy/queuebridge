import type { WaitEstimate } from '@queuebridge/contracts';
import { computeWaitEstimate } from '@queuebridge/domain';
import type { Db } from '../db.js';

/** Bounds on observed service durations used as samples (REQ-F6.1 "bounded" samples). */
export const SAMPLE_WINDOW_DAYS = 14;
export const MAX_SAMPLES = 50;
export const MIN_SAMPLE_SECONDS = 5;
export const MAX_SAMPLE_SECONDS = 4 * 60 * 60;

export interface EstimateContext {
  organizationId: string;
  facilityId: string;
  serviceId: string;
  /** Waiting tickets ahead under the published order */
  position: number;
  queueState: string;
}

/** Active, OPEN counters, in an active facility, set to serve this active service. */
export async function activeCompatibleCounters(
  db: Db,
  organizationId: string,
  facilityId: string,
  serviceId: string,
): Promise<number> {
  const rows = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
      FROM counters c
      JOIN counter_service_capabilities csc ON csc.counter_id = c.id AND csc.service_id = ${serviceId}
      JOIN services s ON s.id = csc.service_id AND s.status = 'active'
      JOIN facilities f ON f.id = c.facility_id AND f.status = 'active'
     WHERE c.organization_id = ${organizationId} AND c.facility_id = ${facilityId} AND c.active
       AND c.availability = 'open'`;
  return rows[0]?.n ?? 0;
}

/** Recent, bounded serving durations (seconds) for this service, newest first. */
export async function serviceSamples(
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<number[]> {
  const rows = await db<{ seconds: number }[]>`
    SELECT EXTRACT(EPOCH FROM (t.completed_at - t.serving_started_at))::float8 AS seconds
      FROM tickets t
      JOIN queue_sessions qs ON qs.id = t.queue_session_id AND qs.organization_id = t.organization_id
     WHERE t.organization_id = ${organizationId} AND qs.service_id = ${serviceId}
       AND t.state = 'completed' AND t.serving_started_at IS NOT NULL
       AND t.completed_at > NOW() - make_interval(days => ${SAMPLE_WINDOW_DAYS})
     ORDER BY t.completed_at DESC
     LIMIT ${MAX_SAMPLES}`;
  return rows
    .map((r) => r.seconds)
    .filter((s) => s >= MIN_SAMPLE_SECONDS && s <= MAX_SAMPLE_SECONDS);
}

/**
 * Explainable wait estimate (F6). Delegates the arithmetic to the pure domain function and adds
 * honest context factors. Never an exact time; `insufficient_data` when evidence is missing.
 */
export async function loadEstimate(db: Db, ctx: EstimateContext): Promise<WaitEstimate> {
  const [counters, samples] = await Promise.all([
    activeCompatibleCounters(db, ctx.organizationId, ctx.facilityId, ctx.serviceId),
    serviceSamples(db, ctx.organizationId, ctx.serviceId),
  ]);
  const estimate = computeWaitEstimate({
    position: ctx.position,
    activeCompatibleCounters: counters,
    serviceSamples: samples,
    calculatedAt: new Date().toISOString(),
  });
  const factors = [...estimate.factors];
  if (ctx.queueState === 'paused') {
    factors.push('Calling is paused right now; the estimate starts when calling resumes');
  }
  factors.push('Operating hours are not configured, so the estimate assumes counters stay open');
  factors.push('An estimate, not an appointment: the actual time can differ');
  return { ...estimate, factors };
}
