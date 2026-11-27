import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { type SmsTemplate, SMS_TEMPLATES } from '@queuebridge/contracts';

/**
 * M6.1 SMS support shared by the API, the worker and every SMS adapter (design §13, ADR-009).
 * Pure functions over `node:crypto`; no network. Provider-neutral: a live adapter reuses the
 * templates and the contact cipher and supplies only its own send, signature and receipt formats.
 */

// ---------------------------------------------------------------------------
// Templates (REQ-F11.1). No name, phone number, internal id or link: only the public ticket
// code, the counter label and (for joins) the service name. Sandbox text is labelled [TEST].
// ---------------------------------------------------------------------------

/** GSM-7 single-segment length; longer messages cost more, so labels are trimmed to fit. */
export const SMS_MAX_CHARS = 160;
export const SMS_TEST_PREFIX = '[TEST] ';

const LABEL_MAX = 40;

/** Strip control characters and collapse spaces; trim to a short label. */
function label(v: string | undefined): string {
  let out = '';
  for (const ch of v ?? '') {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
}

/** A public ticket code (letters and digits only, as shown on the board). */
function code(v: string | undefined): string {
  const c = (v ?? '').toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(c)) throw new Error('invalid ticket code for SMS template');
  return c;
}

const TEXT: Record<SmsTemplate, (p: Record<string, string>) => string> = {
  'ticket.joined': (p) =>
    `QueueBridge: you have ticket ${code(p['code'])}${p['service'] ? ` for ${label(p['service'])}` : ''}. We will text you when you are called.`,
  'ticket.nearing': (p) =>
    `QueueBridge: ticket ${code(p['code'])}, you are nearly next. Please stay close.`,
  'ticket.called': (p) =>
    p['counter']
      ? `QueueBridge: ticket ${code(p['code'])}, it is your turn. Please go to ${label(p['counter'])} now.`
      : `QueueBridge: ticket ${code(p['code'])}, it is your turn. Please go to the counter now.`,
  'ticket.delayed': (p) =>
    `QueueBridge: ticket ${code(p['code'])}, the wait is longer than expected. Your place is kept.`,
  'ticket.missed': (p) =>
    `QueueBridge: ticket ${code(p['code'])} was called but missed. Please speak to a member of staff.`,
};

