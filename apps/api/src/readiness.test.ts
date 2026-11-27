import { describe, expect, it } from 'vitest';
import {
  computeReadiness,
  VISITOR_JOIN_OPERATIONAL,
  VISITOR_JOIN_REASONS,
  type ReadinessInput,
} from './readiness.js';

const svc = (
  id: string,
  status: 'active' | 'inactive' = 'active',
): ReadinessInput['services'][number] => ({
  id,
  name: `Service ${id}`,
  status,
});
const ctr = (id: string, active = true): ReadinessInput['counters'][number] => ({
  id,
  name: `Counter ${id}`,
  active,
});
const base = (over: Partial<ReadinessInput>): ReadinessInput => ({
  facilityActive: true,
  services: [],
  counters: [],
  capabilities: [],
  ...over,
});

describe('computeReadiness — operational eligibility', () => {
  it('an empty facility is not ready and says what to add', () => {
    const r = computeReadiness(base({}));
    expect(r.configuration_ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['no_services', 'no_counters']);
  });

  it('counts alone do not make a facility ready: an active counter must serve an active service', () => {
    const r = computeReadiness(base({ services: [svc('s1')], counters: [ctr('c1')] }));
    expect(r.configuration_ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('no_active_counter_serves_active_service');
    expect(r.services[0]?.operational).toBe(false);
    expect(r.counters[0]?.operational).toBe(false);
  });

  it('is ready when an active counter serves an active service', () => {
    const r = computeReadiness(
      base({
        services: [svc('s1')],
        counters: [ctr('c1')],
        capabilities: [{ counter_id: 'c1', service_id: 's1' }],
      }),
    );
    expect(r.configuration_ready).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.services[0]).toMatchObject({
      operational: true,
      active_counter_count: 1,
      configured_counter_count: 1,
    });
    expect(r.counters[0]).toMatchObject({ operational: true, active_service_count: 1 });
  });

  it('an inactive counter keeps its assignments but is not eligible', () => {
    const r = computeReadiness(
      base({
        services: [svc('s1')],
        counters: [ctr('c1', false)],
        capabilities: [{ counter_id: 'c1', service_id: 's1' }],
      }),
    );
    expect(r.configuration_ready).toBe(false);
    expect(r.counters[0]).toMatchObject({
      active: false,
      operational: false,
      configured_service_count: 1,
      active_service_count: 0,
    });
    expect(r.services[0]).toMatchObject({
      operational: false,
      configured_counter_count: 1,
      active_counter_count: 0,
    });
    expect(r.issues.map((i) => i.code)).toContain('no_active_counters');
  });

  it('an inactive service is not eligible even with an active counter assigned', () => {
    const r = computeReadiness(
      base({
        services: [svc('s1', 'inactive')],
        counters: [ctr('c1')],
        capabilities: [{ counter_id: 'c1', service_id: 's1' }],
      }),
    );
    expect(r.configuration_ready).toBe(false);
    expect(r.services[0]).toMatchObject({
      operational: false,
      active_counter_count: 0,
      configured_counter_count: 1,
    });
    expect(r.counters[0]).toMatchObject({ operational: false, active_service_count: 0 });
    expect(r.issues.map((i) => i.code)).toContain('no_active_services');
  });

  it('reports per-service operability when only some services are served', () => {
    const r = computeReadiness(
      base({
        services: [svc('s1'), svc('s2')],
        counters: [ctr('c1'), ctr('c2', false)],
        capabilities: [
          { counter_id: 'c1', service_id: 's1' },
          { counter_id: 'c2', service_id: 's2' },
        ],
      }),
    );
    expect(r.configuration_ready).toBe(true);
    expect(r.services.map((s) => s.operational)).toEqual([true, false]);
    expect(r.counters.map((c) => c.operational)).toEqual([true, false]);
  });

  it('an inactive facility is never ready', () => {
    const r = computeReadiness(
      base({
        facilityActive: false,
        services: [svc('s1')],
        counters: [ctr('c1')],
        capabilities: [{ counter_id: 'c1', service_id: 's1' }],
      }),
    );
    expect(r.configuration_ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('facility_inactive');
  });

  it('ignores capabilities that reference unknown services or counters', () => {
    const r = computeReadiness(
      base({
        services: [svc('s1')],
        counters: [ctr('c1')],
        capabilities: [{ counter_id: 'other-facility-counter', service_id: 's1' }],
      }),
    );
    expect(r.configuration_ready).toBe(false);
  });

  it('visitor join is live only when configured AND an eligible service has an open queue today', () => {
    const configured = base({
      services: [svc('s1'), svc('s2')],
      counters: [ctr('c1')],
      capabilities: [{ counter_id: 'c1', service_id: 's1' }],
    });
    expect(VISITOR_JOIN_OPERATIONAL).toBe(true);
    // Configured but nothing open: not live
    expect(computeReadiness(configured).visitor_join).toEqual({
      operational: false,
      reason: VISITOR_JOIN_REASONS.no_open_queue,
    });
    // Open queue for a service nobody can serve: still not live
    expect(
      computeReadiness({ ...configured, openQueueServiceIds: ['s2'] }).visitor_join.operational,
    ).toBe(false);
    // Open queue for an operational service: live
    expect(computeReadiness({ ...configured, openQueueServiceIds: ['s1'] }).visitor_join).toEqual({
      operational: true,
      reason: VISITOR_JOIN_REASONS.live,
    });
  });

  it('an open queue never makes an unconfigured facility look live', () => {
    const r = computeReadiness(
      base({ services: [svc('s1')], counters: [ctr('c1', false)], openQueueServiceIds: ['s1'] }),
    );
    expect(r.visitor_join).toEqual({
      operational: false,
      reason: VISITOR_JOIN_REASONS.configuration,
    });
  });
});
