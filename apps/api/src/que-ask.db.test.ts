import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  QUE_AI_CONSENT_VERSION,
  QueAnswerSchema,
  type QueAiSettings,
  type QueAnswer,
} from '@queuebridge/contracts';
import {
  TestClient,
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';
import { askQue } from './que/ask.js';
import { buildCapabilityManifest, capabilityFlags } from './que/capabilities.js';
import { SandboxInferenceAdapter } from './que/inference.js';
import { loadKnowledgeBase } from './que/kb.js';
import { parseEnv } from './env.js';

/**
 * MQ.4 — optional AI explanation layer against real PostgreSQL sessions, roles and audit
 * (design §11.7; REQ-F13.4, F13.6, F13.7, F13.9). The only adapter that can run is the TEST-ONLY
 * sandbox; nothing leaves the machine.
 */

const SANDBOX = {
  QUE_AI_ADAPTER: 'sandbox',
  QUE_AI_ENABLED: 'true',
  QUE_AI_COST_MODE: 'free_tier',
  QUE_AI_DAILY_CAP: '100000',
  QUE_AI_TIMEOUT_MS: '500',
  QUE_AI_RATE_LIMIT_MAX: '1000',
};

let off: TestApp;
let ai: TestApp;
let org: TestOrg;
let fac: { id: string; slug: string };
let other: { id: string; slug: string };

beforeAll(async () => {
  off = await createTestApp();
  ai = await createTestApp(SANDBOX);
  org = await signupOrg(ai.app, 'AI Org');
  fac = await createFacility(org, 'AI Clinic');
  other = await createFacility(org, 'Other Clinic');
});
afterAll(async () => {
  await off.close();
  await ai.close();
});

/** A client signed in on the app under test (sessions live in the shared database). */
function on(t: TestApp, c: TestClient): TestClient {
  const x = new TestClient(t.app);
  x.cookie = c.cookie;
  return x;
}

async function optIn(
  t: TestApp,
  admin: TestClient,
  facilityId: string,
  enabled = true,
): Promise<number> {
  const r = await on(t, admin).request(
    'PUT',
    `/api/v1/facilities/${facilityId}/que-ai`,
    enabled
      ? { enabled, consent_version: QUE_AI_CONSENT_VERSION, consent_acknowledged: true }
      : { enabled },
  );
  return r.status;
}

async function ask(
  t: TestApp,
  c: TestClient,
  question: string,
  facilityId = fac.id,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: QueAnswer & Record<string, unknown> }> {
  const r = await on(t, c).post<QueAnswer & Record<string, unknown>>('/api/v1/que/ask', {
    question,
    facility_id: facilityId,
    ...extra,
  });
  return { status: r.status, body: r.body };
}

async function orgCounts(t: TestApp, organizationId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [
    'queue_events',
    'tickets',
    'client_operations',
    'role_assignments',
    'staff_users',
  ]) {
    const [r] = await t.db.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${table} WHERE organization_id = $1`,
      [organizationId],
    );
    out[table] = Number(r?.n);
  }
  return out;
}

describe('default deployment: AI disabled', () => {
  it('answers with built-in help and fallbackReason ai_disabled, even when the facility opted in', async () => {
    expect(await optIn(off, org.admin, fac.id)).toBe(200);
    const s = await createStaff(off.app, org, fac.id, 'staff_counter');
    const r = await ask(off, s.client, 'what do the sync states mean');
    expect(r.status).toBe(200);
    expect(QueAnswerSchema.parse(r.body)).toEqual(r.body);
    expect(r.body.mode).toBe('deterministic');
    expect(r.body.fallbackReason).toBe('ai_disabled');
    expect(r.body.citations).toContain('staff.sync.states');
    const settings = (
      await on(off, s.client).get<QueAiSettings>(`/api/v1/facilities/${fac.id}/que-ai`)
    ).body;
    expect(settings).toMatchObject({
      opted_in: true,
      deployment_available: false,
      available: false,
    });
  });

  it('the manifest reports AI as built but switched off (never live + available)', async () => {
    const m = (
      await new TestClient(off.app).get<{ capabilities: Record<string, unknown> }>(
        '/api/v1/que/capabilities',
      )
    ).body;
    expect(m.capabilities['ask_que_ai']).toEqual({
      status: 'live',
      availability: 'unavailable',
      unavailableReason: 'switched_off',
      since: 'MQ',
      note: 'AI explanations are switched off here; built-in help is available.',
    });
  });

  it.each([
    ['QUE_AI_ENABLED=false', { ...SANDBOX, QUE_AI_ENABLED: 'false' }],
    ['QUE_AI_COST_MODE=none', { ...SANDBOX, QUE_AI_COST_MODE: 'none' }],
    ['QUE_AI_DAILY_CAP=0', { ...SANDBOX, QUE_AI_DAILY_CAP: '0' }],
  ])('the zero-cost guard keeps AI off with %s', async (_l, overrides) => {
    const t = await createTestApp(overrides);
    try {
      const s = await createStaff(t.app, org, fac.id, 'staff_counter');
      const r = await ask(t, s.client, 'what do the sync states mean');
      expect(r.body.fallbackReason).toBe('ai_disabled');
      const m = (
        await new TestClient(t.app).get<{ capabilities: Record<string, { availability: string }> }>(
          '/api/v1/que/capabilities',
        )
      ).body;
      expect(m.capabilities['ask_que_ai']?.availability).toBe('unavailable');
    } finally {
      await t.close();
    }
  });

  it('the sandbox adapter is refused in production', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
        SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
        QUE_AI_ADAPTER: 'sandbox',
      }),
    ).toThrow(/sandbox inference adapter is test-only/);
  });
});

describe('authentication, validation and facility scope', () => {
  it('anonymous and forged sessions get 401; a missing CSRF header gets 403', async () => {
    expect(
      (await new TestClient(ai.app).post('/api/v1/que/ask', { question: 'x', facility_id: fac.id }))
        .status,
    ).toBe(401);
    const forged = new TestClient(ai.app);
    forged.cookie = 'qb_session=forged';
    expect(
      (await forged.post('/api/v1/que/ask', { question: 'x', facility_id: fac.id })).status,
    ).toBe(401);
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    const noCsrf = await ai.app.inject({
      method: 'POST',
      url: '/api/v1/que/ask',
      headers: {
        cookie: s.client.cookie!,
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      payload: { question: 'x', facility_id: fac.id },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it.each([
    ['an extra field', { question: 'sync', facility_id: 'F', role: 'org_admin' }],
    ['an empty question', { question: '   ', facility_id: 'F' }],
    ['a question over 500 characters', { question: 'a'.repeat(501), facility_id: 'F' }],
    ['an unknown route', { question: 'sync', facility_id: 'F', route_id: 'supervisor.home' }],
    ['a malformed facility id', { question: 'sync', facility_id: 'not-a-uuid' }],
    ['a missing facility', { question: 'sync' }],
  ])('rejects %s with 400', async (_l, body) => {
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    const b = { ...body } as Record<string, unknown>;
    if (b['facility_id'] === 'F') b['facility_id'] = fac.id;
    expect((await on(ai, s.client).post('/api/v1/que/ask', b)).status).toBe(400);
  });

  it('a facility where the user has no role, or of another organization, is a 404', async () => {
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    expect((await ask(ai, s.client, 'sync', other.id)).status).toBe(404);
    const o2 = await signupOrg(ai.app, 'Foreign Org');
    const f2 = await createFacility(o2, 'Foreign Clinic');
    expect((await ask(ai, s.client, 'sync', f2.id)).status).toBe(404);
    expect((await on(ai, s.client).get(`/api/v1/facilities/${f2.id}/que-ai`)).status).toBe(404);
  });
});

describe('facility opt-in (admin-only, audited, consent required)', () => {
  const events = async (
    facilityId: string,
  ): Promise<{ event_type: string; details: Record<string, unknown> }[]> =>
    ai.db<{ event_type: string; details: Record<string, unknown> }[]>`
      SELECT event_type, details FROM admin_events
       WHERE facility_id = ${facilityId} AND event_type LIKE 'que_ai.%' ORDER BY created_at`;

  it('is off by default', async () => {
    const f = await createFacility(org, 'Fresh Clinic');
    const s = (await on(ai, org.admin).get<QueAiSettings>(`/api/v1/facilities/${f.id}/que-ai`))
      .body;
    expect(s).toEqual({
      opted_in: false,
      deployment_available: true,
      available: false,
      consent_version: null,
      consented_at: null,
    });
  });

  it.each(['staff_reception', 'staff_counter', 'supervisor', 'auditor'])(
    '%s cannot change it (403)',
    async (role) => {
      const f = await createFacility(org, `Role ${role}`);
      const s = await createStaff(ai.app, org, f.id, role);
      expect(await optIn(ai, s.client, f.id)).toBe(403);
      expect(await optIn(ai, s.client, f.id, false)).toBe(403);
    },
  );

  it('facility admin and org admin can; enabling needs the current consent; changes are audited', async () => {
    const f = await createFacility(org, 'Consent Clinic');
    const fa = await createStaff(ai.app, org, f.id, 'facility_admin');
    const put = (b: unknown): Promise<{ status: number }> =>
      on(ai, fa.client).request('PUT', `/api/v1/facilities/${f.id}/que-ai`, b);
    expect((await put({ enabled: true })).status).toBe(400);
    expect(
      (
        await put({
          enabled: true,
          consent_version: 'que-ai-consent-v0',
          consent_acknowledged: true,
        })
      ).status,
    ).toBe(400);
    expect((await put({ enabled: true, consent_version: QUE_AI_CONSENT_VERSION })).status).toBe(
      400,
    );
    expect(
      (
        await put({
          enabled: true,
          consent_version: QUE_AI_CONSENT_VERSION,
          consent_acknowledged: true,
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(await events(f.id)).toEqual([]);

    expect(await optIn(ai, fa.client, f.id)).toBe(200);
    const s = (await on(ai, fa.client).get<QueAiSettings>(`/api/v1/facilities/${f.id}/que-ai`))
      .body;
    expect(s).toMatchObject({
      opted_in: true,
      available: true,
      consent_version: QUE_AI_CONSENT_VERSION,
    });
    expect(Number.isNaN(Date.parse(s.consented_at ?? ''))).toBe(false);
    expect(await optIn(ai, fa.client, f.id)).toBe(200); // no-op: not audited again
    expect(await optIn(ai, org.admin, f.id, false)).toBe(200);
    const ev = await events(f.id);
    expect(ev.map((e) => e.event_type)).toEqual(['que_ai.enabled', 'que_ai.disabled']);
    expect(ev[0]?.details).toEqual({
      consent_version: QUE_AI_CONSENT_VERSION,
      deployment_available: true,
    });
    expect(JSON.stringify(ev)).not.toMatch(/@|Staff |AI Org/);
  });

  it('the database refuses "on" without a recorded consent', async () => {
    const f = await createFacility(org, 'Check Clinic');
    await expect(
      ai.db`INSERT INTO facility_que_ai_settings (facility_id, organization_id, enabled, updated_by)
            VALUES (${f.id}, ${org.organizationId}, TRUE, ${org.adminId})`,
    ).rejects.toThrow(/facility_que_ai_consent_chk/);
  });
  it("the database refuses a row whose organization is not the facility's own", async () => {
    const o2 = await signupOrg(ai.app, 'Mismatch Org');
    const f = await createFacility(org, 'Mismatch Clinic');
    await expect(
      ai.db`INSERT INTO facility_que_ai_settings (facility_id, organization_id, enabled, updated_by)
            VALUES (${f.id}, ${o2.organizationId}, FALSE, ${org.adminId})`,
    ).rejects.toThrow(/facility_que_ai_settings_facility_org_fk/);
  });

  it('another organization cannot read or change it (404)', async () => {
    const o2 = await signupOrg(ai.app, 'Intruder Org');
    expect((await on(ai, o2.admin).get(`/api/v1/facilities/${fac.id}/que-ai`)).status).toBe(404);
    expect(await optIn(ai, o2.admin, fac.id)).toBe(404);
  });
});

describe('sandbox AI explanations and the output guard', () => {
  beforeAll(async () => {
    expect(await optIn(ai, org.admin, fac.id)).toBe(200);
  });

  it('a grounded explanation is returned as mode "ai", citing only authorized articles, with server links', async () => {
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    const r = await ask(ai, s.client, 'what do the sync states mean');
    expect(r.status).toBe(200);
    expect(QueAnswerSchema.parse(r.body)).toEqual(r.body);
    expect(r.body.mode).toBe('ai');
    expect(r.body.fallbackReason).toBeUndefined();
    expect(r.body.citations).toEqual(['staff.sync.states']);
    expect(r.body.text).toMatch(/^What the sync states mean:/);
    expect(r.body.text).not.toMatch(/<|>|https?:|route:/);
    // Links come from the server and are permitted for this user (counter: no connectivity)
    expect(r.body.links).not.toContain('staff.connectivity');
  });

  it('a facility that has not opted in gets built-in help (ai_disabled)', async () => {
    const f = await createFacility(org, 'No Opt-in Clinic');
    const s = await createStaff(ai.app, org, f.id, 'staff_counter');
    const r = await ask(ai, s.client, 'what do the sync states mean', f.id);
    expect(r.body).toMatchObject({ mode: 'deterministic', fallbackReason: 'ai_disabled' });
  });

  it.each([
    ['sandbox:inject', 'validation_failed'],
    ['sandbox:uncited', 'validation_failed'],
    ['sandbox:foreign', 'validation_failed'],
    ['sandbox:capability', 'validation_failed'],
    ['sandbox:link', 'validation_failed'],
    ['sandbox:number', 'validation_failed'],
    ['sandbox:error', 'provider_error'],
    ['sandbox:quota', 'quota'],
    ['sandbox:timeout', 'timeout'],
  ])('%s falls back to built-in help (%s)', async (marker, reason) => {
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    const started = Date.now();
    const r = await ask(ai, s.client, `what do the sync states mean ${marker}`);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('deterministic');
    expect(r.body.fallbackReason).toBe(reason);
    expect(r.body.citations).toContain('staff.sync.states');
    expect(JSON.stringify(r.body)).not.toMatch(
      /cancelled the ticket|SMS|example\.com|7 minutes|staff\.secret/,
    );
    if (marker === 'sandbox:timeout') expect(Date.now() - started).toBeLessThan(5000);
  });

  it('with nothing authorized to explain, the adapter is not called (validation_failed)', async () => {
    const s = await createStaff(ai.app, org, fac.id, 'staff_counter');
    const [before] = await ai.db<
      { requests: number }[]
    >`SELECT coalesce(sum(requests), 0)::int AS requests FROM que_ai_daily_usage`;
    const r = await ask(ai, s.client, 'zzqx unrelated words');
    expect(r.body).toMatchObject({
      mode: 'deterministic',
      fallbackReason: 'validation_failed',
      citations: [],
    });
    const [after] = await ai.db<
      { requests: number }[]
    >`SELECT coalesce(sum(requests), 0)::int AS requests FROM que_ai_daily_usage`;
    expect(after?.requests).toBe(before?.requests);
  });

  it('auditors and visitors-only content: AI never cites an article the user may not read', async () => {
    const s = await createStaff(ai.app, org, fac.id, 'auditor');
    const r = await ask(ai, s.client, 'verification questions recovery no key');
    expect(r.body.citations).not.toContain('staff.recovery.assist');
  });

  it('asking changes no queue, ticket, operation, role or staff row', async () => {
    const s = await createStaff(ai.app, org, fac.id, 'supervisor');
    const before = await orgCounts(ai, org.organizationId);
    for (const q of ['what do the sync states mean', 'sandbox:inject sync', 'recover my ticket']) {
      await ask(ai, s.client, q);
    }
    expect(await orgCounts(ai, org.organizationId)).toEqual(before);
  });
});

describe('redaction, daily cap and rate limits', () => {
  it('the adapter receives only the redacted question and authorized generic articles', async () => {
    const adapter = new SandboxInferenceAdapter();
    const env = ai.env;
    const kb = loadKnowledgeBase();
    const outcome = await askQue(
      {
        db: ai.db,
        kb,
        adapter,
        manifest: buildCapabilityManifest(capabilityFlags(env), new Date()),
        deploymentAvailable: true,
        dailyCap: 100000,
        timeoutMs: 500,
      },
      {
        organizationId: org.organizationId,
        roles: [{ role: 'staff_counter', facility_id: fac.id }],
      },
      {
        question: 'sync states for ticket A123, email amaka@example.org, phone +234 803 123 4567',
        facility_id: fac.id,
      },
    );
    expect(outcome.answer.mode).toBe('ai');
    expect(outcome.redactions).toBe(3);
    const sent = JSON.stringify(adapter.lastParams);
    expect(sent).not.toMatch(/A123|amaka|example\.org|803/);
    expect(adapter.lastParams?.question).toContain('[redacted]');
    // Only articles a counter operator may read (public or counter audience), never others
    const readable = new Set(
      [...kb.bundles.visitor.articles, ...kb.bundles.counter.articles].map((a) => a.id),
    );
    expect(adapter.lastParams?.articles.length).toBeGreaterThan(0);
    for (const a of adapter.lastParams?.articles ?? []) {
      expect(readable.has(a.id), a.id).toBe(true);
      expect([
        'staff.audit.trail',
        'staff.recovery.approve',
        'staff.recovery.activity',
      ]).not.toContain(a.id);
    }
    expect(sent).not.toContain(fac.id);
    expect(sent).not.toContain(org.organizationId);
  });

  describe('the shared daily cap (hard stop, never overage)', () => {
    let capped: TestApp;
    beforeEach(async () => {
      await ai.db`DELETE FROM que_ai_daily_usage`;
    });
    afterAll(async () => {
      await capped?.close();
    });
    it('the third call on a cap of 2 falls back with quota, and the adapter is not called', async () => {
      capped = await createTestApp({ ...SANDBOX, QUE_AI_DAILY_CAP: '2' });
      const s = await createStaff(capped.app, org, fac.id, 'staff_counter');
      const modes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await ask(capped, s.client, 'what do the sync states mean');
        modes.push(r.body.fallbackReason ?? r.body.mode);
      }
      expect(modes).toEqual(['ai', 'ai', 'quota']);
      const [row] = await capped.db<
        { requests: number }[]
      >`SELECT requests FROM que_ai_daily_usage`;
      expect(row?.requests).toBe(2);
    });

    it('concurrent requests never exceed the cap', async () => {
      const t = await createTestApp({ ...SANDBOX, QUE_AI_DAILY_CAP: '3' });
      try {
        const clients = await Promise.all(
          Array.from({ length: 4 }, () => createStaff(t.app, org, fac.id, 'staff_counter')),
        );
        const results = await Promise.all(
          clients.flatMap((c) => [
            ask(t, c.client, 'sync states'),
            ask(t, c.client, 'sync states'),
          ]),
        );
        expect(results.filter((r) => r.body.mode === 'ai')).toHaveLength(3);
        expect(results.filter((r) => r.body.fallbackReason === 'quota')).toHaveLength(5);
      } finally {
        await t.close();
      }
    });
  });

  it('per-user and per-IP limits answer 429 with a plain message', async () => {
    const t = await createTestApp({ ...SANDBOX, QUE_AI_RATE_LIMIT_MAX: '2' });
    try {
      const s = await createStaff(t.app, org, fac.id, 'staff_counter');
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await ask(t, s.client, 'sync states')).status);
      // Per user: the third request in a minute is refused...
      expect(statuses).toEqual([200, 200, 429]);
      const refused = await on(t, s.client).post<{ detail: string }>('/api/v1/que/ask', {
        question: 'sync',
        facility_id: fac.id,
      });
      expect(refused.body.detail).toBe(
        'Wait a minute before asking again. Built-in help remains available.',
      );
      // ...while a colleague behind the same address still can (per-IP limit is 5x)
      const colleague = await createStaff(t.app, org, fac.id, 'staff_counter');
      expect((await ask(t, colleague.client, 'sync states')).status).toBe(200);
      // The per-IP limit still applies: 2 users x 2 + extra users reach 10 per minute
      const more = await Promise.all(
        Array.from({ length: 4 }, () => createStaff(t.app, org, fac.id, 'staff_counter')),
      );
      const ipStatuses: number[] = [];
      for (const m of more)
        for (let i = 0; i < 2; i++) ipStatuses.push((await ask(t, m.client, 'sync states')).status);
      expect(ipStatuses).toContain(429);
    } finally {
      await t.close();
    }
  });
});
