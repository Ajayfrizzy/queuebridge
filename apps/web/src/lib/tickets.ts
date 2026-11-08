import { randomSecret, uuidv7 } from '@queuebridge/contracts';

/**
 * Visitor tickets remembered on THIS device (REQ-F4.2: survive refresh/restart). Stores only the
 * public code, the status token and display names — never phone numbers or other personal data
 * (security steering: browser storage on shared devices). The visitor can forget a ticket.
 *
 * Public codes are NOT unique: numbering restarts per queue session and two facilities may both
 * issue `A001`. Each stored ticket therefore has a device-local `id`, which is what storage and
 * navigation (`/ticket/:code?k=<id>`) key on. The id is not a credential — the status token is.
 */
export interface StoredTicket {
  /** Device-local identity of this saved ticket (not sent to the server). */
  id: string;
  code: string;
  token: string;
  facilityName: string;
  serviceName: string;
  /** /join/:org/:facility path, to link back */
  joinPath: string | null;
  savedAt: string;
}

export type NewStoredTicket = Omit<StoredTicket, 'id'> & { id?: string | undefined };

/** A join that was sent but whose response may have been lost (lost-ACK recovery). */
export interface PendingJoin {
  queueId: string;
  serviceName: string;
  operationId: string;
  joinProof: string;
  createdAt: string;
}

const TICKETS_KEY = 'qb.tickets.v1';
const PENDING_KEY = 'qb.pendingJoins.v1';
const MAX_TICKETS = 20;

/**
 * Pending joins that could not be written to storage (disabled/full). Kept for the life of the
 * page so a retry still reuses the same operation id and proof and cannot create a second ticket.
 */
const volatilePending = new Map<string, PendingJoin>();

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, value: T[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage full or disabled (private mode): the caller must warn the visitor
    return false;
  }
}

/** Entries saved before tickets had a local id: their code was unique on the device then. */
const legacyId = (code: string): string => `legacy-${code}`;

export function ticketPath(t: Pick<StoredTicket, 'code' | 'id'>): string {
  return `/ticket/${encodeURIComponent(t.code)}?k=${encodeURIComponent(t.id)}`;
}

export function storedTickets(): StoredTicket[] {
  return read<Partial<StoredTicket>>(TICKETS_KEY)
    .filter((t): t is Omit<StoredTicket, 'id'> & { id?: string } =>
      Boolean(t && typeof t.code === 'string' && typeof t.token === 'string'),
    )
    .map((t) => ({ ...t, id: typeof t.id === 'string' && t.id ? t.id : legacyId(t.code) }));
}

export function findTicketById(id: string): StoredTicket | undefined {
  return storedTickets().find((t) => t.id === id);
}

export function findTicketByToken(token: string): StoredTicket | undefined {
  return storedTickets().find((t) => t.token === token);
}

/** All saved tickets with this public code (there may be several, from different queues). */
export function ticketsWithCode(code: string): StoredTicket[] {
  return storedTickets().filter((t) => t.code === code);
}

/**
 * Save a new ticket, or update the one with the same `id` (e.g. after a transfer changes its
 * code). Never replaces a different ticket that merely shares the public code. Returns the saved
 * entry, or null if the device could not store it.
 */
export function saveTicket(t: NewStoredTicket): StoredTicket | null {
  const entry: StoredTicket = { ...t, id: t.id ?? uuidv7() };
  const others = storedTickets().filter((x) => x.id !== entry.id);
  return write(TICKETS_KEY, [entry, ...others].slice(0, MAX_TICKETS)) ? entry : null;
}

export function forgetTicket(id: string): void {
  write(
    TICKETS_KEY,
    storedTickets().filter((t) => t.id !== id),
  );
}

export function pendingJoins(): PendingJoin[] {
  const stored = read<PendingJoin>(PENDING_KEY);
  return [
    ...stored,
    ...[...volatilePending.values()].filter((v) => !stored.some((s) => s.queueId === v.queueId)),
  ];
}

/** True when this pending join lives only in page memory (lost on reload). */
export function isPendingVolatile(queueId: string): boolean {
  return volatilePending.has(queueId);
}

/**
 * Create and PERSIST the idempotency key + join proof before the request is sent, so that a
 * retry after a lost response reuses them and cannot create a second ticket. If storage fails,
 * the pending join is kept in page memory instead (see `isPendingVolatile`).
 */
export function beginJoin(queueId: string, serviceName: string): PendingJoin {
  const existing = pendingJoins().find((p) => p.queueId === queueId);
  if (existing) return existing;
  const p: PendingJoin = {
    queueId,
    serviceName,
    operationId: uuidv7(),
    joinProof: randomSecret(),
    createdAt: new Date().toISOString(),
  };
  if (!write(PENDING_KEY, [...read<PendingJoin>(PENDING_KEY), p])) volatilePending.set(queueId, p);
  return p;
}

export function finishJoin(queueId: string): void {
  volatilePending.delete(queueId);
  write(
    PENDING_KEY,
    read<PendingJoin>(PENDING_KEY).filter((p) => p.queueId !== queueId),
  );
}

/** Read and remove a `#t=<token>` fragment (staff walk-in links) without it reaching history. */
export function takeTokenFromHash(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const t = params.get('t');
  if (t) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return t;
}
