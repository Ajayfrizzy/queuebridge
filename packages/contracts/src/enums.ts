/**
 * QueueBridge shared enumerations.
 * All values are string literals for readability in logs and API responses.
 */

/** Staff and visitor roles — server-side RBAC only; never trust client-supplied roles. */
export const Role = {
  VISITOR_ANONYMOUS: 'visitor_anonymous',
  STAFF_RECEPTION: 'staff_reception',
  STAFF_COUNTER: 'staff_counter',
  SUPERVISOR: 'supervisor',
  FACILITY_ADMIN: 'facility_admin',
  ORG_ADMIN: 'org_admin',
  AUDITOR: 'auditor',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Primary ticket states — see architecture §4 for full transition table. */
export const TicketState = {
  WAITING: 'waiting',
  CALLED: 'called',
  SERVING: 'serving',
  PAUSED: 'paused',
  MISSED: 'missed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  TRANSFERRED: 'transferred',
  NEEDS_REVIEW: 'needs_review',
} as const;
export type TicketState = (typeof TicketState)[keyof typeof TicketState];

/** Offline sync status — every operation visible to staff or visitors must show one of these. */
export const SyncStatus = {
  LOCAL_ONLY: 'local_only',
  PENDING_SYNC: 'pending_sync',
  COMMITTED: 'committed',
  DUPLICATE: 'duplicate',
  NEEDS_REVIEW: 'needs_review',
  REJECTED: 'rejected',
} as const;
export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

/** Server disposition for a single synced command. */
export const CommandDisposition = {
  COMMITTED: 'committed',
  DUPLICATE: 'duplicate',
  REJECTED: 'rejected',
  NEEDS_REVIEW: 'needs_review',
} as const;
export type CommandDisposition = (typeof CommandDisposition)[keyof typeof CommandDisposition];

/** Queue session state. */
export const QueueSessionState = {
  OPEN: 'open',
  PAUSED: 'paused',
  CLOSED: 'closed',
} as const;
export type QueueSessionState = (typeof QueueSessionState)[keyof typeof QueueSessionState];

/** Priority class — facility configures these; NORMAL is always present. */
export const PriorityClass = {
  NORMAL: 'normal',
  PRIORITY: 'priority',
  URGENT: 'urgent',
} as const;
export type PriorityClass = (typeof PriorityClass)[keyof typeof PriorityClass];

/** Queue command action types. */
export const QueueAction = {
  TICKET_CREATE: 'ticket.create',
  TICKET_CALL_NEXT: 'ticket.call_next',
  TICKET_CALL_SPECIFIC: 'ticket.call_specific',
  TICKET_SERVE: 'ticket.serve',
  TICKET_COMPLETE: 'ticket.complete',
  TICKET_PAUSE: 'ticket.pause',
  TICKET_RESUME: 'ticket.resume',
  TICKET_MISS: 'ticket.miss',
  TICKET_CANCEL: 'ticket.cancel',
  TICKET_TRANSFER: 'ticket.transfer',
  TICKET_PRIORITY_OVERRIDE: 'ticket.priority_override',
  QUEUE_OPEN: 'queue.open',
  QUEUE_PAUSE: 'queue.pause',
  QUEUE_CLOSE: 'queue.close',
  COORDINATOR_ASSIGN: 'coordinator.assign',
  COORDINATOR_REVOKE: 'coordinator.revoke',
  COORDINATOR_FAILOVER: 'coordinator.failover',
} as const;
export type QueueAction = (typeof QueueAction)[keyof typeof QueueAction];

/** Notification channel types. */
export const NotificationChannel = {
  SMS: 'sms',
  USSD: 'ussd',
  IN_APP: 'in_app',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/** Notification delivery status. */
export const DeliveryStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

/** Facility operational status. */
export const FacilityStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
} as const;
export type FacilityStatus = (typeof FacilityStatus)[keyof typeof FacilityStatus];
