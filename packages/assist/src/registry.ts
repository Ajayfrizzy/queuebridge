import {
  AUDIENCES,
  Permission,
  QueueAction,
  type Role,
  TicketState,
  type Audience,
  type PermissionName,
  type RouteId,
} from '@queuebridge/contracts';
import { audienceForRole } from './audiences.js';

/**
 * Ask Que route / screen registry (MQ.1; design §11.3 and §11.3.1, verified against the API and
 * the web router on 2026-11-16).
 *
 * The web router guards protected screens by sign-in only; the screen permission recorded here
 * is the permission the API enforces for the screen's primary data. `/supervisor/*` is a
 * placeholder page and is deliberately NOT registered (readiness report F7).
 */

export type RouteAccess =
  /** Anyone, no account. */
  | { kind: 'public' }
  /** Any signed-in staff user. */
  | { kind: 'signed_in' }
  /** Needs a bearer credential Que never holds (device status token, invitation token). */
  | { kind: 'credential' }
  /** A named API permission at the facility the screen belongs to. */
  | { kind: 'permission'; permission: PermissionName };

/**
 * A ticket operation available on a screen, identified by its state-machine transition
 * (`action` from `from`). Its role requirement is NOT written here: it is resolved from the
 * domain transition table (`operationRoles`), so there is no second role list (design §11.3).
 */
export interface QueueOperation {
  id: string;
  action: QueueAction;
  from: TicketState;
}

export interface RouteEntry {
  id: RouteId;
  /** React Router path pattern, exactly as declared in `apps/web/src/App.tsx`. */
  path: string;
  access: RouteAccess;
  /** Which context the path parameters come from. */
  scope: 'none' | 'facility_slugs' | 'facility' | 'queue';
  /** Whether Que may build a navigation link to this screen. */
  linkable: boolean;
  /** Audiences for whom the screen is relevant (derived from access for permission routes). */
  audiences: readonly Audience[];
  /** Article ids shown under "On this screen" (filtered by audience and capability). */
  defaultArticles: readonly string[];
  /** Permissions needed for in-screen steps beyond opening the screen. */
  actionPermissions: readonly PermissionName[];
  /** Ticket operations on this screen, gated by the ticket state machine. */
  operations: readonly QueueOperation[];
}

const STAFF_AUDIENCES: readonly Audience[] = AUDIENCES.filter((a) => a !== 'visitor');

/** Audiences that can open a permission-gated screen: the permission's roles plus `org_admin`. */
export function audiencesForPermission(permission: PermissionName): Audience[] {
  const set = new Set<Audience>(['org_admin']);
  for (const r of Permission[permission] as readonly Role[]) set.add(audienceForRole(r));
  return AUDIENCES.filter((a) => set.has(a));
}

function audiencesForAccess(access: RouteAccess): readonly Audience[] {
  switch (access.kind) {
    case 'public':
    case 'credential':
      return AUDIENCES;
    case 'signed_in':
      return STAFF_AUDIENCES;
    case 'permission':
      return audiencesForPermission(access.permission);
  }
}

/** Ticket operations on the staff console (each must exist in the domain transition table). */
export const CONSOLE_OPERATIONS: readonly QueueOperation[] = [
  { id: 'call_next', action: QueueAction.TICKET_CALL_NEXT, from: TicketState.WAITING },
  { id: 'call_specific', action: QueueAction.TICKET_CALL_SPECIFIC, from: TicketState.WAITING },
  { id: 'serve', action: QueueAction.TICKET_SERVE, from: TicketState.CALLED },
  { id: 'complete', action: QueueAction.TICKET_COMPLETE, from: TicketState.SERVING },
  { id: 'miss', action: QueueAction.TICKET_MISS, from: TicketState.CALLED },
  { id: 'recall', action: QueueAction.TICKET_RESUME, from: TicketState.CALLED },
  { id: 'resume_missed', action: QueueAction.TICKET_RESUME, from: TicketState.MISSED },
  { id: 'pause', action: QueueAction.TICKET_PAUSE, from: TicketState.WAITING },
  { id: 'resume_paused', action: QueueAction.TICKET_RESUME, from: TicketState.PAUSED },
  { id: 'cancel_waiting', action: QueueAction.TICKET_CANCEL, from: TicketState.WAITING },
  { id: 'cancel_missed', action: QueueAction.TICKET_CANCEL, from: TicketState.MISSED },
  { id: 'transfer', action: QueueAction.TICKET_TRANSFER, from: TicketState.WAITING },
  {
    id: 'counter_transfer',
    action: QueueAction.TICKET_COUNTER_TRANSFER,
    from: TicketState.CALLED,
  },
  {
    id: 'priority_override',
    action: QueueAction.TICKET_PRIORITY_OVERRIDE,
    from: TicketState.WAITING,
  },
];

