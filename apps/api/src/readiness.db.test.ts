import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FacilityReadiness } from '@queuebridge/contracts';
import {
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  TestClient,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

interface Setup {
  org: TestOrg;
  fid: string;
  serviceId: string;
  counterId: string;
}

async function setup(): Promise<Setup> {
  const org = await signupOrg(t.app);
  const fid = (await createFacility(org)).id;
  const serviceId = (
    await org.admin.post<{ service: { id: string } }>(`/api/v1/facilities/${fid}/services`, {
      name: 'Registration',
    })
  ).body.service.id;
  const counterId = (
    await org.admin.post<{ counter: { id: string } }>(`/api/v1/facilities/${fid}/counters`, {
      name: 'Desk 1',
    })
  ).body.counter.id;
  return { org, fid, serviceId, counterId };
}

async function readiness(c: TestClient, fid: string): Promise<FacilityReadiness> {
  const res = await c.get<{ readiness: FacilityReadiness }>(`/api/v1/facilities/${fid}/readiness`);
  expect(res.status).toBe(200);
  return res.body.readiness;
}

describe('facility readiness and operational eligibility (M1)', () => {
  it('one service + one counter is NOT ready until the counter is set to serve the service', async () => {
    const s = await setup();
    const before = await readiness(s.org.admin, s.fid);
    expect(before.configuration_ready).toBe(false);
    expect(before.issues.map((i) => i.code)).toContain('no_active_counter_serves_active_service');

    await s.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: s.counterId,
      service_id: s.serviceId,
    });
    const after = await readiness(s.org.admin, s.fid);
    expect(after.configuration_ready).toBe(true);
    expect(after.services[0]).toMatchObject({ operational: true, active_counter_count: 1 });
  });

  it('deactivating the counter removes eligibility but preserves the service assignment', async () => {
    const s = await setup();
    await s.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: s.counterId,
      service_id: s.serviceId,
    });
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/counters/${s.counterId}`, {
      active: false,
    });

    const r = await readiness(s.org.admin, s.fid);
    expect(r.configuration_ready).toBe(false);
    expect(r.counters[0]).toMatchObject({
      active: false,
      operational: false,
      configured_service_count: 1,
    });
    // The stored configuration survived
    const counters = await s.org.admin.get<{ counters: { service_ids: string[] }[] }>(
      `/api/v1/facilities/${s.fid}/counters`,
    );
    expect(counters.body.counters[0]?.service_ids).toEqual([s.serviceId]);
    expect(
      await t.db`SELECT 1 FROM counter_service_capabilities WHERE counter_id = ${s.counterId}`,
    ).toHaveLength(1);

    // Reactivating restores eligibility without re-configuring anything
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/counters/${s.counterId}`, {
      active: true,
    });
    expect((await readiness(s.org.admin, s.fid)).configuration_ready).toBe(true);
  });

  it('deactivating the service removes eligibility; reactivating restores it', async () => {
    const s = await setup();
    await s.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: s.counterId,
      service_id: s.serviceId,
    });
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/services/${s.serviceId}`, {
      status: 'inactive',
    });
    const off = await readiness(s.org.admin, s.fid);
    expect(off.configuration_ready).toBe(false);
    expect(off.services[0]).toMatchObject({
      status: 'inactive',
      operational: false,
      active_counter_count: 0,
      configured_counter_count: 1,
    });
    expect(off.counters[0]).toMatchObject({ operational: false });

    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/services/${s.serviceId}`, {
      status: 'active',
    });
    expect((await readiness(s.org.admin, s.fid)).configuration_ready).toBe(true);
  });

  it('services and assignments can be configured while the counter is inactive', async () => {
    const s = await setup();
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/counters/${s.counterId}`, {
      active: false,
    });
    const assign = await s.org.admin.post<{ counter: { service_ids: string[]; active: boolean } }>(
      '/api/v1/counter_service_capabilities',
      { counter_id: s.counterId, service_id: s.serviceId },
    );
    expect(assign.status).toBe(201);
    expect(assign.body.counter).toMatchObject({ active: false, service_ids: [s.serviceId] });
    expect((await readiness(s.org.admin, s.fid)).configuration_ready).toBe(false);

    // …and removed again while inactive
    const del = await s.org.admin.del(
      `/api/v1/counter_service_capabilities/${s.counterId}/${s.serviceId}`,
    );
    expect(del.status).toBe(204);
  });

  it('assignments to an inactive service are allowed but never make the facility ready', async () => {
    const s = await setup();
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/services/${s.serviceId}`, {
      status: 'inactive',
    });
    const assign = await s.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: s.counterId,
      service_id: s.serviceId,
    });
    expect(assign.status).toBe(201);
    expect((await readiness(s.org.admin, s.fid)).configuration_ready).toBe(false);
  });

  it('the join link becomes operational only once a queue is open today for a served service', async () => {
    const s = await setup();
    await s.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: s.counterId,
      service_id: s.serviceId,
    });
    const r = await readiness(s.org.admin, s.fid);
    expect(r.configuration_ready).toBe(true);
    expect(r.visitor_join.operational).toBe(false);
    const link = await s.org.admin.get<{ join_link: { operational: boolean } }>(
      `/api/v1/facilities/${s.fid}/join-link`,
    );
    expect(link.body.join_link.operational).toBe(false);

    expect(
      (await s.org.admin.post(`/api/v1/facilities/${s.fid}/queues`, { service_id: s.serviceId }))
        .status,
    ).toBe(201);
    expect((await readiness(s.org.admin, s.fid)).visitor_join.operational).toBe(true);
    const live = await s.org.admin.get<{ join_link: { operational: boolean } }>(
      `/api/v1/facilities/${s.fid}/join-link`,
    );
    expect(live.body.join_link.operational).toBe(true);

    // Deactivating the only counter makes the link non-operational again
    await s.org.admin.patch(`/api/v1/facilities/${s.fid}/counters/${s.counterId}`, {
      active: false,
    });
    expect((await readiness(s.org.admin, s.fid)).visitor_join.operational).toBe(false);
  });

  it('is readable by every facility role, hidden from other facilities and organizations, and requires auth', async () => {
    const s = await setup();
    const auditor = await createStaff(t.app, s.org, s.fid, 'auditor');
    expect((await auditor.client.get(`/api/v1/facilities/${s.fid}/readiness`)).status).toBe(200);

    const f2 = (await createFacility(s.org, 'Other Site')).id;
    const otherAdmin = await createStaff(t.app, s.org, f2, 'facility_admin');
    expect((await otherAdmin.client.get(`/api/v1/facilities/${s.fid}/readiness`)).status).toBe(404);

    const foreign = await signupOrg(t.app);
    expect((await foreign.admin.get(`/api/v1/facilities/${s.fid}/readiness`)).status).toBe(404);
    expect((await new TestClient(t.app).get(`/api/v1/facilities/${s.fid}/readiness`)).status).toBe(
      401,
    );
  });

  it("readiness ignores another organization's identical configuration (no cross-tenant counting)", async () => {
    const a = await setup();
    const b = await setup();
    await b.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: b.counterId,
      service_id: b.serviceId,
    });
    expect((await readiness(b.org.admin, b.fid)).configuration_ready).toBe(true);
    expect((await readiness(a.org.admin, a.fid)).configuration_ready).toBe(false);
  });
});
