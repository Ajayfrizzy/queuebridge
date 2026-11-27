import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { createDb } from '../db.js';
import { buildApp } from '../app.js';
import { parseEnv, type Env } from '../env.js';

export const TEST_ORIGIN = 'http://localhost:5173';
export const TEST_PASSWORD = 'correct-horse-battery-1';

export function testEnv(overrides: Record<string, string> = {}): Env {
  // An override of '' REMOVES the variable (e.g. to test recovery without its key)
  const removed = Object.keys(overrides).filter((k) => overrides[k] === '');
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    CORS_ORIGIN: TEST_ORIGIN,
    WEB_BASE_URL: TEST_ORIGIN,
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_MAX: '100000',
    JOIN_RATE_LIMIT_MAX: '100000',
    PUBLIC_READ_RATE_LIMIT_MAX: '100000',
    COMMAND_RATE_LIMIT_MAX: '100000',
    // M5.1: a fixed TEST-ONLY key (never a real secret) so recovery is enabled in tests; the
    // recovery throttle keeps its real default so abuse tests exercise it
    CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16),
    AUTO_MISS_SWEEP_SECONDS: '0',
    ...overrides,
  };
  for (const k of removed) delete env[k];
  return parseEnv(env);
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  env: Env;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const env = testEnv(overrides);
  const db = createDb(env);
  const app = await buildApp(env, { db });
  await app.ready();
  return {
    app,
    db,
    env,
    close: async (): Promise<void> => {
      await app.close();
      await db.end({ timeout: 5 });
    },
  };
}

export function uniqueSlug(prefix = 't'): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  setCookie: string[];
}

/** Minimal cookie-jar HTTP client over `app.inject`, behaving like the browser SPA. */
export class TestClient {
  public cookie: string | null = null;

  public constructor(private readonly app: FastifyInstance) {}

  public async request<T = Record<string, unknown>>(
    method: Method,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...extraHeaders,
    };
    if (this.cookie) headers['cookie'] = this.cookie;
    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(body !== undefined ? { payload: body as object } : {}),
    });

    const setCookie = ([] as string[]).concat(
      (res.headers['set-cookie'] as string[] | string | undefined) ?? [],
    );
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (!pair) continue;
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (name === 'qb_session') this.cookie = value === '' ? null : `${name}=${value}`;
    }

    let parsed: unknown = {};
    if (res.body) {
      try {
        parsed = JSON.parse(res.body);
      } catch {
        parsed = { raw: res.body };
      }
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers, setCookie };
  }

  public get = <T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> =>
    this.request<T>('GET', url);
  public post = <T = Record<string, unknown>>(url: string, body?: unknown): Promise<ApiResult<T>> =>
    this.request<T>('POST', url, body ?? {});
  public patch = <T = Record<string, unknown>>(url: string, body: unknown): Promise<ApiResult<T>> =>
    this.request<T>('PATCH', url, body);
  public del = <T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> =>
    this.request<T>('DELETE', url);
}

export interface TestOrg {
  slug: string;
  adminEmail: string;
  admin: TestClient;
  organizationId: string;
  adminId: string;
}

interface UserBody {
  user: { id: string; organization: { id: string } };
}

export async function signupOrg(app: FastifyInstance, name = 'Test Org'): Promise<TestOrg> {
  const slug = uniqueSlug('org');
  const adminEmail = `admin-${slug}@example.test`;
  const admin = new TestClient(app);
  const res = await admin.post<UserBody>('/api/v1/organizations', {
    organization_name: name,
    organization_slug: slug,
    admin_display_name: 'Org Admin',
    admin_email: adminEmail,
    admin_password: TEST_PASSWORD,
  });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    slug,
    adminEmail,
    admin,
    organizationId: res.body.user.organization.id,
    adminId: res.body.user.id,
  };
}

