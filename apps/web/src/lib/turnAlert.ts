import type { TicketStatus } from '@queuebridge/contracts';

/**
 * M5.4 Smart Turn Alerts, page side (REQ-F14.1–F14.5; design §12.3, §12.5.7). Pure helpers so
 * the rules can be unit-tested without a browser.
 */

// ---------------------------------------------------------------------------------------------
// Once per call (REQ-F14.1.4): the announcement, sound and vibration run once per COMMITTED call
// event. A refresh, a live-update replay or a reconnect that shows the same call changes nothing;
// a new call (a different call sequence) alerts again. Kept in sessionStorage (this tab only, no
// personal data) so a reload of the page does not repeat it.
// ---------------------------------------------------------------------------------------------

const ALERTED_KEY = 'qb.turnAlerted.v1';
/** In-page copy for when sessionStorage is unavailable (private mode, quota). */
const volatileAlerted = new Map<string, number>();

function alertedMap(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(ALERTED_KEY) ?? '{}');
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export function lastAlertedSequence(ticketKey: string): number | null {
  const v = alertedMap()[ticketKey] ?? volatileAlerted.get(ticketKey);
  return typeof v === 'number' ? v : null;
}

export function markAlerted(ticketKey: string, sequence: number): void {
  volatileAlerted.set(ticketKey, sequence);
  try {
    sessionStorage.setItem(ALERTED_KEY, JSON.stringify({ ...alertedMap(), [ticketKey]: sequence }));
  } catch {
    // the in-page copy still prevents repeats for this page's life
  }
}

/**
 * The call sequence to alert for now, or null. Only a server-confirmed `called` state with a
 * committed call sequence can alert; anything local, cached or already alerted cannot.
 */
export function callToAlert(
  status: Pick<TicketStatus, 'state' | 'call_sequence'> | undefined,
  opts: { cached: boolean; alreadyAlerted: number | null },
): number | null {
  if (!status || opts.cached) return null;
  if (status.state !== 'called' || status.call_sequence === null) return null;
  return status.call_sequence === opts.alreadyAlerted ? null : status.call_sequence;
}

// ---------------------------------------------------------------------------------------------
// Opening a notification (design §12.5.7): `/ticket/<code>?ref=<ref>[&seq=<n>][&rp=<path>]`.
// Every value is a lookup key or a public path; none is a credential. Each is validated so a
// crafted link can neither inject markup nor redirect elsewhere.
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RP_RE = /^\/recover\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%-]+$/;

export interface AlertOpenParams {
  ref: string | null;
  seq: number | null;
  rp: string | null;
}

export function parseAlertOpenParams(search: URLSearchParams): AlertOpenParams {
  const ref = search.get('ref');
  const seq = Number(search.get('seq'));
  const rp = search.get('rp');
  return {
    ref: ref && UUID_RE.test(ref) ? ref.toLowerCase() : null,
    seq: Number.isSafeInteger(seq) && seq > 0 ? seq : null,
    rp: rp && RP_RE.test(rp) ? rp : null,
  };
}

/** A push hand-off message from the service worker (validated; anything else is ignored). */
export interface TurnAlertHandoff {
  ref: string;
  code: string;
  seq: number;
  counter: string;
  rp: string | null;
}

export function parseHandoff(data: unknown): TurnAlertHandoff | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d['type'] !== 'qb-turn-alert') return null;
  const ref = typeof d['ref'] === 'string' && UUID_RE.test(d['ref']) ? d['ref'].toLowerCase() : '';
  const code =
    typeof d['code'] === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(d['code']) ? d['code'] : '';
  const seq = typeof d['seq'] === 'number' && Number.isSafeInteger(d['seq']) ? d['seq'] : 0;
  const counter = typeof d['counter'] === 'string' ? d['counter'].slice(0, 120) : '';
  const rp = typeof d['rp'] === 'string' && RP_RE.test(d['rp']) ? d['rp'] : null;
  if (!ref || !code || seq <= 0) return null;
  return { ref, code, seq, counter, rp };
}

// ---------------------------------------------------------------------------------------------
// Web Push support (REQ-F14.4; design §12.5.6). Detected, never assumed.
// ---------------------------------------------------------------------------------------------

export type PushSupport =
  | 'supported'
  /** iPhone/iPad Safari outside an installed Home Screen app */
  | 'ios_not_installed'
  | 'unsupported';

export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  isStandalone: boolean;
}

export function readPushEnvironment(): PushEnvironment {
  const w = typeof window === 'undefined' ? undefined : window;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ua = nav?.userAgent ?? '';
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS reports itself as a Mac with touch
    (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  const standalone =
    Boolean(w?.matchMedia?.('(display-mode: standalone)').matches) ||
    (nav as unknown as { standalone?: boolean } | undefined)?.standalone === true;
  return {
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    hasPushManager: Boolean(w && 'PushManager' in w),
    hasNotification: Boolean(w && 'Notification' in w),
    isIos,
    isStandalone: standalone,
  };
}

export function pushSupport(env: PushEnvironment): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'supported';
  if (env.isIos && !env.isStandalone) return 'ios_not_installed';
  return 'unsupported';
}

/** VAPID application server key (base64url) as the bytes `pushManager.subscribe` expects. */
export function applicationServerKey(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
