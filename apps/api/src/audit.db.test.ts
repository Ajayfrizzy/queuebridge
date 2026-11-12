import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@queuebridge/contracts';
import {
  checkpointMessage,
  checkpointRoot,
  computeEventHash,
  genesisHash,
} from '@queuebridge/domain';
import { signCheckpoint } from './queue/audit.js';
import { sha256Hex } from './queue/hash.js';
import {
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  signupOrg,
  TestClient,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';
import { migrationFiles, readMigration } from './testing/isolated-db.js';

/**
 * Group 9 — audit view, redacted export and integrity verification against real PostgreSQL.
 * Tampering is simulated in a THROWAWAY database (append-only triggers must be disabled for it).
 */

const KEY = 'test-audit-signing-key-at-least-32-characters';
const KEY_ID = 'test-key-1';

let t: TestApp; // signing key configured
let noKey: TestApp; // same database, no key
beforeAll(async () => {
  t = await createTestApp({ AUDIT_SIGNING_KEY: KEY, AUDIT_SIGNING_KEY_ID: KEY_ID });
  noKey = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await noKey.close();
});

interface Verification {
  status: 'verified' | 'failed' | 'incomplete';
  chain: { valid: boolean; broken_at_sequence: number | null; reason: string | null };
  checkpoints: {
    total: number;
    valid: number;
    invalid: { reason: string }[];
    unverifiable: number;
    covered_to_sequence: number;
    uncheckpointed_events: number;
  };
  replay: {
    valid: boolean;
    decisions_verified: number;
    mismatches: { sequence: number; reason: string }[];
  };
  alerts: unknown[];
  problems: string[];
}
const verify = async (
  client: TestClient,
  queueId: string,
): Promise<{ status: number; v: Verification }> => {
  const r = await client.get<{ verification: Verification }>(
    `/api/v1/queues/${queueId}/audit/verify`,
  );
  return { status: r.status, v: r.body.verification };
};

/** A busy session: joins, calls, completions, a policy change and a priority override. */
async function busySession(
  app: TestApp,
): Promise<QueueFixture & { overrideReason: string; tokens: string[] }> {
  const q = await setupQueue(app.app, { counters: 1 });
  await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
    policy: { priority_order: ['priority', 'normal'] },
  });
  const tokens: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const j = await visitorJoin(app.app, q.queueId);
    tokens.push(j.body.ticket?.status_token ?? '');
    const [row] = await app.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${j.body.ticket?.public_code ?? ''}`;
    ids.push(row?.id ?? '');
  }
  const overrideReason = 'Visitor has a mobility impairment';
  const o = await q.org.admin.post(`/api/v1/tickets/${ids[3]}/priority-override`, {
    operation_id: uuidv7(),
    to_class: 'priority',
    reason_code: 'accessibility_need',
    reason_text: overrideReason,
  });
  expect(o.status).toBe(200);
  for (let i = 0; i < 2; i++) {
    const c = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.serve',
      ticket_id: c.body.outcome?.ticket_id,
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.complete',
      ticket_id: c.body.outcome?.ticket_id,
    });
  }
  return { ...q, overrideReason, tokens };
}

/** Insert a checkpoint for 1..last exactly as the worker would (same construction, same key). */
async function checkpoint(
  db: TestApp['db'],
  queueId: string,
  key = KEY,
  keyId = KEY_ID,
): Promise<number> {
  const evs = await db<{ event_hash: string; organization_id: string }[]>`
    SELECT event_hash, organization_id FROM queue_events WHERE queue_session_id = ${queueId} ORDER BY sequence`;
  const root = checkpointRoot(
    sha256Hex,
    evs.map((e) => e.event_hash),
  );
  const head = evs[evs.length - 1]?.event_hash ?? '';
  const msg = checkpointMessage({
    queue_session_id: queueId,
    from_sequence: 1,
    to_sequence: evs.length,
    root_hash: root,
    head_hash: head,
  });
  await db`INSERT INTO audit_checkpoints (queue_session_id, organization_id, from_sequence, to_sequence, root_hash, head_hash, key_id, signature)
           VALUES (${queueId}, ${evs[0]?.organization_id ?? ''}, 1, ${evs.length}, ${root}, ${head}, ${keyId}, ${signCheckpoint(key, msg)})`;
  return evs.length;
}

describe('checkpoint signature construction', () => {
  it('matches the fixed test vector the worker test also asserts (cross-app compatibility)', () => {
    // Vector computed independently with:
    //   node -e "console.log(require('crypto').createHmac('sha256','k'.repeat(32))
    //            .update('queuebridge:v1:checkpoint|q|1|2|r|h').digest('hex'))"
    const msg = checkpointMessage({
      queue_session_id: 'q',
      from_sequence: 1,
      to_sequence: 2,
      root_hash: 'r',
      head_hash: 'h',
    });
    expect(msg).toBe('queuebridge:v1:checkpoint|q|1|2|r|h');
    expect(signCheckpoint('k'.repeat(32), msg)).toBe(
      '6e553bfb1e12bf859edcea4457cbfd45848378c5d30e56549b0375ec2124a8f3',
    );
  });
});

describe('who may read the audit (REQ-F8.5, Group 8)', () => {
  it('auditors, supervisors, facility admins and org admins read; operational staff are refused; other tenants see nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await visitorJoin(t.app, q.queueId);
    const paths = ['audit', 'audit/verify', 'audit/export'];
    for (const role of ['auditor', 'supervisor', 'facility_admin']) {
      const s = await createStaff(t.app, q.org, q.fid, role);
      for (const p of paths)
        expect(
          (await s.client.get(`/api/v1/queues/${q.queueId}/${p}`)).status,
          `${role} ${p}`,
        ).toBe(200);
    }
    for (const p of paths)
      expect((await q.org.admin.get(`/api/v1/queues/${q.queueId}/${p}`)).status).toBe(200);
    for (const role of ['staff_counter', 'staff_reception']) {
      const s = await createStaff(t.app, q.org, q.fid, role);
      for (const p of paths)
        expect(
          (await s.client.get(`/api/v1/queues/${q.queueId}/${p}`)).status,
          `${role} ${p}`,
        ).toBe(403);
    }
    const other = await signupOrg(t.app);
    for (const p of paths) {
      expect((await other.admin.get(`/api/v1/queues/${q.queueId}/${p}`)).status).toBe(404);
      expect((await new TestClient(t.app).get(`/api/v1/queues/${q.queueId}/${p}`)).status).toBe(
        401,
      );
    }
    // read-only: no write method exists on the audit resource
    expect((await q.org.admin.post(`/api/v1/queues/${q.queueId}/audit`, {})).status).toBe(404);
  });
});

describe('audit view and redacted export', () => {
  it('the view shows actors and override explanations; the export replaces them with ids and hashes; no secrets anywhere', async () => {
    const q = await busySession(t);
    const view = await q.org.admin.get<{
      audit: {
        events: {
          event_type: string;
          actor_name: string | null;
          override: { reason_text: string | null; reason_text_sha256: string } | null;
        }[];
        next_after_sequence: number | null;
        summary: Record<string, number>;
      };
    }>(`/api/v1/queues/${q.queueId}/audit?limit=5`);
    expect(view.body.audit.events).toHaveLength(5);
    expect(view.body.audit.next_after_sequence).toBe(5);
    const all = await q.org.admin.get<{
      audit: {
        events: {
          event_type: string;
          actor_name: string | null;
          override: { reason_text: string | null; reason_text_sha256: string } | null;
        }[];
      };
    }>(`/api/v1/queues/${q.queueId}/audit?limit=200`);
    const ov = all.body.audit.events.find((e) => e.event_type === 'ticket.priority_override');
    expect(ov?.override?.reason_text).toBe(q.overrideReason);
    expect(ov?.override?.reason_text_sha256).toBe(sha256Hex(q.overrideReason));
    expect(ov?.actor_name).toBe('Org Admin');
    expect(view.body.audit.summary).toMatchObject({ priority_overrides: 1 });

    const exp = await q.org.admin.request('GET', `/api/v1/queues/${q.queueId}/audit/export`);
    expect(String(exp.headers['content-disposition'])).toMatch(/attachment/);
    const text = JSON.stringify(exp.body);
    expect(text).not.toContain(q.overrideReason);
    expect(text).not.toContain('Org Admin');
    expect(text).toContain(sha256Hex(q.overrideReason));
    expect((exp.body as { redacted: boolean }).redacted).toBe(true);
    // visitor credentials never appear in the audit trail
    for (const tok of q.tokens) {
      expect(JSON.stringify(all.body)).not.toContain(tok);
      expect(text).not.toContain(tok);
    }
    expect(text).not.toMatch(/@example\.test/);
  });
});

describe('verification outcomes (never a false success)', () => {
  it('a clean session verifies: chain, replayed decisions (across a policy change and an override), no checkpoints yet', async () => {
    const q = await busySession(t);
    const { status, v } = await verify(q.org.admin, q.queueId);
    expect(status).toBe(200);
    expect(v.status).toBe('verified');
    expect(v.chain.valid).toBe(true);
    expect(v.replay).toMatchObject({ valid: true, decisions_verified: 2, mismatches: [] });
    expect(v.checkpoints).toMatchObject({
      total: 0,
      uncheckpointed_events: expect.any(Number) as number,
    });
    expect(v.problems).toEqual([]);
  });

  it('a valid signed checkpoint verifies and covers the range', async () => {
    const q = await busySession(t);
    const n = await checkpoint(t.db, q.queueId);
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('verified');
    expect(v.checkpoints).toMatchObject({
      total: 1,
      valid: 1,
      covered_to_sequence: n,
      uncheckpointed_events: 0,
    });
  });

  it('without the signing key the result is INCOMPLETE, never verified', async () => {
    const q = await busySession(t);
    await checkpoint(t.db, q.queueId);
    const r = await noKey.app.inject({
      method: 'GET',
      url: `/api/v1/queues/${q.queueId}/audit/verify`,
      headers: { cookie: q.org.admin.cookie ?? '', origin: 'http://localhost:5173' },
    });
    const v = (JSON.parse(r.body) as { verification: Verification }).verification;
    expect(v.status).toBe('incomplete');
    expect(v.checkpoints.unverifiable).toBe(1);
    expect(v.problems.join(' ')).toMatch(/could not be checked/);
  });

  it('a checkpoint signed with the wrong key, or an unknown key id, is failed / incomplete respectively', async () => {
    const a = await busySession(t);
    await checkpoint(t.db, a.queueId, 'another-key-another-key-another-key-xx', KEY_ID);
    expect((await verify(a.org.admin, a.queueId)).v).toMatchObject({ status: 'failed' });
    const b = await busySession(t);
    await checkpoint(t.db, b.queueId, KEY, 'retired-key');
    expect((await verify(b.org.admin, b.queueId)).v.status).toBe('incomplete');
  });

  it('an integrity alert raised by the worker makes verification fail', async () => {
    const q = await busySession(t);
    await t.db`INSERT INTO audit_integrity_alerts (organization_id, queue_session_id, kind, at_sequence, reason)
               VALUES (${q.org.organizationId}, ${q.queueId}, 'chain', 3, 'event_hash mismatch')`;
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('failed');
    expect(v.alerts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tampering — throwaway database, full API on top of it
// ---------------------------------------------------------------------------

describe('tamper detection (isolated database)', () => {
  let iso: TestApp;
  let url: string;
  let dbName: string;
  beforeAll(async () => {
    const base = process.env['TEST_DATABASE_URL'] ?? '';
    dbName = `qb_iso_${randomBytes(6).toString('hex')}`;
    const admin = postgres(base, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end({ timeout: 5 });
    const u = new URL(base);
    u.pathname = `/${dbName}`;
    url = u.toString();
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    for (const f of await migrationFiles()) await sql.unsafe(await readMigration(f));
    await sql.end({ timeout: 5 });
    iso = await createTestApp({
      DATABASE_URL: url,
      AUDIT_SIGNING_KEY: KEY,
      AUDIT_SIGNING_KEY_ID: KEY_ID,
    });
  });
  afterAll(async () => {
    await iso.close();
    const admin = postgres(process.env['TEST_DATABASE_URL'] ?? '', {
      max: 1,
      onnotice: () => undefined,
    });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  const unlocked = async (
    table: string,
    trigger: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    await iso.db.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try {
      await fn();
    } finally {
      await iso.db.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  };

  it('one changed character in a committed event fails verification at that event', async () => {
    const q = await busySession(iso);
    expect((await verify(q.org.admin, q.queueId)).v.status).toBe('verified');
    await unlocked(
      'queue_events',
      'queue_events_append_only',
      () =>
        iso.db`UPDATE queue_events SET payload = jsonb_set(payload, '{public_code}', '"G00X"')
              WHERE queue_session_id = ${q.queueId} AND sequence = 4`,
    );
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('failed');
    expect(v.chain).toMatchObject({
      valid: false,
      broken_at_sequence: 4,
      reason: 'event_hash mismatch',
    });
  });

  it('a deleted event fails verification', async () => {
    const q = await busySession(iso);
    await unlocked('queue_events', 'queue_events_append_only', async () => {
      await iso.db`DELETE FROM ticket_transitions WHERE queue_event_id IN (SELECT id FROM queue_events WHERE queue_session_id = ${q.queueId} AND sequence = (SELECT MAX(sequence) FROM queue_events WHERE queue_session_id = ${q.queueId}))`;
      await iso.db`DELETE FROM queue_events WHERE queue_session_id = ${q.queueId}
                    AND sequence = (SELECT MAX(sequence) FROM queue_events WHERE queue_session_id = ${q.queueId})`;
    });
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('failed');
    expect(v.problems.join(' ')).toMatch(/records \d+ events but \d+ are present/);
  });

  it('a rewritten override explanation is caught: the chain sealed its hash', async () => {
    const q = await busySession(iso);
    await unlocked(
      'priority_overrides',
      'priority_overrides_append_only',
      () =>
        iso.db`UPDATE priority_overrides SET reason_text = 'Something else entirely' WHERE queue_session_id = ${q.queueId}`,
    );
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('failed');
    expect(v.chain.valid).toBe(true);
    expect(v.problems.join(' ')).toMatch(/does not match the one sealed in the chain/);
  });

  it('every other field of an override record is cross-checked too (reason code, actor, classes, policy)', async () => {
    const q = await busySession(iso);
    // pin the override on someone else (a real staff member of the same organization)
    const other = await createStaff(iso.app, q.org, q.fid, 'supervisor');
    await unlocked(
      'priority_overrides',
      'priority_overrides_append_only',
      () =>
        iso.db`UPDATE priority_overrides SET reason_code = 'urgent_need', to_class = 'urgent',
                    policy_version = 'v1', actor_id = ${other.userId}
              WHERE queue_session_id = ${q.queueId}`,
    );
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.status).toBe('failed');
    expect(v.chain.valid).toBe(true);
    const problem = v.problems.find((p) => p.includes('override record'));
    expect(problem).toMatch(/reason code/);
    expect(problem).toMatch(/actor/);
    expect(problem).toMatch(/resulting class/);
    expect(problem).toMatch(/policy version/);
    expect(problem).not.toMatch(/explanation/); // the text itself was not touched
  });

  it('a CONSISTENT forgery (a call re-pointed at another visitor and the whole chain re-hashed) is caught by decision replay', async () => {
    const q = await busySession(iso);
    const rows = await iso.db<
      {
        sequence: number;
        organization_id: string;
        event_type: string;
        actor_id: string | null;
        operation_id: string | null;
        payload: Record<string, unknown>;
        committed_at: Date;
      }[]
    >`
      SELECT sequence, organization_id, event_type, actor_id, operation_id, payload, committed_at
        FROM queue_events WHERE queue_session_id = ${q.queueId} ORDER BY sequence`;
    const firstCall = rows.find((r) => r.event_type === 'ticket.call_next');
    const victim = rows.find(
      (r) =>
        r.event_type === 'ticket.create' &&
        r.payload['ticket_id'] !== firstCall?.payload['ticket_id'],
    );
    await unlocked('queue_events', 'queue_events_append_only', async () => {
      let prev = genesisHash(sha256Hex);
      for (const r of rows) {
        // Re-point the first call (and its follow-ups for that ticket) at another visitor
        const payload =
          r.payload['ticket_id'] === firstCall?.payload['ticket_id'] &&
          r.sequence >= (firstCall?.sequence ?? 0)
            ? {
                ...r.payload,
                ticket_id: victim?.payload['ticket_id'],
                public_code: victim?.payload['public_code'],
              }
            : r.payload;
        const body = {
          organization_id: r.organization_id,
          queue_session_id: q.queueId,
          sequence: r.sequence,
          event_type: r.event_type,
          actor_id: r.actor_id,
          operation_id: r.operation_id,
          payload,
          committed_at: r.committed_at.toISOString(),
        };
        const hash = computeEventHash(sha256Hex, prev, body);
        await iso.db`UPDATE queue_events SET payload = ${iso.db.json(payload as never)}, prev_hash = ${prev}, event_hash = ${hash}
                      WHERE queue_session_id = ${q.queueId} AND sequence = ${r.sequence}`;
        prev = hash;
      }
    });
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.chain.valid).toBe(true); // the forger made the chain consistent...
    expect(v.replay.valid).toBe(false); // ...but the decision contradicts the published policy
    expect(v.status).toBe('failed');
  });

  it('with a signed checkpoint, even a consistent re-hash of history is caught by the root hash', async () => {
    const q = await busySession(iso);
    await checkpoint(iso.db, q.queueId);
    const rows = await iso.db<
      {
        sequence: number;
        organization_id: string;
        event_type: string;
        actor_id: string | null;
        operation_id: string | null;
        payload: Record<string, unknown>;
        committed_at: Date;
      }[]
    >`
      SELECT sequence, organization_id, event_type, actor_id, operation_id, payload, committed_at FROM queue_events WHERE queue_session_id = ${q.queueId} ORDER BY sequence`;
    await unlocked('queue_events', 'queue_events_append_only', async () => {
      let prev = genesisHash(sha256Hex);
      for (const r of rows) {
        const payload = r.sequence === 2 ? { ...r.payload, channel: 'staff' } : r.payload; // harmless-looking edit
        const body = {
          organization_id: r.organization_id,
          queue_session_id: q.queueId,
          sequence: r.sequence,
          event_type: r.event_type,
          actor_id: r.actor_id,
          operation_id: r.operation_id,
          payload,
          committed_at: r.committed_at.toISOString(),
        };
        const hash = computeEventHash(sha256Hex, prev, body);
        await iso.db`UPDATE queue_events SET payload = ${iso.db.json(payload as never)}, prev_hash = ${prev}, event_hash = ${hash}
                      WHERE queue_session_id = ${q.queueId} AND sequence = ${r.sequence}`;
        prev = hash;
      }
    });
    const { v } = await verify(q.org.admin, q.queueId);
    expect(v.chain.valid).toBe(true);
    expect(v.status).toBe('failed');
    expect(v.checkpoints.invalid[0]?.reason).toBe('root_hash mismatch');
  });
});
