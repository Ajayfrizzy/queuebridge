import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFacility,
  createTestApp,
  signupOrg,
  uniqueSlug,
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

interface ServiceBody {
  service: {
    id: string;
    facility_id: string;
    name: string;
    description: string | null;
    status: string;
    policy: { version: string; priority_order: string[]; grace_window_seconds: number };
  };
}
interface CounterBody {
  counter: { id: string; name: string; active: boolean; service_ids: string[] };
}

async function setup(): Promise<{ org: TestOrg; fid: string }> {
  const org = await signupOrg(t.app);
  const f = await createFacility(org);
  return { org, fid: f.id };
}

describe('M1 journey: new org configures a facility without any DB access', () => {
  it('signup → facility → service → counter → capability → join link', async () => {
    const org = await signupOrg(t.app, 'Journey Health');

    const fac = await org.admin.post<{ facility: { id: string; slug: string; status: string } }>(
      '/api/v1/facilities',
      { name: 'Journey Clinic', slug: uniqueSlug('jc'), timezone: 'Africa/Lagos' },
    );
    expect(fac.status).toBe(201);
    expect(fac.body.facility.status).toBe('active');
    const fid = fac.body.facility.id;

    const svc = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'General Consultation',
      description: 'Walk-in consultations',
    });
    expect(svc.status).toBe(201);
    // Published default policy: FIFO within the normal class
    expect(svc.body.service.policy).toEqual({
      // M5.1 recovery fields default to the M2–M4 behaviour
      rejoin_policy: 'staff_resume',
      auto_miss: { enabled: false },
      staff_recovery: true,
      version: 'v1',
      priority_order: ['normal'],
      grace_window_seconds: 300,
      // M4: configured override reasons and transfer placement are part of the published policy
      override_reasons: [
        'accessibility_need',
        'urgent_need',
        'returning_visitor',
        'administrative_error',
      ],
      transfer_placement: 'by_original_join_time',
    });

    const ctr = await org.admin.post<CounterBody>(`/api/v1/facilities/${fid}/counters`, {
      name: 'Counter 1',
    });
    expect(ctr.status).toBe(201);
    expect(ctr.body.counter.service_ids).toEqual([]);

    const cap = await org.admin.post<CounterBody>('/api/v1/counter_service_capabilities', {
      counter_id: ctr.body.counter.id,
      service_id: svc.body.service.id,
    });
    expect(cap.status).toBe(201);
    expect(cap.body.counter.service_ids).toEqual([svc.body.service.id]);

    const list = await org.admin.get<{ counters: CounterBody['counter'][] }>(
      `/api/v1/facilities/${fid}/counters`,
    );
    expect(list.body.counters[0]?.service_ids).toEqual([svc.body.service.id]);

    const link = await org.admin.get<{ join_link: { path: string; url: string } }>(
      `/api/v1/facilities/${fid}/join-link`,
    );
    expect(link.status).toBe(200);
    expect(link.body.join_link.path).toBe(`/join/${org.slug}/${fac.body.facility.slug}`);
    expect(link.body.join_link.url).toBe(`http://localhost:5173${link.body.join_link.path}`);
  });
});

