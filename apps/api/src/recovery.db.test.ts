import { createHash, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RecoverySecretSchema,
  formatRecoveryKey,
  normalizeRecoveryKey,
  uuidv7,
} from '@queuebridge/contracts';
import { createRecoveryCrypto } from './recovery/crypto.js';
import { targetKeys } from './recovery/throttle.js';
import {
  TEST_ORIGIN,
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  queueCommand,
  setupContinuity,
  setupQueue,
  ticketStatus,
  visitorJoin,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * M5.1 secure ticket recovery on real PostgreSQL (testing steering Group 8, items 8.R1–8.R8 and
 * 8.R11; design §15; ADR-015). Nothing is mocked: every request goes through the HTTP API.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh, random request source (throttle windows persist in the shared test database). */
const freshIp = (): string => `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;

interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
}
async function inject<T>(
  method: 'GET' | 'POST',
  url: string,
  opts: { body?: unknown; ip?: string; token?: string | undefined } = {},
): Promise<Res<T>> {
  const res = await t.app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? '127.0.0.1',
    headers: {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...(opts.token ? { 'x-qb-ticket-token': opts.token } : {}),
    },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as T };
}

type Recovered = { ticket?: { status_token: string; public_code: string }; type?: string };
const recover = (body: Record<string, unknown>, ip = freshIp()): Promise<Res<Recovered>> =>
  inject<Recovered>('POST', '/api/v1/tickets/recover', { body, ip });
const withKey = (
  q: QueueFixture,
  code: string,
  key: string,
): { org_slug: string; facility_slug: string; ticket_code: string; recovery_key: string } => ({
  org_slug: q.org.slug,
  facility_slug: q.facilitySlug,
  ticket_code: code,
  recovery_key: key,
});

interface Joined {
  code: string;
  token: string;
  key: string;
  ticketId: string;
}
async function join(q: QueueFixture): Promise<Joined> {
  const j = await visitorJoin(t.app, q.queueId);
  const tk = j.body.ticket;
  if (!tk || !tk.recovery_key) throw new Error(`join failed ${JSON.stringify(j.body)}`);
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${tk.public_code}`;
  return {
    code: tk.public_code,
    token: tk.status_token,
    key: tk.recovery_key,
    ticketId: row?.id ?? '',
  };
}
const canRead = async (code: string, token: string): Promise<boolean> =>
  (await ticketStatus(t.app, code, token)).status === 200;
