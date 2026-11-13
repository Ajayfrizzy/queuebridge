import { formatRecoveryKey } from '@queuebridge/contracts';

/**
 * The recovery key is shown ONCE, right after joining (or at the desk for a walk-in). It lives
 * in page memory only: never in localStorage, IndexedDB, the offline outbox, a URL query, a log
 * or a cookie (REQ-F4.8, security steering). A page reload therefore forgets it, which is why the
 * ticket page asks the visitor to save it and offers a replacement ("Get a new recovery key").
 */
export interface FreshRecoveryKey {
  /** Public ticket code the key belongs to */
  code: string;
  key: string;
  /** Public path /recover/:org/:facility/:code (no secret) */
  path: string;
}

let fresh: FreshRecoveryKey | null = null;

export function stashRecoveryKey(k: FreshRecoveryKey): void {
  fresh = k;
}

/** Peek (do not remove): the page may re-render. Returns null for a different ticket. */
export function peekRecoveryKey(code: string): FreshRecoveryKey | null {
  return fresh && fresh.code === code ? fresh : null;
}

export function discardRecoveryKey(): void {
  fresh = null;
}

/**
 * The link a visitor can scan or open on another device. The key travels only in the URL
 * FRAGMENT: browsers never send it to the server, never in Referer, and the recover page removes
 * it from the address bar after reading it.
 */
export function recoveryLink(origin: string, path: string, key: string): string {
  return `${origin}${path}#k=${key}`;
}

/** Plain-text file for "Save": readable, grouped, with the plain-language rules. */
export function recoveryKeyText(facility: string, code: string, key: string): string {
  return [
    `QueueBridge recovery key for ticket ${code} at ${facility}`,
    '',
    formatRecoveryKey(key),
    '',
    'Keep this private. With it, anyone can get access to your ticket status.',
    'Your ticket code alone cannot be used to recover your ticket.',
    'Open the QueueBridge recover page and enter the facility, ticket code and this key.',
  ].join('\n');
}

/** Read `k` from a URL fragment like `#t=...&k=...` without exposing other parameters. */
export function fragmentParam(hash: string, name: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(name);
}