describe('facilities', () => {
  it('derives organization_id from the session, never from the body', async () => {
    const org = await signupOrg(t.app);
    const other = await signupOrg(t.app);
    const res = await org.admin.post('/api/v1/facilities', {
      name: 'Smuggle',
      slug: uniqueSlug('sm'),
      timezone: 'UTC',
      organization_id: other.organizationId,
    });
    expect(res.status).toBe(400);
    const rows =
      await t.db`SELECT 1 FROM facilities WHERE organization_id = ${other.organizationId}`;
    expect(rows).toHaveLength(0);
  });

  it('rejects an unknown time zone and a duplicate slug', async () => {
    const org = await signupOrg(t.app);
    const slug = uniqueSlug('dup');
    expect(
      (await org.admin.post('/api/v1/facilities', { name: 'Bad TZ', slug, timezone: 'Mars/Base' }))
        .status,
    ).toBe(400);
    expect((await org.admin.post('/api/v1/facilities', { name: 'First', slug })).status).toBe(201);
    expect((await org.admin.post('/api/v1/facilities', { name: 'Second', slug })).status).toBe(409);
  });

  it('allows the same facility slug in different organizations', async () => {
    const a = await signupOrg(t.app);
    const b = await signupOrg(t.app);
    const slug = uniqueSlug('shared');
    expect((await a.admin.post('/api/v1/facilities', { name: 'Main', slug })).status).toBe(201);
    expect((await b.admin.post('/api/v1/facilities', { name: 'Main', slug })).status).toBe(201);
  });

  it('lists only facilities of the caller organization', async () => {
    const a = await signupOrg(t.app);
    const b = await signupOrg(t.app);
    const fa = await createFacility(a);
    await createFacility(b);
    const res = await a.admin.get<{ facilities: { id: string }[] }>('/api/v1/facilities');
    expect(res.body.facilities.map((f) => f.id)).toEqual([fa.id]);
  });

  it('returns 404 for malformed and unknown facility ids alike', async () => {
    const org = await signupOrg(t.app);
    const bad = await org.admin.get('/api/v1/facilities/not-a-uuid');
    const unknown = await org.admin.get('/api/v1/facilities/018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b');
    expect(bad.status).toBe(404);
    expect(unknown.status).toBe(404);
  });
});

describe('services', () => {
  it('stores a custom ordering policy and validates it', async () => {
    const { org, fid } = await setup();
    const ok = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'Priority Desk',
      policy: {
        version: 'v2',
        priority_order: ['urgent', 'priority', 'normal'],
        grace_window_seconds: 120,
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.service.policy.priority_order).toEqual(['urgent', 'priority', 'normal']);

    const cases: [string, unknown][] = [
      ['no normal class', { priority_order: ['urgent'] }],
      ['repeated class', { priority_order: ['normal', 'normal'] }],
      ['unknown class', { priority_order: ['vip', 'normal'] }],
      ['negative grace', { grace_window_seconds: -1 }],
      ['unknown policy key', { fast_lane: true }],
    ];
    for (const [label, policy] of cases) {
      const res = await org.admin.post(`/api/v1/facilities/${fid}/services`, {
        name: `Bad ${label}`,
        policy,
      });
      expect(res.status, label).toBe(400);
    }
  });

  it('rejects duplicate names (case-insensitive) within a facility but not across facilities', async () => {
    const { org, fid } = await setup();
    const f2 = await createFacility(org, 'Second Clinic');
    expect(
      (await org.admin.post(`/api/v1/facilities/${fid}/services`, { name: 'Pharmacy' })).status,
    ).toBe(201);
    expect(
      (await org.admin.post(`/api/v1/facilities/${fid}/services`, { name: 'PHARMACY' })).status,
    ).toBe(409);
    expect(
      (await org.admin.post(`/api/v1/facilities/${f2.id}/services`, { name: 'Pharmacy' })).status,
    ).toBe(201);
  });

  it('updates name, status and policy; empty and unknown patches are rejected', async () => {
    const { org, fid } = await setup();
    const svc = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'Lab',
    });
    const id = svc.body.service.id;
    const upd = await org.admin.patch<ServiceBody>(`/api/v1/facilities/${fid}/services/${id}`, {
      name: 'Laboratory',
      status: 'inactive',
      policy: { version: 'v2', priority_order: ['priority', 'normal'], grace_window_seconds: 60 },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.service).toMatchObject({ name: 'Laboratory', status: 'inactive' });
    expect(upd.body.service.policy.version).toBe('v2');
    expect((await org.admin.patch(`/api/v1/facilities/${fid}/services/${id}`, {})).status).toBe(
      400,
    );
    expect(
      (await org.admin.patch(`/api/v1/facilities/${fid}/services/${id}`, { facility_id: fid }))
        .status,
    ).toBe(400);
  });
});

