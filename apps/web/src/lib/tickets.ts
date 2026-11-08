import { randomSecret, uuidv7 } from '@queuebridge/contracts';

/**
 * Visitor tickets remembered on THIS device (REQ-F4.2: survive refresh/restart). Stores only the
 * public code, the status token and display names — never phone numbers or other personal data
 * (security steering: browser storage on shared devices). The visitor can forget a ticket.
 */
export interface StoredTicket {
  code: string;
  token: string;
  facilityName: string;
  serviceName: string;
  /** /join/:org/:facility path, to link back */
  joinPath: string | null;
  savedAt: string;
}

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

export function storedTickets(): StoredTicket[] {
  return read<StoredTicket>(TICKETS_KEY);
}

export function findTicket(code: string): StoredTicket | undefined {
  return storedTickets().find((t) => t.code === code);
}

/** Save or replace (same code) — returns false if the device could not store it. */
export function saveTicket(t: StoredTicket): boolean {
  return write(TICKETS_KEY, [t, ...storedTickets().filter((x) => x.code !== t.code)].slice(0, 20));
}

export function forgetTicket(code: string): void {
  write(
    TICKETS_KEY,
    storedTickets().filter((t) => t.code !== code),
  );
}

export function pendingJoins(): PendingJoin[] {
  return read<PendingJoin>(PENDING_KEY);
}

/**
 * Create and PERSIST the idempotency key + join proof before the request is sent, so that a
 * retry after a lost response reuses them and cannot create a second ticket.
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
  write(PENDING_KEY, [...pendingJoins(), p]);
  return p;
}

export function finishJoin(queueId: string): void {
  write(
    PENDING_KEY,
    pendingJoins().filter((p) => p.queueId !== queueId),
  );
}

/** Read and remove a `#t=<token>` fragment (staff walk-in links) without it reaching history. */
export function takeTokenFromHash(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const t = params.get('t');
  if (t) window.history.replaceState(null, '', window.location.pathname);
  return t;
}
