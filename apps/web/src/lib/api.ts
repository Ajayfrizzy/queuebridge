import type {
  ApiError,
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
} from '@queuebridge/contracts';

const BASE: string =
  (import.meta.env['VITE_API_BASE_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';

let onUnauthenticated: (() => void) | null = null;

/** Register a callback fired when an authenticated request is rejected with 401 (session ended). */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/** Paths where a 401 is an expected answer (bad credentials / probing), not a lost session. */
const PUBLIC_401 = ['/auth/login', '/auth/me', '/invitations/'];

/** An RFC 9457 problem response from the API (or a network failure with status 0). */
export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly problem: ApiError | null;

  public constructor(status: number, problem: ApiError | null, message: string) {
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json, application/problem+json',
        // Cross-site request protection header required by the API for cookie-authenticated writes
        'X-QB-CSRF': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiRequestError(0, null, 'Cannot reach the server. Check your connection and retry.');
  }

  if (res.status === 204) return undefined as T;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
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

export const api = {
  signupOrganization: (body: CreateOrganizationRequest): Promise<{ user: SessionUser }> =>
    request('POST', '/organizations', body),
  login: (body: LoginRequest): Promise<{ user: SessionUser }> =>
    request('POST', '/auth/login', body),
  logout: (): Promise<void> => request('POST', '/auth/logout', {}),
  me: (): Promise<{ user: SessionUser }> => request('GET', '/auth/me'),

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
    body: { status?: 'active' | 'inactive' },
  ): Promise<{ service: Service }> => request('PATCH', `/facilities/${fid}/services/${sid}`, body),

  listCounters: (fid: string): Promise<{ counters: Counter[] }> =>
    request('GET', `/facilities/${fid}/counters`),
  createCounter: (fid: string, name: string): Promise<{ counter: Counter }> =>
    request('POST', `/facilities/${fid}/counters`, { name }),
  updateCounter: (
    fid: string,
    cid: string,
    body: { active: boolean },
  ): Promise<{ counter: Counter }> => request('PATCH', `/facilities/${fid}/counters/${cid}`, body),
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
};
