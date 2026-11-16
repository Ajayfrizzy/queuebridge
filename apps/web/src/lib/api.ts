import type {
  ApiError,
  Board,
  CommandOutcome,
  FacilityQueueSummary,
  JoinQueueResponse,
  PublicFacility,
  QueueCommandRequest,
  StaffQueue,
  TicketStatus,
  Counter,
  CreateFacilityRequest,
  CreateOrganizationRequest,
  Facility,
  FacilityReadiness,
  FacilityJoinLink,
  FacilityRole,
  Invitation,
  LoginRequest,
  Service,
  ServicePolicy,
  SessionUser,
  StaffMember,
  Device,
  OperationsHealth,
  SyncBatchResponse,
  SyncConflict,
  SyncSnapshot,
  CoordinatorStatus,
  AuditPage,
  AuditVerification,
  CallOutOfOrderRequest,
  CounterAvailabilityRequest,
  CounterAvailabilityResult,
  CounterTransferRequest,
  PolicyVersion,
  PriorityOverrideRequest,
  RecoveredTicket,
  RecoveryAssistRequest,
  RecoveryAssistResponse,
  RecoveryKeyResponse,
  RecoveryAuditPage,
  RecoveryRequestStatus,
  RecoveryRequestSummary,
  RecoveryRevokeAllRequest,
  RevokeOtherDevicesResponse,
  AlertSummary,
  HealthAlert,
  OwnDeviceHealth,
  PushCapability,
  PushSubscribeRequest,
  PushSubscribeResponse,
  StaffTicketAlerts,
} from '@queuebridge/contracts';

const BASE: string =
  (import.meta.env['VITE_API_BASE_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';

let onUnauthenticated: (() => void) | null = null;
let networkObserver: ((reachable: boolean) => void) | null = null;
let sessionObserver: ((expiresAt: string) => void) | null = null;

/**
 * API reachability, as the rest of the app sees it (M5.0).
 *
 * Negative signals take effect at once: the browser's `offline` event and any network failure
 * report "unreachable" and start a new outage epoch. Restoring "reachable" after an outage needs
 * actual server health validation: a `/health` probe that was SENT and ANSWERED within the
 * current epoch while the browser reports being online. Ordinary API responses can only keep an
 * already reachable state; during an outage they trigger a probe instead of restoring it, and a
 * response to a request sent before the outage began never counts.
 */
let apiReachable = typeof navigator === 'undefined' ? true : navigator.onLine;
let outageEpoch = 0;
const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

function reportUnreachable(): void {
  outageEpoch += 1;
  apiReachable = false;
  networkObserver?.(false);
}

if (typeof window !== 'undefined') window.addEventListener('offline', reportUnreachable);

/** Observe API reachability (see above): false at once on an outage, true only after a probe. */
export function setNetworkObserver(fn: ((reachable: boolean) => void) | null): void {
  networkObserver = fn;
}

/** Observe the session expiry the server reports on login / sign-up / invite / me. */
export function setSessionObserver(fn: ((expiresAt: string) => void) | null): void {
  sessionObserver = fn;
}

/** Register a callback fired when an authenticated request is rejected with 401 (session ended). */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/** Paths where a 401 is an expected answer (bad credentials / probing), not a lost session. */
const PUBLIC_401 = [
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/invitations/',
  '/public/',
  '/tickets/',
];

/** An RFC 9457 problem response from the API (or a network failure with status 0). */
export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly problem: (ApiError & { outcome?: CommandOutcome }) | null;

  public constructor(
    status: number,
    problem: (ApiError & { outcome?: CommandOutcome }) | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.problem = problem;
  }

  /** Field-level validation messages keyed by field name. */
  public fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem?.errors ?? []) {
      if (!(e.field in out)) out[e.field] = e.message;
    }
    return out;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  let res: Response;
  const sentInEpoch = outageEpoch;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json, application/problem+json',
        // Cross-site request protection header required by the API for cookie-authenticated writes
        'X-QB-CSRF': '1',
        ...extraHeaders,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    reportUnreachable();
    throw new ApiRequestError(0, null, 'Cannot reach the server. Check your connection and retry.');
  }
  // A response is never by itself proof that an outage is over (see `apiReachable`). If the app
  // is in an outage, ask the health probe; otherwise the state simply stays "reachable".
  if (!apiReachable && browserOnline() && sentInEpoch === outageEpoch) void api.ping();

  if (res.status === 204) return undefined as T;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const sessionExpiry = (parsed as { session?: { expires_at?: unknown } } | null)?.session
    ?.expires_at;
  if (res.ok && typeof sessionExpiry === 'string') sessionObserver?.(sessionExpiry);
  if (res.status === 401 && !PUBLIC_401.some((p) => path.startsWith(p))) {
    onUnauthenticated?.();
  }
  if (!res.ok) {
    const problem = (parsed as ApiError | null) ?? null;
    throw new ApiRequestError(res.status, problem, friendlyMessage(res.status, problem));
  }
  return parsed as T;
}