const activeTokens = async (ticketId: string): Promise<number> =>
  (
    await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials
       WHERE ticket_id = ${ticketId} AND revoked_at IS NULL AND expires_at > NOW()`
  )[0]?.n ?? 0;
const wrongKey = (): string =>
  createRecoveryCrypto({ CONTACT_ENCRYPTION_KEY: 'ab'.repeat(32) })!.newSecret();
/** Problem documents compared without their per-request correlation id. */
const shape = (b: Record<string, unknown>): Record<string, unknown> => {
  const { instance: _i, ...rest } = b;
  return rest;
};
/** Everything that could hold a leaked secret, as one string. */
async function persisted(q: QueueFixture): Promise<string> {
  return JSON.stringify([
    await t.db`SELECT * FROM queue_events WHERE queue_session_id = ${q.queueId}`,
    await t.db`SELECT * FROM client_operations WHERE queue_session_id = ${q.queueId}`,
    await t.db`SELECT * FROM admin_events WHERE organization_id = ${q.org.organizationId}`,
    await t.db`SELECT * FROM ticket_recovery_proofs WHERE organization_id = ${q.org.organizationId}`,
    await t.db`SELECT * FROM ticket_recovery_grants WHERE organization_id = ${q.org.organizationId}`,
    await t.db`SELECT * FROM recovery_throttle`,
  ]);
}

// ---------------------------------------------------------------------------
// 8.R1 — the public ticket code alone never recovers
// ---------------------------------------------------------------------------

describe('8.R1 the public ticket code alone never yields a credential', () => {
  it('join issues a 160-bit recovery key once; the public recovery path contains no secret', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const j = await visitorJoin(t.app, q.queueId);
    const tk = j.body.ticket!;
    expect(RecoverySecretSchema.safeParse(tk.recovery_key).success).toBe(true);
    expect(tk.recovery_key).toHaveLength(32); // 32 × 5 bits = 160 bits
    expect(tk.recovery_path).toBe(`/recover/${q.org.slug}/${q.facilitySlug}/${tk.public_code}`);
    expect(tk.recovery_path).not.toContain(tk.recovery_key);
    expect(tk.recovery_path).not.toContain(tk.status_token);
  });

  it('code + facility without the key, with a wrong key, or as a bare status read: nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const noKey = await recover({
      org_slug: q.org.slug,
      facility_slug: q.facilitySlug,
      ticket_code: v.code,
    });
    expect(noKey.status).toBe(400);
    expect((await recover(withKey(q, v.code, wrongKey()))).status).toBe(404);
    expect((await recover(withKey(q, v.code, v.code.padEnd(32, '0')))).status).toBe(404);
    expect((await ticketStatus(t.app, v.code, undefined)).status).toBe(404);
    // still exactly the one credential issued at join
    expect(await activeTokens(v.ticketId)).toBe(1);
  });

  it('the right key with the public identifiers yields a NEW working token; the join token keeps working', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const r = await recover(withKey(q, v.code, v.key));
    expect(r.status).toBe(200);
    expect(r.body.ticket?.public_code).toBe(v.code);
    const token = r.body.ticket?.status_token ?? '';
    expect(token).not.toBe(v.token);
    expect(await canRead(v.code, token)).toBe(true);
    expect(await canRead(v.code, v.token)).toBe(true);
    const [src] = await t.db<{ source: string }[]>`
      SELECT source FROM ticket_recovery_credentials
       WHERE ticket_id = ${v.ticketId} ORDER BY created_at DESC LIMIT 1`;
    expect(src?.source).toBe('recovery');
  });

  it('a typed key works: lower case, spaces and hyphens', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const typed = formatRecoveryKey(v.key).toLowerCase().replace(/-/g, ' - ');
    expect(normalizeRecoveryKey(typed)).toBe(v.key);
    expect((await recover(withKey(q, v.code, typed))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8.R2 — oracle-free failure
// ---------------------------------------------------------------------------

describe('8.R2 every failed recovery looks the same', () => {
  it('unknown code, wrong key, ended ticket, other facility and another ticket’s key are identical', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const other = await setupQueue(t.app, { counters: 1 });
    const a = await join(q);
    const b = await join(q);
    const ended = await join(q);
    const foreign = await join(other);
    // end one ticket
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.cancel',
      ticket_id: ended.ticketId,
    });
    const cases = [
      await recover(withKey(q, 'Z999', a.key)), // unknown code
      await recover(withKey(q, a.code, wrongKey())), // wrong key
      await recover(withKey(q, ended.code, ended.key)), // ended (cancelled) ticket
      await recover(withKey(q, foreign.code, foreign.key)), // code/key of another facility
      await recover(withKey(q, a.code, b.key)), // a real key of a different ticket
      await recover({ ...withKey(q, a.code, a.key), facility_slug: 'no-such-facility' }),
    ];
    for (const c of cases) expect(c.status).toBe(404);
    const shapes = cases.map((c) => JSON.stringify(shape(c.body)));
    expect(new Set(shapes).size).toBe(1);
    expect(cases[0]?.body).toMatchObject({ title: 'Recovery failed' });
    expect(JSON.stringify(cases)).not.toMatch(/exist|cancel|ended|unknown/i);
  });

  it('a wrong key on a real ticket and any key on an unknown code take comparable time', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const time = async (body: Record<string, unknown>): Promise<number> => {
      const s = performance.now();
      await recover(body);
      return performance.now() - s;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 9; i++) {
      known.push(await time(withKey(q, v.code, wrongKey())));
      unknown.push(await time(withKey(q, 'Y998', wrongKey())));
    }
    const median = (xs: number[]): number => [...xs].sort((x, y) => x - y)[4] ?? 0;
    // Same queries and one HMAC on both paths; a loose bound that still catches an early exit
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------------------
// 8.R3 — throttling that the guess cannot evade and that never locks the holder out
// ---------------------------------------------------------------------------

describe('8.R3 throttling', () => {
  it('L1: the 11th attempt from one source within a minute is refused, malformed ones included', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await recover({ junk: true }, ip)).status);
    for (let i = 0; i < 6; i++) {
      statuses.push((await recover(withKey(q, `Q${100 + i}`, wrongKey()), ip)).status);
    }
    statuses.push((await recover(withKey(q, 'Q200', wrongKey()), ip)).status);
    expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
    expect(statuses.slice(4, 10)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(statuses[10]).toBe(429);
  });

  it('L2: the guess is not part of any key — five DIFFERENT wrong keys exhaust the per-ticket limit', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect((await recover(withKey(q, v.code, wrongKey()), ip)).status).toBe(404);
    }
    // A sixth, different guess is refused — and so is the RIGHT key from that same source
    expect((await recover(withKey(q, v.code, wrongKey()), ip)).status).toBe(429);
    expect((await recover(withKey(q, v.code, v.key), ip)).status).toBe(429);
    // The rightful holder on a clean source is not locked out
    expect((await recover(withKey(q, v.code, v.key), freshIp())).status).toBe(200);
  });

  it('L2 applies to codes that do not exist exactly as to real ones', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect((await recover(withKey(q, 'X777', wrongKey()), ip)).status).toBe(404);
    }
    expect((await recover(withKey(q, 'X777', wrongKey()), ip)).status).toBe(429);
  });

  it('L3: a distributed attack on one ticket refuses only sources that failed; the holder still gets in; an alert is recorded', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const attackers = Array.from({ length: 50 }, () => freshIp());
    for (const ip of attackers) {
      expect((await recover(withKey(q, v.code, wrongKey()), ip)).status).toBe(404);
    }
    expect((await recover(withKey(q, v.code, wrongKey()), attackers[0])).status).toBe(429);
    expect((await recover(withKey(q, v.code, v.key), freshIp())).status).toBe(200);
    const alerts = await t.db`
      SELECT details FROM admin_events
       WHERE organization_id = ${q.org.organizationId} AND event_type = 'ticket_recovery.abuse_detected'`;
    expect(alerts).toHaveLength(1);
  });

  it('L4: a facility-wide attack refuses sources with a recent failure there, never clean ones', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const attackers = Array.from({ length: 100 }, () => freshIp());
    // In batches below the per-process verification cap (L5), so every attempt is verified
    for (let b = 0; b < attackers.length; b += 20) {
      const rs = await Promise.all(
        attackers
          .slice(b, b + 20)
          .map((ip, i) => recover(withKey(q, `W${String(100 + b + i)}`, wrongKey()), ip)),
      );
      expect(rs.map((r) => r.status)).toEqual(rs.map(() => 404));
    }
    // an attacker that failed here is now refused even on a different ticket
    expect((await recover(withKey(q, v.code, wrongKey()), attackers[7])).status).toBe(429);
    // a clean source with the right key is verified as usual
    expect((await recover(withKey(q, v.code, v.key), freshIp())).status).toBe(200);
  });

  it('no irreversible lockout: every window expires by itself and there is no lock state at all', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await recover(withKey(q, v.code, wrongKey()), ip);
    expect((await recover(withKey(q, v.code, v.key), ip)).status).toBe(429);
    // 16 minutes later (windows are at most 15 minutes) the same source may try again
    const crypto = createRecoveryCrypto({ CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16) })!;
    const k = targetKeys(
      crypto,
      { orgSlug: q.org.slug, facilitySlug: q.facilitySlug, ticketCode: v.code },
      ip,
    );
    await t.db`UPDATE recovery_throttle SET window_started_at = window_started_at - INTERVAL '16 minutes'
                WHERE key_hash = ANY(${[k.source, k.targetSource, k.target, k.facility, k.facilitySource]})`;
    expect((await recover(withKey(q, v.code, v.key), ip)).status).toBe(200);
    const cols = await t.db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('ticket_recovery_proofs', 'ticket_recovery_credentials')`;
    expect(cols.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/lock|failed_total|failures/)]),
    );
  });
});