describe('counters and capabilities', () => {
  it('assigns multiple services to one counter and is idempotent', async () => {
    const { org, fid } = await setup();
    const s1 = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'S1',
    });
    const s2 = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'S2',
    });
    const c = await org.admin.post<CounterBody>(`/api/v1/facilities/${fid}/counters`, {
      name: 'C1',
    });
    const body = (s: ServiceBody): object => ({
      counter_id: c.body.counter.id,
      service_id: s.service.id,
    });

    expect(
      (await org.admin.post('/api/v1/counter_service_capabilities', body(s1.body))).status,
    ).toBe(201);
    expect(
      (await org.admin.post('/api/v1/counter_service_capabilities', body(s2.body))).status,
    ).toBe(201);
    const again = await org.admin.post<CounterBody>(
      '/api/v1/counter_service_capabilities',
      body(s1.body),
    );
    expect(again.status).toBe(200);
    expect(again.body.counter.service_ids.sort()).toEqual(
      [s1.body.service.id, s2.body.service.id].sort(),
    );

    const rows =
      await t.db`SELECT 1 FROM counter_service_capabilities WHERE counter_id = ${c.body.counter.id}`;
    expect(rows).toHaveLength(2);
  });

  it('removes a capability and 404s when it is not assigned', async () => {
    const { org, fid } = await setup();
    const s = await org.admin.post<ServiceBody>(`/api/v1/facilities/${fid}/services`, {
      name: 'Svc 1',
    });
    const c = await org.admin.post<CounterBody>(`/api/v1/facilities/${fid}/counters`, {
      name: 'Desk 1',
    });
    await org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: c.body.counter.id,
      service_id: s.body.service.id,
    });
    const url = `/api/v1/counter_service_capabilities/${c.body.counter.id}/${s.body.service.id}`;
    expect((await org.admin.del(url)).status).toBe(204);
    expect((await org.admin.del(url)).status).toBe(404);
  });

  it('refuses to link a counter and a service from different facilities of one org', async () => {
    const { org, fid } = await setup();
    const f2 = await createFacility(org, 'Other Site');
    const s2 = await org.admin.post<ServiceBody>(`/api/v1/facilities/${f2.id}/services`, {
      name: 'Elsewhere',
    });
    const c1 = await org.admin.post<CounterBody>(`/api/v1/facilities/${fid}/counters`, {
      name: 'Here',
    });
    const res = await org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: c1.body.counter.id,
      service_id: s2.body.service.id,
    });
    expect(res.status).toBe(404);
    const rows =
      await t.db`SELECT 1 FROM counter_service_capabilities WHERE counter_id = ${c1.body.counter.id}`;
    expect(rows).toHaveLength(0);
  });

  it('counter names are unique per facility; counters can be renamed and deactivated', async () => {
    const { org, fid } = await setup();
    const c = await org.admin.post<CounterBody>(`/api/v1/facilities/${fid}/counters`, {
      name: 'Desk A',
    });
    expect(
      (await org.admin.post(`/api/v1/facilities/${fid}/counters`, { name: 'desk a' })).status,
    ).toBe(409);
    const upd = await org.admin.patch<CounterBody>(
      `/api/v1/facilities/${fid}/counters/${c.body.counter.id}`,
      {
        name: 'Desk B',
        active: false,
      },
    );
    expect(upd.status).toBe(200);
    expect(upd.body.counter).toMatchObject({ name: 'Desk B', active: false });
  });
});

describe('administrative audit trail', () => {
  it('records configuration changes with actor and without PII or secrets', async () => {
    const { org, fid } = await setup();
    await org.admin.post(`/api/v1/facilities/${fid}/services`, { name: 'Audited Service' });
    await org.admin.post(`/api/v1/facilities/${fid}/invitations`, {
      email: 'audited.person@example.test',
      role: 'staff_counter',
    });
    const events = await t.db<{ event_type: string; actor_id: string; details: unknown }[]>`
      SELECT event_type, actor_id, details FROM admin_events
       WHERE organization_id = ${org.organizationId} ORDER BY created_at`;
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'organization.created',
        'facility.created',
        'service.created',
        'invitation.created',
      ]),
    );
    for (const e of events) expect(e.actor_id).toBe(org.adminId);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('audited.person@example.test');
    expect(dump).not.toMatch(/token|password/i);
  });
});