interface EntrySpec {
  path: string;
  access: RouteAccess;
  scope: RouteEntry['scope'];
  linkable: boolean;
  defaultArticles?: readonly string[];
  actionPermissions?: readonly PermissionName[];
  operations?: readonly QueueOperation[];
  audiences?: readonly Audience[];
}

const SPECS: Readonly<Record<RouteId, EntrySpec>> = {
  'public.home': {
    path: '/',
    access: { kind: 'public' },
    scope: 'none',
    linkable: true,
    defaultArticles: ['visitor.join.status', 'visitor.recovery.how', 'org.signup', 'org.signin'],
  },
  'public.signup': {
    path: '/signup',
    access: { kind: 'public' },
    scope: 'none',
    linkable: true,
    audiences: ['visitor'],
    defaultArticles: ['org.signup'],
  },
  'public.login': {
    path: '/login',
    access: { kind: 'public' },
    scope: 'none',
    linkable: true,
    defaultArticles: ['org.signin'],
  },
  // Never linked: it needs an invitation token Que does not hold
  'public.accept_invite': {
    path: '/accept-invite',
    access: { kind: 'credential' },
    scope: 'none',
    linkable: false,
    defaultArticles: ['staff.invite.accept'],
  },
  'visitor.join': {
    path: '/join/:orgSlug/:facilitySlug',
    access: { kind: 'public' },
    scope: 'facility_slugs',
    linkable: true,
    audiences: ['visitor'],
    defaultArticles: [
      'visitor.join.status',
      'visitor.wait.estimate',
      'visitor.recovery.key',
      'visitor.accessibility',
      'visitor.alerts.sms',
    ],
  },
  // Never linked: the ticket is resolved from the ticket saved on the device (status token)
  'visitor.ticket': {
    path: '/ticket/:code',
    access: { kind: 'credential' },
    scope: 'none',
    linkable: false,
    audiences: ['visitor'],
    defaultArticles: [
      'visitor.join.status',
      'visitor.alerts',
      'visitor.missed.grace',
      'visitor.auto_miss',
      'visitor.recovery.key',
      'visitor.offline',
      'visitor.ticket.states',
      'visitor.wait.estimate',
      'visitor.alerts.push',
      'visitor.alerts.sms',
    ],
  },
  // Linked as `/recover` only: the key or grant travels in the URL fragment, never from Que
  'visitor.recover': {
    path: '/recover',
    access: { kind: 'public' },
    scope: 'none',
    linkable: true,
    audiences: ['visitor'],
    defaultArticles: ['visitor.recovery.how', 'visitor.recovery.staff'],
  },
  'public.display': {
    path: '/display/:orgSlug/:facilitySlug',
    access: { kind: 'public' },
    scope: 'facility_slugs',
    linkable: true,
    defaultArticles: ['visitor.display.board', 'visitor.join.status'],
  },
  'admin.home': {
    path: '/admin',
    access: { kind: 'signed_in' },
    scope: 'none',
    linkable: true,
    defaultArticles: ['admin.facility.create', 'staff.roles.workflows'],
  },
  'admin.facility': {
    path: '/admin/facilities/:id',
    access: { kind: 'permission', permission: 'FACILITY_READ' },
    scope: 'facility',
    linkable: true,
    actionPermissions: ['FACILITY_CONFIGURE'],
    defaultArticles: [
      'admin.readiness.join_link',
      'admin.services',
      'admin.counters',
      'admin.policy.recovery',
      'admin.que_ai',
    ],
  },
  'admin.facility.channels': {
    path: '/admin/facilities/:id/channels',
    access: { kind: 'permission', permission: 'FACILITY_READ' },
    scope: 'facility',
    linkable: true,
    actionPermissions: ['FACILITY_CONFIGURE'],
    defaultArticles: ['admin.channels.sms', 'admin.channels.ussd', 'admin.readiness.join_link'],
  },
  'admin.facility.staff': {
    path: '/admin/facilities/:id/staff',
    access: { kind: 'permission', permission: 'STAFF_MANAGE' },
    scope: 'facility',
    linkable: true,
    defaultArticles: ['admin.staff.invite', 'staff.roles.workflows'],
  },
  'staff.home': {
    path: '/staff',
    access: { kind: 'signed_in' },
    scope: 'none',
    linkable: true,
    defaultArticles: ['staff.roles.workflows', 'staff.queue.open', 'org.signin'],
  },
  'staff.facility': {
    path: '/staff/facilities/:fid',
    access: { kind: 'permission', permission: 'QUEUE_VIEW' },
    scope: 'facility',
    linkable: true,
    defaultArticles: [
      'staff.queue.open',
      'admin.readiness.join_link',
      'staff.sync.states',
      'staff.roles.workflows',
    ],
  },
  'staff.console': {
    path: '/staff/queues/:queueId',
    access: { kind: 'permission', permission: 'QUEUE_VIEW' },
    scope: 'queue',
    linkable: true,
    actionPermissions: ['WALK_IN', 'QUEUE_MANAGE'],
    operations: CONSOLE_OPERATIONS,
    defaultArticles: [
      'staff.counter.calling',
      'staff.walkin',
      'staff.sync.states',
      'staff.recovery.assist',
      'staff.recovery.approve',
      'staff.missed.rejoin',
      'staff.fairness.priority',
      'staff.transfers',
      'staff.alerts.status',
      'staff.sms.alerts',
      'staff.coordinator.limits',
      'staff.auto_miss',
      'staff.audit.trail',
    ],
  },
  'staff.audit': {
    path: '/staff/queues/:queueId/audit',
    access: { kind: 'permission', permission: 'AUDIT_VIEW' },
    scope: 'queue',
    linkable: true,
    defaultArticles: ['staff.audit.trail', 'staff.recovery.activity'],
  },
  'staff.connectivity': {
    path: '/staff/facilities/:fid/connectivity',
    access: { kind: 'permission', permission: 'OPERATIONS_VIEW' },
    scope: 'facility',
    linkable: true,
    actionPermissions: ['QUEUE_MANAGE'],
    defaultArticles: [
      'staff.device.health',
      'staff.sync.states',
      'staff.conflicts.review',
      'staff.coordinator.manage',
      'staff.coordinator.limits',
      'staff.device.lost',
      'staff.alerts.status',
    ],
  },
};

function build(): Readonly<Record<RouteId, RouteEntry>> {
  const out = {} as Record<RouteId, RouteEntry>;
  for (const [id, spec] of Object.entries(SPECS) as [RouteId, EntrySpec][]) {
    out[id] = Object.freeze({
      id,
      path: spec.path,
      access: spec.access,
      scope: spec.scope,
      linkable: spec.linkable,
      audiences: spec.audiences ?? audiencesForAccess(spec.access),
      defaultArticles: spec.defaultArticles ?? [],
      actionPermissions: spec.actionPermissions ?? [],
      operations: spec.operations ?? [],
    });
  }
  return Object.freeze(out);
}

export const ROUTE_REGISTRY: Readonly<Record<RouteId, RouteEntry>> = build();

/** Paths deliberately not registered (placeholders); Que never links to them. */
export const UNREGISTERED_PATHS: readonly string[] = ['/supervisor/*'];