export async function createFacility(
  org: TestOrg,
  name = 'Main Clinic',
): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug('fac');
  const res = await org.admin.post<{ facility: { id: string; slug: string } }>(
    '/api/v1/facilities',
    {
      name,
      slug,
      timezone: 'Africa/Lagos',
    },
  );
  if (res.status !== 201)
    throw new Error(`facility failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.facility;
}

/** Invite + accept so the returned client is signed in as a staff member holding `role`. */
export async function createStaff(
  app: FastifyInstance,
  org: TestOrg,
  facilityId: string,
  role: string,
): Promise<{ client: TestClient; email: string; userId: string }> {
  const email = `${role}-${uniqueSlug('u')}@example.test`;
  const inv = await org.admin.post<{ token: string }>(
    `/api/v1/facilities/${facilityId}/invitations`,
    {
      email,
      role,
    },
  );
  if (inv.status !== 201)
    throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const client = new TestClient(app);
  const acc = await client.post<UserBody>('/api/v1/invitations/accept', {
    token: inv.body.token,
    display_name: `Staff ${role}`,
    password: TEST_PASSWORD,
  });
  if (acc.status !== 201)
    throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  return { client, email, userId: acc.body.user.id };
}

// ---------------------------------------------------------------------------
// M2 queue fixtures (real API calls; nothing mocked)
// ---------------------------------------------------------------------------

export interface QueueFixture {
  org: TestOrg;
  fid: string;
  facilitySlug: string;
  serviceId: string;
  counterIds: string[];
  queueId: string;
}

export async function setupQueue(
  app: FastifyInstance,
  opts: {
    counters?: number;
    serviceName?: string;
    org?: TestOrg;
    fid?: string;
    facilitySlug?: string;
  } = {},
): Promise<QueueFixture> {
  const org = opts.org ?? (await signupOrg(app));
  let fid = opts.fid;
  let facilitySlug = opts.facilitySlug ?? '';
  if (!fid) {
    const f = await createFacility(org);
    fid = f.id;
    facilitySlug = f.slug;
  }
  const svc = await org.admin.post<{ service: { id: string } }>(
    `/api/v1/facilities/${fid}/services`,
    {
      name: opts.serviceName ?? `General ${uniqueSlug('s')}`,
    },
  );
  if (svc.status !== 201)
    throw new Error(`service failed ${svc.status} ${JSON.stringify(svc.body)}`);
  const counterIds: string[] = [];
  for (let i = 0; i < (opts.counters ?? 2); i++) {
    const c = await org.admin.post<{ counter: { id: string } }>(
      `/api/v1/facilities/${fid}/counters`,
      {
        name: `Counter ${uniqueSlug('c')}`,
      },
    );
    counterIds.push(c.body.counter.id);
    await org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: c.body.counter.id,
      service_id: svc.body.service.id,
    });
  }
  const q = await org.admin.post<{ queue: { id: string } }>(`/api/v1/facilities/${fid}/queues`, {
    service_id: svc.body.service.id,
  });
  if (q.status !== 201) throw new Error(`open queue failed ${q.status} ${JSON.stringify(q.body)}`);
  return {
    org,
    fid,
    facilitySlug,
    serviceId: svc.body.service.id,
    counterIds,
    queueId: q.body.queue.id,
  };
}

export interface JoinResult {
  status: number;
  body: {
    ticket?: {
      disposition: string;
      public_code: string;
      status_token: string;
      status_path: string;
      /** M5.1: shown once; null when recovery is not configured */
      recovery_key: string | null;
      recovery_path: string;
    };
    title?: string;
  };
  operationId: string;
  proof: string;
}

/** Anonymous visitor join (no cookie), as the PWA would send it. */
export async function visitorJoin(
  app: FastifyInstance,
  queueId: string,
  ids: { operationId?: string; proof?: string } = {},
): Promise<JoinResult> {
  const { uuidv7, randomSecret } = await import('@queuebridge/contracts');
  const operationId = ids.operationId ?? uuidv7();
  const proof = ids.proof ?? randomSecret();
  const res = await new TestClient(app).post<JoinResult['body']>(`/api/v1/queues/${queueId}/join`, {
    operation_id: operationId,
    join_proof: proof,
  });
  return { status: res.status, body: res.body, operationId, proof };
}

export interface CommandBody {
  outcome?: {
    disposition: string;
    ticket_id: string | null;
    public_code: string | null;
    server_revision: number;
    server_sequence: number | null;
    reason_code: string | null;
  };
  title?: string;
}

export async function queueCommand(
  client: TestClient,
  queueId: string,
  body: Record<string, unknown>,
): Promise<ApiResult<CommandBody>> {
  const { uuidv7 } = await import('@queuebridge/contracts');
  return client.post<CommandBody>(`/api/v1/queues/${queueId}/commands`, {
    operation_id: uuidv7(),
    ...body,
  });
}

export async function ticketStatus(
  app: FastifyInstance,
  code: string,
  token: string | undefined,
): Promise<
  ApiResult<{ status?: Record<string, unknown> & { state: string; position: number | null } }>
> {
  return new TestClient(app).request(
    'GET',
    `/api/v1/tickets/${code}/status`,
    undefined,
    token ? { 'x-qb-ticket-token': token } : {},
  );
}

// ---------------------------------------------------------------------------
// M3 continuity fixtures (real API calls; nothing mocked)
// ---------------------------------------------------------------------------

export interface Persona {
  client: TestClient;
  userId: string;
  deviceId: string;
}

/** A staff member holding `role` at the facility, with one registered device. */
export async function staffWithDevice(
  app: FastifyInstance,
  org: TestOrg,
  facilityId: string,
  role: string,
  label = 'Test device',
): Promise<Persona> {
  const s = await createStaff(app, org, facilityId, role);
  const deviceId = await registerDevice(s.client, facilityId, label);
  return { client: s.client, userId: s.userId, deviceId };
}

export async function registerDevice(
  client: TestClient,
  facilityId: string,
  label = 'Test device',
): Promise<string> {
  const res = await client.post<{ device: { id: string } }>('/api/v1/devices', {
    facility_id: facilityId,
    label,
  });
  if (res.status !== 201)
    throw new Error(`device register failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.device.id;
}