// ---------------------------------------------------------------------------
// 8.R4 — credential storage, cap and the rotation matrix
// ---------------------------------------------------------------------------

describe('8.R4 credentials', () => {
  it('the key is stored only as a peppered HMAC (no plaintext, no plain hash) and never elsewhere', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const [p] = await t.db<{ key_hmac: string }[]>`
      SELECT key_hmac FROM ticket_recovery_proofs WHERE ticket_id = ${v.ticketId}`;
    const plain = createHash('sha256').update(v.key).digest('hex');
    expect(p?.key_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(p?.key_hmac).not.toBe(plain);
    const otherPepper = createRecoveryCrypto({ CONTACT_ENCRYPTION_KEY: 'cd'.repeat(32) })!;
    expect(otherPepper.keyHmac(v.ticketId, v.key)).not.toBe(p?.key_hmac);
    await recover(withKey(q, v.code, wrongKey()));
    const everything = await persisted(q);
    expect(everything).not.toContain(v.key);
    expect(everything).not.toContain(v.token);
  });

  it('at most 3 active tokens: a 4th recovery revokes the oldest', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await recover(withKey(q, v.code, v.key));
      expect(r.status).toBe(200);
      tokens.push(r.body.ticket?.status_token ?? '');
    }
    expect(await activeTokens(v.ticketId)).toBe(3);
    expect(await canRead(v.code, v.token)).toBe(false); // the join token was the oldest
    for (const tok of tokens) expect(await canRead(v.code, tok)).toBe(true);
    const [cap] = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials
       WHERE ticket_id = ${v.ticketId} AND revoked_reason = 'cap'`;
    expect(cap?.n).toBe(1);
  });

  it('replacement key, sign-out-others and rejoin are unreachable with a public code alone or any wrong credential', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const other = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const sameCode = await join(other); // another tenant's ticket that shares the public code
    const foreign = await join(other); // another tenant's valid token for a different code
    expect(sameCode.code).toBe(v.code);
    expect(foreign.code).not.toBe(v.code);
    const revoked = await join(q);
    // a second device recovers, then signs the joining device out: `revoked.token` is now dead
    const second = await recover(withKey(q, revoked.code, revoked.key));
    expect(second.status).toBe(200);
    const out = await inject('POST', `/api/v1/tickets/${revoked.code}/sessions/revoke-others`, {
      body: {},
      token: second.body.ticket?.status_token,
    });
    expect(out.status).toBe(200);
    expect(await canRead(revoked.code, revoked.token)).toBe(false);
    const urls = [
      `/api/v1/tickets/${v.code}/recovery-key`,
      `/api/v1/tickets/${v.code}/sessions/revoke-others`,
    ];
    const credentials: (string | undefined)[] = [
      undefined, // the public code alone
      wrongKey(), // a well-formed but unknown token
      'not-a-token',
      foreign.token, // another tenant's valid token
      revoked.token, // a revoked token for another ticket
    ];
    for (const url of urls) {
      for (const token of credentials) {
        const r = await inject('POST', url, { body: {}, token });
        expect(r.status, `${url} with ${token ? 'a bad token' : 'no token'}`).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/[0-9A-HJKMNP-TV-Z]{32}/);
      }
    }
    // a token only ever acts on ITS OWN ticket, even where the public code is shared
    const own = await inject<{ recovery_key: string }>(
      'POST',
      `/api/v1/tickets/${sameCode.code}/recovery-key`,
      { body: {}, token: sameCode.token },
    );
    expect(own.status).toBe(200);
    expect((await recover(withKey(other, sameCode.code, own.body.recovery_key))).status).toBe(200);
    expect((await recover(withKey(q, v.code, own.body.recovery_key))).status).toBe(404);
    // a revoked token of the SAME ticket is refused as well
    const stale = await inject('POST', `/api/v1/tickets/${revoked.code}/recovery-key`, {
      body: {},
      token: revoked.token,
    });
    expect(stale.status).toBe(404);
    // nothing changed: the original key and token still work, and no key was regenerated
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(200);
    expect(await canRead(v.code, v.token)).toBe(true);
    const events = await t.db`
      SELECT 1 FROM admin_events WHERE organization_id = ${q.org.organizationId}
         AND event_type = 'ticket_recovery.key_regenerated'
         AND target_id = ${v.ticketId}`;
    expect(events).toHaveLength(0);
  });

  it('"get a new recovery key": the old key stops working, the new one works', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const r = await inject<{ recovery_key: string; recovery_path: string }>(
      'POST',
      `/api/v1/tickets/${v.code}/recovery-key`,
      { body: {}, token: v.token },
    );
    expect(r.status).toBe(200);
    expect(r.body.recovery_key).not.toBe(v.key);
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
    expect((await recover(withKey(q, v.code, r.body.recovery_key))).status).toBe(200);
  });

  it('"sign out other devices": every other token dies, this one lives, the key is replaced, others are told', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const other = (await recover(withKey(q, v.code, v.key))).body.ticket?.status_token ?? '';
    // the joining device is told that access was granted elsewhere
    const notice = await ticketStatus(t.app, v.code, v.token);
    expect(
      (notice.body.status?.['recovery'] as { access_granted_elsewhere_at: string | null })
        .access_granted_elsewhere_at,
    ).not.toBeNull();
    const r = await inject<{ revoked_tokens: number; recovery_key: string }>(
      'POST',
      `/api/v1/tickets/${v.code}/sessions/revoke-others`,
      { body: {}, token: v.token },
    );
    expect(r.status).toBe(200);
    expect(r.body.revoked_tokens).toBe(1);
    expect(await canRead(v.code, v.token)).toBe(true);
    expect(await canRead(v.code, other)).toBe(false);
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
    expect((await recover(withKey(q, v.code, r.body.recovery_key))).status).toBe(200);
  });

  it('a join replayed by its original requester rotates both the token and the key', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const first = await visitorJoin(t.app, q.queueId);
    const replay = await visitorJoin(t.app, q.queueId, {
      operationId: first.operationId,
      proof: first.proof,
    });
    expect(replay.body.ticket?.disposition).toBe('duplicate');
    const code = first.body.ticket!.public_code;
    expect(await canRead(code, first.body.ticket!.status_token)).toBe(false);
    expect(await canRead(code, replay.body.ticket!.status_token)).toBe(true);
    expect((await recover(withKey(q, code, first.body.ticket!.recovery_key!))).status).toBe(404);
    expect((await recover(withKey(q, code, replay.body.ticket!.recovery_key!))).status).toBe(200);
  });

  it('an expired token is refused like an unknown one', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await t.db`UPDATE ticket_recovery_credentials SET expires_at = NOW() - INTERVAL '1 second'
                WHERE ticket_id = ${v.ticketId}`;
    expect(await canRead(v.code, v.token)).toBe(false);
    // the key still works (keys belong to the ticket, not to a device)
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(200);
  });

  it('recovery follows a transfer: the original code and key open the current ticket', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const dest = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
    });
    const v = await join(q);
    const moved = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.transfer',
      ticket_id: v.ticketId,
      destination_service_id: dest.serviceId,
      reason_code: 'wrong_service',
    });
    expect(moved.body.outcome?.disposition).toBe('committed');
    const r = await recover(withKey(q, v.code, v.key));
    expect(r.status).toBe(200);
    expect(r.body.ticket?.public_code).not.toBe(v.code); // the destination ticket's code
  });
});

// ---------------------------------------------------------------------------
// 8.R5 — staff-assisted recovery is a restricted procedure
// ---------------------------------------------------------------------------

type AssistBody = {
  outcome?: 'restricted_assistance' | 'approval_required';
  request_id?: string;
  grant?: string;
  type?: string;
};
const assist = (
  c: TestClient,
  q: QueueFixture,
  ticketId: string,
  accountMatches: boolean,
): Promise<{ status: number; body: AssistBody }> =>
  c.post<AssistBody>(`/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery/assist`, {
    reason_code: 'lost_device',
    account_matches: accountMatches,
    asked_before_revealing: true,
  });
const approve = (
  c: TestClient,
  q: QueueFixture,
  ticketId: string,
  requestId: string,
): Promise<{ status: number; body: { status?: string; type?: string } }> =>
  c.post(`/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery/approve`, {
    request_id: requestId,
  });

describe('8.R5 staff-assisted recovery', () => {
  it('no verified factor: restricted assistance only — no grant, no token, audited', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const r = await assist(counter.client, q, v.ticketId, false);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: 'restricted_assistance' });
    expect(
      await t.db`SELECT 1 FROM ticket_recovery_grants WHERE ticket_id = ${v.ticketId}`,
    ).toHaveLength(0);
    expect(await activeTokens(v.ticketId)).toBe(1);
    const [ev] = await t.db<{ details: Record<string, unknown>; actor_id: string }[]>`
      SELECT details, actor_id FROM admin_events
       WHERE target_id = ${v.ticketId} AND event_type = 'ticket_recovery.restricted_assistance'`;
    expect(ev?.details).toMatchObject({ reason_code: 'lost_device', account_matches: false });
  });

  it('basic factor: unusable until a DIFFERENT manager approves; single use; never the requester', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId, true);
    expect(a.body.outcome).toBe('approval_required');
    const grant = a.body.grant ?? '';
    expect(RecoverySecretSchema.safeParse(grant).success).toBe(true);
    // not redeemable before approval
    expect((await recover({ grant })).status).toBe(404);
    // the requester cannot approve, and a counter operator cannot approve at all
    expect((await approve(counter.client, q, v.ticketId, a.body.request_id ?? '')).status).toBe(
      403,
    );
    // a supervisor who made a request cannot approve their own either
    const own = await assist(sup.client, q, v.ticketId, true);
    expect((await approve(sup.client, q, v.ticketId, own.body.request_id ?? '')).body.type).toMatch(
      /second-person-required/,
    );
    expect((await approve(sup.client, q, v.ticketId, a.body.request_id ?? '')).status).toBe(200);
    const r = await recover({ grant });
    expect(r.status).toBe(200);
    expect(await canRead(v.code, r.body.ticket?.status_token ?? '')).toBe(true);
    // single use
    expect((await recover({ grant })).status).toBe(404);
    const [g] = await t.db<{ approved_by: string; created_by: string; redeemed_at: Date | null }[]>`
      SELECT approved_by, created_by, redeemed_at FROM ticket_recovery_grants WHERE id = ${a.body.request_id ?? ''}`;
    expect(g?.approved_by).not.toBe(g?.created_by);
    expect(g?.redeemed_at).not.toBeNull();
  });

  it('the database itself refuses self-approval and redeeming an unapproved low-assurance grant', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const a = await assist(counter.client, q, v.ticketId, true);
    const id = a.body.request_id ?? '';
    await expect(
      t.db`UPDATE ticket_recovery_grants SET approved_by = created_by, approved_at = NOW() WHERE id = ${id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db`UPDATE ticket_recovery_grants SET redeemed_at = NOW() WHERE id = ${id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('roles: reception and counter may assist; auditors and anonymous callers may not', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const reception = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
    expect((await assist(reception.client, q, v.ticketId, false)).status).toBe(200);
    expect((await assist(auditor.client, q, v.ticketId, true)).status).toBe(403);
    const anon = await inject(
      'POST',
      `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/assist`,
      {
        body: { reason_code: 'other', account_matches: true, asked_before_revealing: true },
      },
    );
    expect(anon.status).toBe(401);
    // the procedure cannot be invoked without confirming the questions came first
    const r = await reception.client.post(
      `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/assist`,
      { reason_code: 'other', account_matches: true },
    );
    expect(r.status).toBe(400);
  });

  it('expired and revoked grants do nothing; a facility can switch the path off', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId, true);
    await approve(sup.client, q, v.ticketId, a.body.request_id ?? '');
    await t.db`UPDATE ticket_recovery_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${a.body.request_id ?? ''}`;
    expect((await recover({ grant: a.body.grant ?? '' })).status).toBe(404);
    const off = await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
      policy: { staff_recovery: false },
    });
    expect(off.status).toBe(200);
    const r = await assist(counter.client, q, v.ticketId, true);
    expect(r.status).toBe(409);
    expect(r.body.type).toMatch(/staff-recovery-disabled/);
  });

  it('limits: at most 3 requests per ticket per hour', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const reception = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    for (let i = 0; i < 3; i++) {
      expect(
        (await assist(i % 2 ? reception.client : counter.client, q, v.ticketId, true)).status,
      ).toBe(200);
    }
    const fourth = await assist(reception.client, q, v.ticketId, true);
    expect(fourth.status).toBe(429);
  });

  it('staff revoke-all: every token, pending grant and the recovery key stop working', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId, true);
    await approve(sup.client, q, v.ticketId, a.body.request_id ?? '');
    const r = await counter.client.post<{ revoked_tokens: number }>(
      `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/revoke-all`,
      { reason_code: 'stolen_device' },
    );
    expect(r.status).toBe(200);
    expect(r.body.revoked_tokens).toBe(1);
    expect(await canRead(v.code, v.token)).toBe(false);
    expect((await recover({ grant: a.body.grant ?? '' })).status).toBe(404);
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
  });

  it('audit records actor, approver, reason and assurance — never a secret', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId, true);
    await approve(sup.client, q, v.ticketId, a.body.request_id ?? '');
    const rec = await recover({ grant: a.body.grant ?? '' });
    const events = await t.db<
      { event_type: string; actor_id: string | null; details: Record<string, unknown> }[]
    >`
      SELECT event_type, actor_id, details FROM admin_events
       WHERE target_id = ${v.ticketId} ORDER BY created_at`;
    expect(events.map((e) => e.event_type)).toEqual([
      'ticket_recovery.assist',
      'ticket_recovery.approved',
      'ticket_recovery.recovered',
    ]);
    expect(events[0]).toMatchObject({
      actor_id: counter.userId,
      details: { reason_code: 'lost_device', assurance: 'basic', account_matches: true },
    });
    expect(events[1]?.actor_id).toBe(sup.userId);
    expect(events[2]?.details).toMatchObject({ method: 'staff_grant', assurance: 'basic' });
    const all = await persisted(q);
    expect(all).not.toContain(a.body.grant);
    expect(all).not.toContain(rec.body.ticket?.status_token);
  });
});

// ---------------------------------------------------------------------------
// 8.R6 — recovery never touches the queue
// ---------------------------------------------------------------------------

describe('8.R6 queue neutrality', () => {
  it('no recovery action appends an event or changes state, position or waiting age', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await join(q);
    const snap = async (): Promise<unknown> => [
      await t.db`SELECT revision, last_sequence FROM queue_sessions WHERE id = ${q.queueId}`,
      await t.db`SELECT id, state, wait_since, issued_sequence, priority_class, version FROM tickets
                  WHERE queue_session_id = ${q.queueId} ORDER BY id`,
    ];
    const before = await snap();
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    await recover(withKey(q, v.code, wrongKey()));
    const r = await recover(withKey(q, v.code, v.key));
    await inject('POST', `/api/v1/tickets/${v.code}/recovery-key`, { body: {}, token: v.token });
    await inject('POST', `/api/v1/tickets/${v.code}/sessions/revoke-others`, {
      body: {},
      token: r.body.ticket?.status_token ?? '',
    });
    await assist(counter.client, q, v.ticketId, false);
    const a = await assist(counter.client, q, v.ticketId, true);
    await approve(sup.client, q, v.ticketId, a.body.request_id ?? '');
    await recover({ grant: a.body.grant ?? '' });
    await counter.client.post(
      `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/revoke-all`,
      {
        reason_code: 'other',
      },
    );
    expect(await snap()).toEqual(before);
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('recovery works while an offline coordinator holds the queue, and does not disturb it', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await join(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const [before] =
      await t.db`SELECT coordinator_epoch, coordinator_device_id, revision FROM queue_sessions WHERE id = ${f.queueId}`;
    expect((await recover(withKey(f, v.code, v.key))).status).toBe(200);
    const [after] =
      await t.db`SELECT coordinator_epoch, coordinator_device_id, revision FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 8.R7 — concurrency on real transactions
// ---------------------------------------------------------------------------

describe('8.R7 concurrency', () => {
  it('parallel correct recoveries all succeed and the cap still holds', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => recover(withKey(q, v.code, v.key))),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await activeTokens(v.ticketId)).toBe(3);
  });

  it('parallel wrong guesses from one source are counted exactly (no lost updates)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ip = freshIp();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => recover(withKey(q, v.code, wrongKey()), ip)),
    );
    const throttled = rs.filter((r) => r.status === 429).length;
    const failed = rs.filter((r) => r.status === 404).length;
    expect(throttled + failed).toBe(20);
    // L1 admits exactly 10 per minute; L2 then stops this source after 5 failures for the ticket
    expect(failed).toBeLessThanOrEqual(10);
    const crypto = createRecoveryCrypto({ CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16) })!;
    const [src] = await t.db<{ attempts: number }[]>`
      SELECT attempts FROM recovery_throttle WHERE scope = 'source' AND key_hash = ${crypto.throttleKey('source', ip)}`;
    expect(src?.attempts).toBe(20); // every attempt counted, none lost
  });

  it('a grant redeemed twice at the same time opens the ticket exactly once', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId, true);
    await approve(sup.client, q, v.ticketId, a.body.request_id ?? '');
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => recover({ grant: a.body.grant ?? '' })),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('recovery racing "new recovery key": the old key never works after the new one exists', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const [rec, regen] = await Promise.all([
      recover(withKey(q, v.code, v.key)),
      inject<{ recovery_key: string }>('POST', `/api/v1/tickets/${v.code}/recovery-key`, {
        body: {},
        token: v.token,
      }),
    ]);
    expect([200, 404]).toContain(rec.status);
    expect(regen.status).toBe(200);
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 8.R8 — grace window and rejoin policy
// ---------------------------------------------------------------------------

describe('8.R8 grace and rejoin', () => {
  async function missedTicket(): Promise<{ q: QueueFixture; v: Joined }> {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    const m = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.miss',
      ticket_id: v.ticketId,
    });
    expect(m.body.outcome?.disposition).toBe('committed');
    return { q, v };
  }
  const rejoin = (
    v: Joined,
    opId = uuidv7(),
  ): Promise<Res<{ outcome?: { disposition: string; reason_code: string | null } }>> =>
    inject('POST', `/api/v1/tickets/${v.code}/rejoin`, {
      body: { operation_id: opId },
      token: v.token,
    });

  it('default policy (staff_resume): the visitor cannot rejoin; the M2 behaviour is unchanged', async () => {
    const { v } = await missedTicket();
    const r = await rejoin(v);
    expect(r.status).toBe(409);
    expect(r.body.outcome?.reason_code).toBe('rejoin_not_allowed');
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('missed');
    const s = await ticketStatus(t.app, v.code, v.token);
    expect((s.body.status?.['recovery'] as { rejoin_available: boolean }).rejoin_available).toBe(
      false,
    );
  });

  it('self_resume inside the grace window: back to waiting through the standard command path, idempotently', async () => {
    const { q, v } = await missedTicket();
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
      policy: { rejoin_policy: 'self_resume' },
    });
    const s = await ticketStatus(t.app, v.code, v.token);
    expect((s.body.status?.['recovery'] as { rejoin_available: boolean }).rejoin_available).toBe(
      true,
    );
    const op = uuidv7();
    const r = await rejoin(v, op);
    expect(r.status).toBe(200);
    expect(r.body.outcome?.disposition).toBe('committed');
    expect((await rejoin(v, op)).body.outcome?.disposition).toBe('duplicate');
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('waiting');
    const [ev] = await t.db<{ actor_id: string | null; payload: Record<string, unknown> }[]>`
      SELECT actor_id, payload FROM queue_events
       WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.resume'`;
    expect(ev?.actor_id).toBeNull();
    expect(ev?.payload).toMatchObject({
      actor_kind: 'visitor_self',
      from_state: 'missed',
      to_state: 'waiting',
    });
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('after the grace window the visitor is told to join again; nothing changes', async () => {
    const { q, v } = await missedTicket();
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
      policy: { rejoin_policy: 'self_resume' },
    });
    await t.db`UPDATE tickets SET missed_at = NOW() - INTERVAL '2 hours' WHERE id = ${v.ticketId}`;
    const r = await rejoin(v);
    expect(r.status).toBe(409);
    expect(r.body.outcome?.reason_code).toBe('grace_window_expired');
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('missed');
  });

  it('refused while an offline coordinator holds the queue (M3 fence)', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await join(f);
    await queueCommand(f.supervisor.client, f.queueId, {
      action: 'ticket.call_next',
      counter_id: f.counterIds[0],
    });
    await queueCommand(f.supervisor.client, f.queueId, {
      action: 'ticket.miss',
      ticket_id: v.ticketId,
    });
    await f.org.admin.patch(`/api/v1/facilities/${f.fid}/services/${f.serviceId}`, {
      policy: { rejoin_policy: 'self_resume' },
    });
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const r = await rejoin(v);
    expect(r.status).toBe(409);
    expect((r.body as { type?: string }).type).toMatch(/coordinator-active/);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('missed');
  });

  it('the grace setting is unchanged: default 300 s', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [s] = await t.db<
      { policy: { grace_window_seconds: number } }[]
    >`SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(s?.policy.grace_window_seconds).toBe(300);
  });

  it('re-saving unchanged rules after M5.1 creates no new policy version (ADR-012)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    // a policy stored before M5.1 has none of the new fields
    await t.db`UPDATE services SET policy = policy - 'rejoin_policy' - 'auto_miss' - 'staff_recovery' WHERE id = ${q.serviceId}`;
    const r = await q.org.admin.patch<{ service: { policy: { version: string } } }>(
      `/api/v1/facilities/${q.fid}/services/${q.serviceId}`,
      { policy: { grace_window_seconds: 300 } },
    );
    expect(r.status).toBe(200);
    expect(r.body.service.policy.version).toBe('v1');
  });
});

// ---------------------------------------------------------------------------
// 8.R11 — tenancy, secrets and the disabled configuration
// ---------------------------------------------------------------------------

describe('8.R11 tenancy, secrets and configuration', () => {
  it('another organization’s staff cannot reach a ticket’s recovery (404)', async () => {
    const a = await setupQueue(t.app, { counters: 1 });
    const b = await setupQueue(t.app, { counters: 1 });
    const v = await join(a);
    const r = await b.org.admin.post(
      `/api/v1/queues/${a.queueId}/tickets/${v.ticketId}/recovery/assist`,
      {
        reason_code: 'other',
        account_matches: true,
        asked_before_revealing: true,
      },
    );
    expect(r.status).toBe(404);
    // and a ticket of another queue cannot be addressed through one's own queue
    const r2 = await b.org.admin.post(
      `/api/v1/queues/${b.queueId}/tickets/${v.ticketId}/recovery/assist`,
      {
        reason_code: 'other',
        account_matches: true,
        asked_before_revealing: true,
      },
    );
    expect(r2.status).toBe(404);
  });

  it('state-changing recovery routes require the CSRF header', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/tickets/recover',
      headers: { origin: TEST_ORIGIN },
      payload: { grant: 'A'.repeat(32) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('without CONTACT_ENCRYPTION_KEY recovery is disabled, never weakened; joining still works', async () => {
    const off = await createTestApp({ CONTACT_ENCRYPTION_KEY: '' });
    try {
      const q = await setupQueue(off.app, { counters: 1 });
      const j = await visitorJoin(off.app, q.queueId);
      expect(j.status).toBe(201);
      expect(j.body.ticket?.recovery_key).toBeNull();
      const r = await off.app.inject({
        method: 'POST',
        url: '/api/v1/tickets/recover',
        headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
        payload: { grant: 'A'.repeat(32) },
      });
      expect(r.statusCode).toBe(503);
      const s = await ticketStatus(
        off.app,
        j.body.ticket!.public_code,
        j.body.ticket!.status_token,
      );
      expect(
        (s.body.status?.['recovery'] as { self_service_available: boolean }).self_service_available,
      ).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe('L5 per-process verification cap', () => {
  it('beyond 32 concurrent verifications the excess is refused with 503, not queued', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const rs = await Promise.all(
      Array.from({ length: 80 }, (_, i) => recover(withKey(q, `V${100 + i}`, wrongKey()))),
    );
    const statuses = new Set(rs.map((r) => r.status));
    expect([...statuses].every((s) => s === 404 || s === 503)).toBe(true);
    expect(rs.some((r) => r.status === 503)).toBe(true);
  });
});