/** Render one of the five templates. Throws on an unknown template or an invalid ticket code. */
export function renderSmsTemplate(
  template: string,
  params: Record<string, string>,
  opts: { sandbox: boolean; optOutHint?: boolean },
): string {
  if (!(SMS_TEMPLATES as readonly string[]).includes(template)) {
    throw new Error('unknown SMS template');
  }
  const body = TEXT[template as SmsTemplate](params);
  // Points to the path that always works. A STOP reply is honoured only when it can be matched
  // to one organization (product-owner decision 2026-11-20), so the message never promises it.
  const tail = opts.optOutHint ? ' Stop texts on your ticket page.' : '';
  const text = `${opts.sandbox ? SMS_TEST_PREFIX : ''}${body}${tail}`;
  return text.length <= SMS_MAX_CHARS ? text : `${text.slice(0, SMS_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Contact cipher (design §13.2): AES-256-GCM with a key derived for this purpose only, and a
// keyed lookup hash (HMAC-SHA-256 with a separately derived key) for inbound opt-out matching.
// ---------------------------------------------------------------------------

export interface ContactCipher {
  /** E.164 number → base64 `iv(12) | tag(16) | ciphertext` */
  sealPhone(e164: string): string;
  openPhone(sealed: string): string;
  /** Keyed, non-reversible lookup hash of an E.164 number (never a plain hash) */
  phoneHash(e164: string): string;
}

/** `null` unless the key is 64 hex characters (the same check as the push cipher). */
export function createContactCipher(keyHex: string | undefined): ContactCipher | null {
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) return null;
  const ikm = Buffer.from(keyHex, 'hex');
  const encKey = Buffer.from(
    hkdfSync('sha256', ikm, 'queuebridge:sms-contact:v1', 'sms-contact-encryption', 32),
  );
  const macKey = Buffer.from(
    hkdfSync('sha256', ikm, 'queuebridge:sms-contact:v1', 'sms-contact-lookup', 32),
  );
  return {
    sealPhone(e164: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', encKey, iv);
      const ct = Buffer.concat([c.update(e164, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    openPhone(sealed: string): string {
      const buf = Buffer.from(sealed, 'base64');
      if (buf.length < 29) throw new Error('invalid contact ciphertext');
      const d = createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
    phoneHash(e164: string): string {
      return createHmac('sha256', macKey).update(e164, 'utf8').digest('hex');
    },
  };
}

// ---------------------------------------------------------------------------
// Signed webhooks (REQ-F11.12; security steering "Webhook security"). One scheme for the sandbox
// and a reference for live adapters whose provider signs the same way; a provider with its own
// scheme implements `verifyWebhook` itself.
//   signature = HMAC-SHA-256(secret, `${timestamp}.${nonce}.${rawBody}`), header `v1=<hex>`
// ---------------------------------------------------------------------------

export const SMS_WEBHOOK_HEADERS = {
  timestamp: 'x-qb-sms-timestamp',
  nonce: 'x-qb-sms-nonce',
  signature: 'x-qb-sms-signature',
} as const;
/** Requests outside ±5 minutes are refused (replay window; nonces are kept longer). */
export const SMS_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Header names of one signed-webhook scheme (the MAC construction is shared). */
export interface WebhookHeaderNames {
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Shared construction: `v1=` + HMAC-SHA-256(secret, `${context}${timestamp}.${nonce}.${rawBody}`).
 * `context` separates channels (USSD signs with a `ussd.v1.` prefix), so a signature captured on
 * one webhook can never be replayed on another, even if a secret were reused. SMS keeps the
 * empty context it shipped with (M6.1).
 */
export function signWebhookWith(
  names: WebhookHeaderNames,
  context: string,
  secret: string,
  rawBody: string,
  opts: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const mac = createHmac('sha256', secret)
    .update(`${context}${timestamp}.${nonce}.${rawBody}`, 'utf8')
    .digest('hex');
  return {
    [names.timestamp]: timestamp,
    [names.nonce]: nonce,
    [names.signature]: `v1=${mac}`,
  };
}

/**
 * Constant-time check of the signature and the timestamp window. Returns false (never throws)
 * for a missing secret, a missing or malformed header, a stale or future timestamp, a body that
 * is not a string, or a wrong signature.
 */
export function verifyWebhookWith(
  names: WebhookHeaderNames,
  context: string,
  secret: string | undefined,
  headers: Record<string, string>,
  rawBody: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || secret.length < 32 || typeof rawBody !== 'string') return false;
  const ts = headers[names.timestamp];
  const nonce = headers[names.nonce];
  const sig = headers[names.signature];
  if (!ts || !/^\d{1,12}$/.test(ts) || !nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    return false;
  if (!sig || !/^v1=[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SMS_WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${context}${ts}.${nonce}.${rawBody}`, 'utf8')
    .digest();
  const given = Buffer.from(sig.slice(3), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signSmsWebhook(
  secret: string,
  rawBody: string,
  opts: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  return signWebhookWith(SMS_WEBHOOK_HEADERS, '', secret, rawBody, opts);
}

/** The SMS scheme (unchanged since M6.1): see `verifyWebhookWith`. */
export function verifySmsWebhook(
  secret: string | undefined,
  headers: Record<string, string>,
  rawBody: unknown,
  nowMs: number = Date.now(),
): boolean {
  return verifyWebhookWith(SMS_WEBHOOK_HEADERS, '', secret, headers, rawBody, nowMs);
}

/** Opt-out reply keywords (case-insensitive, whole message). */
export const SMS_STOP_KEYWORDS: readonly string[] = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
];
export function isStopKeyword(body: string): boolean {
  return SMS_STOP_KEYWORDS.includes(
    body
      .trim()
      .toUpperCase()
      .replace(/[.!]+$/, ''),
  );
}