export interface EnvelopeInput {
  org: TestOrg;
  fid: string;
  queueId: string;
  deviceId: string;
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  epoch?: number;
  baseRevision?: number;
  clientSequence: number;
  operationId?: string;
  createdAtClient?: string;
  /** Timing evidence; omit for the honest-device default, `null` to send none */
  timing?: Record<string, unknown> | null;
}

export function envelope(i: EnvelopeInput): Record<string, unknown> {
  return {
    operation_id: i.operationId ?? uuidv7Sync(),
    organization_id: i.org.organizationId,
    facility_id: i.fid,
    queue_session_id: i.queueId,
    device_id: i.deviceId,
    actor_id: i.actorId,
    coordinator_epoch: i.epoch ?? 0,
    base_revision: i.baseRevision ?? 0,
    client_sequence: i.clientSequence,
    action: i.action,
    payload: i.payload,
    created_at_client: i.createdAtClient ?? new Date().toISOString(),
    ...(i.timing === undefined ? {} : { authority_timing: i.timing ?? undefined }),
    schema_version: 1,
  };
}

export function uuidv7Sync(): string {
  return uuidv7();
}

export const tempRef = (): string => `P-${randomBytes(3).toString('hex').toUpperCase()}`;

export interface BatchResultBody {
  results: {
    index: number;
    operation_id: string | null;
    client_sequence: number;
    disposition: string;
    reason_code?: string;
    rejection_reason?: string;
    server_revision?: number;
    server_sequence?: number;
    ticket_id?: string;
    public_code?: string;
    status_token?: string;
    ticket_mapping?: { temporary_ref: string; public_code: string; ticket_id?: string };
  }[];
  queue_revisions: Record<string, number>;
  title?: string;
  type?: string;
}

const ADVANCE = ['ticket.call_next', 'ticket.serve', 'ticket.complete', 'ticket.miss'];

/** Claims of a signed authority token (no verification — test helper only). */
export function tokenClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

/** Timing evidence relative to a token, as a device would attach it. */
export function timingFor(
  token: string,
  over: Partial<{
    elapsed_ms: number;
    floor_ms: number;
    source: 'monotonic' | 'restarted';
    rollback_detected: boolean;
  }> = {},
): Record<string, unknown> {
  const delivered = String(tokenClaims(token)['delivered_at']);
  const honest = Math.max(0, Date.now() - Date.parse(delivered));
  const elapsed = over.elapsed_ms ?? honest;
  return {
    delivered_at: delivered,
    elapsed_ms: elapsed,
    floor_ms: over.floor_ms ?? elapsed,
    source: over.source ?? 'monotonic',
    rollback_detected: over.rollback_detected ?? false,
  };
}