function friendlyMessage(status: number, problem: ApiError | null): string {
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return problem?.detail ?? problem?.title ?? 'The request could not be completed.';
}

export interface CreatedInvitation {
  invitation: Invitation;
  delivery: 'manual';
  token: string;
  accept_url: string;
}

export interface InvitationPreview {
  organization_name: string;
  facility_name: string;
  email: string;
  role: FacilityRole;
}

/** Absolute API URL (for streaming endpoints). */
export function apiUrl(path: string): string {
  return `${BASE}/api/v1${path}`;
}

export interface SessionInfo {
  expires_at: string;
}

export interface CoordinatorResult {
  disposition: 'committed' | 'duplicate';
  coordinator: CoordinatorStatus;
  server_revision: number;
  server_sequence: number;
}

export const TICKET_TOKEN_HEADER = 'X-QB-Ticket-Token';
const tokenHeader = (token: string): Record<string, string> => ({ [TICKET_TOKEN_HEADER]: token });
export const api = {
  signupOrganization: (body: CreateOrganizationRequest): Promise<{ user: SessionUser }> =>
    request('POST', '/organizations', body),
  login: (body: LoginRequest): Promise<{ user: SessionUser; session?: SessionInfo }> =>
    request('POST', '/auth/login', body),
  logout: (): Promise<void> => request('POST', '/auth/logout', {}),
  me: (): Promise<{ user: SessionUser; session?: SessionInfo }> => request('GET', '/auth/me'),

  previewInvitation: (token: string): Promise<{ invitation: InvitationPreview }> =>
    request('POST', '/invitations/preview', { token }),
  acceptInvitation: (body: {
    token: string;
    display_name: string;
    password: string;
  }): Promise<{ user: SessionUser }> => request('POST', '/invitations/accept', body),

  listFacilities: (): Promise<{ facilities: Facility[] }> => request('GET', '/facilities'),
  createFacility: (body: CreateFacilityRequest): Promise<{ facility: Facility }> =>
    request('POST', '/facilities', body),
  getFacility: (id: string): Promise<{ facility: Facility }> => request('GET', `/facilities/${id}`),
  joinLink: (id: string): Promise<{ join_link: FacilityJoinLink }> =>
    request('GET', `/facilities/${id}/join-link`),

  listServices: (fid: string): Promise<{ services: Service[] }> =>
    request('GET', `/facilities/${fid}/services`),
  createService: (
    fid: string,
    body: { name: string; description?: string; policy: ServicePolicy },
  ): Promise<{ service: Service }> => request('POST', `/facilities/${fid}/services`, body),
  updateService: (
    fid: string,
    sid: string,
    body: { status?: 'active' | 'inactive'; policy?: ServicePolicy },
  ): Promise<{ service: Service }> => request('PATCH', `/facilities/${fid}/services/${sid}`, body),
  policyVersions: (fid: string, sid: string): Promise<{ versions: PolicyVersion[] }> =>
    request('GET', `/facilities/${fid}/services/${sid}/policy-versions`),

  listCounters: (fid: string): Promise<{ counters: Counter[] }> =>
    request('GET', `/facilities/${fid}/counters`),
  createCounter: (fid: string, name: string): Promise<{ counter: Counter }> =>
    request('POST', `/facilities/${fid}/counters`, { name }),
  updateCounter: (
    fid: string,
    cid: string,
    body: { active: boolean },
  ): Promise<{ counter: Counter; released?: { queue_id: string; public_code: string }[] }> =>
    request('PATCH', `/facilities/${fid}/counters/${cid}`, body),
  assignCapability: (counterId: string, serviceId: string): Promise<{ counter: Counter }> =>
    request('POST', '/counter_service_capabilities', {
      counter_id: counterId,
      service_id: serviceId,
    }),
  removeCapability: (counterId: string, serviceId: string): Promise<void> =>
    request('DELETE', `/counter_service_capabilities/${counterId}/${serviceId}`),

  readiness: (fid: string): Promise<{ readiness: FacilityReadiness }> =>
    request('GET', `/facilities/${fid}/readiness`),

  setStaffStatus: (
    staffId: string,
    status: 'active' | 'inactive',
  ): Promise<{ id: string; status: string }> => request('PATCH', `/staff/${staffId}`, { status }),

  listStaff: (
    fid: string,
  ): Promise<{ staff: StaffMember[]; org_admins: Omit<StaffMember, 'roles'>[] }> =>
    request('GET', `/facilities/${fid}/staff`),
  grantRole: (fid: string, staffId: string, role: FacilityRole): Promise<{ granted: boolean }> =>
    request('POST', `/facilities/${fid}/staff/${staffId}/roles`, { role }),
  revokeRole: (fid: string, staffId: string, role: FacilityRole): Promise<void> =>
    request('DELETE', `/facilities/${fid}/staff/${staffId}/roles/${role}`),
  listInvitations: (fid: string): Promise<{ invitations: Invitation[] }> =>
    request('GET', `/facilities/${fid}/invitations`),
  invite: (fid: string, body: { email: string; role: FacilityRole }): Promise<CreatedInvitation> =>
    request('POST', `/facilities/${fid}/invitations`, body),
  revokeInvitation: (fid: string, id: string): Promise<void> =>
    request('DELETE', `/facilities/${fid}/invitations/${id}`),

  // ---- M2: queues (staff) ----
  facilityQueues: (fid: string): Promise<{ queues: FacilityQueueSummary[] }> =>
    request('GET', `/facilities/${fid}/queues`),
  openQueue: (fid: string, serviceId: string): Promise<{ queue: StaffQueue }> =>
    request('POST', `/facilities/${fid}/queues`, { service_id: serviceId }),
  staffQueue: (queueId: string): Promise<{ queue: StaffQueue }> =>
    request('GET', `/queues/${queueId}`),
  command: (queueId: string, body: QueueCommandRequest): Promise<{ outcome: CommandOutcome }> =>
    request('POST', `/queues/${queueId}/commands`, body),
  walkIn: (queueId: string, operationId: string): Promise<{ ticket: JoinQueueResponse }> =>
    request('POST', `/queues/${queueId}/walk-ins`, { operation_id: operationId }),

  // ---- M4: fairness, routing and audit (supervisor actions are re-authorized server-side) ----
  priorityOverride: (
    ticketId: string,
    body: PriorityOverrideRequest,
  ): Promise<{ outcome: CommandOutcome }> =>
    request('POST', `/tickets/${ticketId}/priority-override`, body),
  callOutOfOrder: (
    ticketId: string,
    body: CallOutOfOrderRequest,
  ): Promise<{ outcome: CommandOutcome }> =>
    request('POST', `/tickets/${ticketId}/call-out-of-order`, body),
  counterTransfer: (
    ticketId: string,
    body: CounterTransferRequest,
  ): Promise<{ outcome: CommandOutcome }> =>
    request('POST', `/tickets/${ticketId}/counter-transfer`, body),
  setCounterAvailability: (
    counterId: string,
    body: CounterAvailabilityRequest,
  ): Promise<{ result: CounterAvailabilityResult }> =>
    request('POST', `/counters/${counterId}/availability`, body),
  audit: (queueId: string, afterSequence = 0, limit = 50): Promise<{ audit: AuditPage }> =>
    request('GET', `/queues/${queueId}/audit?after_sequence=${afterSequence}&limit=${limit}`),
  verifyAudit: (queueId: string): Promise<{ verification: AuditVerification }> =>
    request('GET', `/queues/${queueId}/audit/verify`),
  /** Read-only Recovery activity of this queue's tickets (design §15.9a) */
  recoveryAudit: (queueId: string, after: string | null, limit = 50): Promise<RecoveryAuditPage> =>
    request(
      'GET',
      `/queues/${queueId}/recovery/audit?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    ),

  // ---- M2: public / visitor ----
  publicFacility: (org: string, fac: string): Promise<{ facility: PublicFacility }> =>
    request('GET', `/public/facilities/${encodeURIComponent(org)}/${encodeURIComponent(fac)}`),
  board: (org: string, fac: string): Promise<{ board: Board }> =>
    request(
      'GET',
      `/public/facilities/${encodeURIComponent(org)}/${encodeURIComponent(fac)}/board`,
    ),
  join: (
    queueId: string,
    body: { operation_id: string; join_proof: string },
  ): Promise<{ ticket: JoinQueueResponse }> => request('POST', `/queues/${queueId}/join`, body),
  ticketStatus: (code: string, token: string): Promise<{ status: TicketStatus }> =>
    request('GET', `/tickets/${encodeURIComponent(code)}/status`, undefined, {
      [TICKET_TOKEN_HEADER]: token,
    }),

  // ---- M5.1: ticket recovery (visitor) ----
  /** Exchange the recovery key (with the PUBLIC identifiers) or a staff grant for a new token. */
  recoverTicket: (
    body:
      | { org_slug: string; facility_slug: string; ticket_code: string; recovery_key: string }
      | { grant: string },
  ): Promise<{ ticket: RecoveredTicket }> => request('POST', '/tickets/recover', body),
  newRecoveryKey: (code: string, token: string): Promise<RecoveryKeyResponse> =>
    request('POST', `/tickets/${encodeURIComponent(code)}/recovery-key`, {}, tokenHeader(token)),
  signOutOtherDevices: (code: string, token: string): Promise<RevokeOtherDevicesResponse> =>
    request(
      'POST',
      `/tickets/${encodeURIComponent(code)}/sessions/revoke-others`,
      {},
      tokenHeader(token),
    ),
  rejoin: (
    code: string,
    token: string,
    operationId: string,
  ): Promise<{ outcome: { disposition: string; reason_code: string | null } }> =>
    request(
      'POST',
      `/tickets/${encodeURIComponent(code)}/rejoin`,
      { operation_id: operationId },
      tokenHeader(token),
    ),

  // ---- M5.4: Smart Turn Alerts (Web Push is optional and best effort) ----
  pushCapability: (): Promise<PushCapability> => request('GET', '/push/capability'),
  subscribePush: (
    code: string,
    token: string,
    body: PushSubscribeRequest,
  ): Promise<PushSubscribeResponse> =>
    request(
      'POST',
      `/tickets/${encodeURIComponent(code)}/push-subscription`,
      body,
      tokenHeader(token),
    ),
  unsubscribePush: (code: string, token: string, ref: string): Promise<void> =>
    request(
      'DELETE',
      `/tickets/${encodeURIComponent(code)}/push-subscription`,
      { subscription_ref: ref },
      tokenHeader(token),
    ),
  /** First-party "seen on this device" (only the page can send it: it holds the token). */
  ackTurnAlert: (code: string, token: string, ref: string, sequence: number): Promise<void> =>
    request(
      'POST',
      `/tickets/${encodeURIComponent(code)}/alerts/ack`,
      { subscription_ref: ref, event_sequence: sequence },
      tokenHeader(token),
    ),
  queueAlerts: (queueId: string): Promise<{ alerts: StaffTicketAlerts[] }> =>
    request('GET', `/queues/${queueId}/alerts`),

  // ---- M5.1: staff-assisted recovery (restricted procedure) ----
  recoveryAssist: (
    queueId: string,
    ticketId: string,
    body: RecoveryAssistRequest,
  ): Promise<RecoveryAssistResponse> =>
    request('POST', `/queues/${queueId}/tickets/${ticketId}/recovery/assist`, body),
  recoveryApprove: (
    queueId: string,
    ticketId: string,
    requestId: string,
  ): Promise<{ status: RecoveryRequestStatus }> =>
    request('POST', `/queues/${queueId}/tickets/${ticketId}/recovery/approve`, {
      request_id: requestId,
    }),
  recoveryRequestStatus: (
    queueId: string,
    ticketId: string,
    requestId: string,
  ): Promise<{ status: RecoveryRequestStatus }> =>
    request('GET', `/queues/${queueId}/tickets/${ticketId}/recovery/requests/${requestId}`),
  recoveryRequests: (queueId: string): Promise<{ requests: RecoveryRequestSummary[] }> =>
    request('GET', `/queues/${queueId}/recovery/requests`),
  recoveryRevokeAll: (
    queueId: string,
    ticketId: string,
    body: RecoveryRevokeAllRequest,
  ): Promise<{ revoked_tokens: number }> =>
    request('POST', `/queues/${queueId}/tickets/${ticketId}/recovery/revoke-all`, body),

  // ---- M3: continuity engine ----
  registerDevice: (facilityId: string, label?: string): Promise<{ device: Device }> =>
    request('POST', '/devices', { facility_id: facilityId, ...(label ? { label } : {}) }),
  heartbeat: (
    deviceId: string,
    body: { pending_count: number; failure_code?: 'storage_unavailable' | 'sync_failed' | null },
  ): Promise<void> => request('POST', `/devices/${deviceId}/heartbeat`, body),
  revokeDevice: (deviceId: string, reason: string): Promise<{ device: Device }> =>
    request('POST', `/devices/${deviceId}/revoke`, { reason_code: reason }),
  syncBatch: (body: {
    commands: unknown[];
    authorities?: string[];
    device_report?: { pending_count: number };
  }): Promise<SyncBatchResponse> => request('POST', '/sync/batches', body),
  syncSnapshot: (
    queueId: string,
    deviceId: string | null,
    since?: number,
  ): Promise<{ snapshot: SyncSnapshot }> => {
    const qs = new URLSearchParams();
    if (deviceId) qs.set('device_id', deviceId);
    if (since !== undefined) qs.set('since_sequence', String(since));
    const q = qs.toString();
    return request('GET', `/sync/queues/${queueId}/snapshot${q ? `?${q}` : ''}`);
  },
  coordinator: (
    queueId: string,
    kind: 'assign' | 'failover' | 'renew' | 'revoke',
    body: Record<string, unknown>,
  ): Promise<CoordinatorResult> =>
    request('POST', `/queues/${queueId}/coordinator${kind === 'assign' ? '' : `/${kind}`}`, body),
  operationsHealth: (fid: string): Promise<{ health: OperationsHealth }> =>
    request('GET', `/facilities/${fid}/operations/health`),
  // ---- M5.3: device-health alerts (in-product only) ----
  acknowledgeAlert: (fid: string, alertId: string): Promise<{ alert: HealthAlert }> =>
    request('POST', `/facilities/${fid}/health/alerts/${alertId}/acknowledge`, {}),
  alertSummary: (): Promise<{ summary: AlertSummary }> => request('GET', '/health/alerts/summary'),
  ownDeviceHealth: (deviceId: string): Promise<{ device: OwnDeviceHealth }> =>
    request('GET', `/devices/${deviceId}/health`),
  conflicts: (fid: string, includeResolved = false): Promise<{ conflicts: SyncConflict[] }> =>
    request('GET', `/facilities/${fid}/sync/conflicts${includeResolved ? '?include=all' : ''}`),
  resolveConflict: (
    operationId: string,
    body: { resolution: 'apply' | 'dismiss'; reason_code: string },
  ): Promise<{ result: { resolution: string; already_resolved: boolean } }> =>
    request('POST', `/sync/conflicts/${operationId}/resolve`, body),
  /**
   * Server health validation: the only way to restore "reachable" after an outage. The answer
   * counts only if no outage began while the probe was in flight and the browser is online.
   */
  ping: async (): Promise<boolean> => {
    const sentInEpoch = outageEpoch;
    try {
      const res = await fetch(`${BASE}/health`, { cache: 'no-store' });
      if (!res.ok) {
        reportUnreachable();
        return false;
      }
      if (sentInEpoch !== outageEpoch || !browserOnline()) return false;
      apiReachable = true;
      networkObserver?.(true);
      return true;
    } catch {
      reportUnreachable();
      return false;
    }
  },
};