/**
 * Submit a sync batch. To model an HONEST device, an advancement command that has no
 * `authority_timing` key gets evidence from the first presented token matching its
 * queue/device/epoch (elapsed = real time since delivery). Tests about timing set the key
 * explicitly (an explicit `undefined` means "send no evidence").
 */
export function syncBatch(
  client: TestClient,
  commands: unknown[],
  authorities: string[] = [],
  extra: Record<string, unknown> = {},
): Promise<ApiResult<BatchResultBody>> {
  const filled = commands.map((c) => {
    if (!c || typeof c !== 'object' || 'authority_timing' in c) return c;
    const cmd = c as Record<string, unknown>;
    if (!ADVANCE.includes(String(cmd['action']))) return c;
    const token = authorities.find((tk) => {
      try {
        const k = tokenClaims(tk);
        return (
          k['queue_session_id'] === cmd['queue_session_id'] &&
          k['device_id'] === cmd['device_id'] &&
          k['epoch'] === cmd['coordinator_epoch']
        );
      } catch {
        return false;
      }
    });
    return token ? { ...cmd, authority_timing: timingFor(token) } : c;
  });
  return client.post<BatchResultBody>('/api/v1/sync/batches', {
    commands: filled,
    ...(authorities.length > 0 ? { authorities } : {}),
    ...extra,
  });
}

export interface SnapshotBody {
  snapshot: {
    queue: { id: string; tickets: { id: string; public_code: string; state: string }[] };
    revision: number;
    last_sequence: number;
    events: { sequence: number; event_type: string; payload: Record<string, unknown> }[];
    has_more_events: boolean;
    coordinator: {
      epoch: number;
      device_id: string | null;
      status: string;
      is_this_device: boolean;
      expires_at: string | null;
    };
    authority: string | null;
    open_conflicts: number;
    server_time: string;
  };
}

export function snapshot(
  client: TestClient,
  queueId: string,
  deviceId?: string,
  since?: number,
): Promise<ApiResult<SnapshotBody>> {
  const qs = new URLSearchParams();
  if (deviceId) qs.set('device_id', deviceId);
  if (since !== undefined) qs.set('since_sequence', String(since));
  const q = qs.toString();
  return client.get<SnapshotBody>(`/api/v1/sync/queues/${queueId}/snapshot${q ? `?${q}` : ''}`);
}

export interface CoordinatorBody {
  disposition?: string;
  coordinator?: {
    epoch: number;
    device_id: string | null;
    status: string;
    expires_at: string | null;
  };
  server_revision?: number;
  title?: string;
  detail?: string;
}

export function assignCoordinator(
  supervisor: TestClient,
  queueId: string,
  deviceId: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResult<CoordinatorBody>> {
  return supervisor.post<CoordinatorBody>(`/api/v1/queues/${queueId}/coordinator`, {
    operation_id: uuidv7Sync(),
    device_id: deviceId,
    ...extra,
  });
}

export function failoverCoordinator(
  supervisor: TestClient,
  queueId: string,
  deviceId: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResult<CoordinatorBody>> {
  return supervisor.post<CoordinatorBody>(`/api/v1/queues/${queueId}/coordinator/failover`, {
    operation_id: uuidv7Sync(),
    device_id: deviceId,
    reason_code: 'device_lost',
    ...extra,
  });
}

export function revokeCoordinator(
  supervisor: TestClient,
  queueId: string,
  reason = 'outage_over',
): Promise<ApiResult<CoordinatorBody>> {
  return supervisor.post<CoordinatorBody>(`/api/v1/queues/${queueId}/coordinator/revoke`, {
    operation_id: uuidv7Sync(),
    reason_code: reason,
  });
}

/** A complete M3 world: facility, queue, supervisor, coordinator-capable counter staff, reception. */
export interface ContinuityFixture extends QueueFixture {
  supervisor: Persona;
  counter: Persona;
  reception: Persona;
  adminId: string;
  /** Build an envelope for a persona with sensible defaults */
  cmd: (
    who: Persona,
    action: string,
    payload: Record<string, unknown>,
    over?: Partial<EnvelopeInput>,
  ) => Record<string, unknown>;
  /** Signed authority for the persona's device from the snapshot endpoint */
  authorityFor: (who: Persona) => Promise<string>;
}

export async function setupContinuity(
  app: FastifyInstance,
  opts: { counters?: number } = {},
): Promise<ContinuityFixture> {
  const q = await setupQueue(app, { counters: opts.counters ?? 2 });
  const supervisor = await staffWithDevice(app, q.org, q.fid, 'supervisor', 'Supervisor laptop');
  const counter = await staffWithDevice(app, q.org, q.fid, 'staff_counter', 'Counter tablet');
  const reception = await staffWithDevice(app, q.org, q.fid, 'staff_reception', 'Reception phone');
  let seq = 0;
  return {
    ...q,
    supervisor,
    counter,
    reception,
    adminId: q.org.adminId,
    cmd: (who, action, payload, over = {}) =>
      envelope({
        org: q.org,
        fid: q.fid,
        queueId: q.queueId,
        deviceId: who.deviceId,
        actorId: who.userId,
        action,
        payload,
        clientSequence: ++seq,
        ...over,
      }),
    authorityFor: async (who) => {
      const s = await snapshot(who.client, q.queueId, who.deviceId);
      if (!s.body.snapshot?.authority) throw new Error(`no authority: ${JSON.stringify(s.body)}`);
      return s.body.snapshot.authority;
    },
  };
}

/**
 * The event log of a queue session must be gap-free, hash-chain valid and replayable by the
 * domain projection. Returns the event types in order for further assertions.
 */
export async function assertEventLogIntact(db: Db, queueId: string): Promise<string[]> {
  const { verifyChain } = await import('../queue/hash.js');
  const { replayQueueEvents } = await import('@queuebridge/domain');
  const rows = await db<
    {
      organization_id: string;
      queue_session_id: string;
      sequence: number;
      event_type: string;
      actor_id: string | null;
      operation_id: string | null;
      payload: Record<string, unknown>;
      prev_hash: string;
      event_hash: string;
      committed_at: Date;
    }[]
  >`
    SELECT organization_id, queue_session_id, sequence, event_type, actor_id, operation_id,
           payload, prev_hash, event_hash, committed_at
      FROM queue_events WHERE queue_session_id = ${queueId} ORDER BY sequence`;
  const log = rows.map((r) => ({ ...r, committed_at: r.committed_at.toISOString() }));
  const verdict = verifyChain(log);
  if (!verdict.valid) throw new Error(`hash chain invalid: ${JSON.stringify(verdict)}`);
  replayQueueEvents(log);
  const seqs = log.map((e) => e.sequence);
  const expected = Array.from({ length: seqs.length }, (_, i) => i + 1);
  if (JSON.stringify(seqs) !== JSON.stringify(expected)) throw new Error('event sequence has gaps');
  return log.map((e) => e.event_type);
}

/**
 * Mint a server-signed authority for the queue's CURRENT coordinator with chosen delivery and
 * expiry times (signed with the test key, verified by the server like a real token). Lets tests
 * place an outage precisely in time without sleeping.
 */
export async function mintAuthority(
  t: TestApp,
  queueId: string,
  times: { deliveredAt: Date; expiresAt: Date; alsoSetSessionExpiry?: boolean },
): Promise<string> {
  const { authoritySigningKey, signAuthority } = await import('../queue/authority.js');
  const [s] = await t.db<
    {
      facility_id: string;
      coordinator_epoch: number;
      coordinator_device_id: string;
      coordinator_allowed_actions: string[];
      coordinator_granted_by: string;
      coordinator_granted_at: Date;
    }[]
  >`SELECT facility_id, coordinator_epoch, coordinator_device_id, coordinator_allowed_actions,
           coordinator_granted_by, coordinator_granted_at FROM queue_sessions WHERE id = ${queueId}`;
  if (!s?.coordinator_device_id) throw new Error('no coordinator to mint for');
  if (times.alsoSetSessionExpiry !== false) {
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = ${times.expiresAt} WHERE id = ${queueId}`;
  }
  return signAuthority(
    {
      device_id: s.coordinator_device_id,
      facility_id: s.facility_id,
      queue_session_id: queueId,
      epoch: s.coordinator_epoch,
      allowed_actions: s.coordinator_allowed_actions as never,
      issued_at: s.coordinator_granted_at.toISOString(),
      expires_at: times.expiresAt.toISOString(),
      delivered_at: times.deliveredAt.toISOString(),
      issued_by_role: 'supervisor',
      issued_by_actor_id: s.coordinator_granted_by,
    },
    authoritySigningKey(t.env),
  );
}
