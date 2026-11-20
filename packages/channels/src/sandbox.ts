import { createHash } from 'node:crypto';
import {
  type DeliveryReceipt,
  DeliveryStatus,
  type InboundMessage,
  type SendMessageParams,
  SendMessageParamsSchema,
  type SendResult,
  type UssdResponse,
  type UssdSessionParams,
} from '@queuebridge/contracts';
import type { ChannelAdapter, SmsAdapter } from './adapter.js';
import { renderSmsTemplate, verifySmsWebhook } from './sms.js';

/** Prefix used on ALL sandbox log output — must never be stripped. */
export const SANDBOX_PREFIX = '[SANDBOX]';

/**
 * Deterministic sandbox outcomes, chosen by the last three digits of the (normalized) number, so
 * tests and demos can exercise every path. Nothing is ever sent.
 */
export const SANDBOX_SMS_SCENARIOS = Object.freeze({
  /** The provider refuses the message (definitive failure, no retry) */
  rejected: '001',
  /** The provider is temporarily unavailable and did not accept it (a retry is safe) */
  unavailable: '002',
  /** The call fails without an answer (outcome unknown: it may or may not have been sent) */
  error: '003',
});

/** One simulated send, kept in memory (bounded) for test assertions only. */
export interface SandboxSmsRecord {
  to: string;
  text: string;
  template_key: string;
  idempotency_key: string;
  provider_message_id: string;
}

export interface SandboxSmsOptions {
  /** HMAC secret for simulated receipts and inbound messages (TEST-ONLY); none = refuse all */
  webhookSecret?: string;
  /** Log sink (one line per send, `[SANDBOX]`-prefixed, never a number or message text) */
  log?: (line: string) => void;
  /** Clock for the webhook timestamp window (tests) */
  now?: () => number;
}

const SANDBOX_RECORD_LIMIT = 200;

/**
 * SandboxSmsAdapter — TEST-ONLY SMS transport (REQ-F11.6, design §13.3). Implements the full
 * `ChannelAdapter` contract with no network access:
 *
 * - `sendMessage` renders the template with a `[TEST]` label and returns `sent` (accepted), never
 *   `delivered`: delivery is recorded only from a receipt (REQ-F11.4). The same idempotency key
 *   always yields the same provider message id and is recorded once (REQ-F11.5).
 * - Receipts and inbound messages are simulated with signed webhooks (same scheme as a live
 *   provider would use), so the API's signature, replay and correlation paths are exercised.
 * - Logs carry the `[SANDBOX]` prefix and never the phone number or the message text.
 */
export class SandboxSmsAdapter implements SmsAdapter {
  readonly provider = 'sandbox';
  readonly sandbox = true;
  readonly supportsInboundKeywords = true;
  private readonly sentMessages: SandboxSmsRecord[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly opts: SandboxSmsOptions;

  constructor(opts: SandboxSmsOptions = {}) {
    this.opts = opts;
  }

  getSentMessages(): ReadonlyArray<SandboxSmsRecord> {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
    this.byKey.clear();
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    const p = SendMessageParamsSchema.parse(params);
    const previous = this.byKey.get(p.idempotency_key);
    if (previous) {
      // Same key: the provider already has it; nothing is sent again
      return { provider_message_id: previous, status: DeliveryStatus.SENT, sandbox: true };
    }
    const tail = p.to.slice(-3);
    if (tail === SANDBOX_SMS_SCENARIOS.error) {
      this.opts.log?.(`${SANDBOX_PREFIX} SMS simulated transport error template=${p.template_key}`);
      throw new Error('sandbox SMS transport error (simulated)');
    }
    if (tail === SANDBOX_SMS_SCENARIOS.unavailable) {
      this.opts.log?.(
        `${SANDBOX_PREFIX} SMS simulated: provider unavailable template=${p.template_key}`,
      );
      return { status: DeliveryStatus.FAILED, sandbox: true, retryable: true };
    }
    if (tail === SANDBOX_SMS_SCENARIOS.rejected) {
      this.opts.log?.(`${SANDBOX_PREFIX} SMS simulated: rejected template=${p.template_key}`);
      return { status: DeliveryStatus.FAILED, sandbox: true, retryable: false };
    }
    const text = renderSmsTemplate(p.template_key, p.params, { sandbox: true, optOutHint: true });
    const id = sandboxMessageId(p.idempotency_key);
    this.byKey.set(p.idempotency_key, id);
    this.sentMessages.push({
      to: p.to,
      text,
      template_key: p.template_key,
      idempotency_key: p.idempotency_key,
      provider_message_id: id,
    });
    if (this.sentMessages.length > SANDBOX_RECORD_LIMIT) this.sentMessages.shift();
    this.opts.log?.(
      `${SANDBOX_PREFIX} SMS accepted (simulated, nothing sent) template=${p.template_key} id=${id}`,
    );
    return { provider_message_id: id, status: DeliveryStatus.SENT, sandbox: true };
  }

  verifyWebhook(headers: Record<string, string>, body: unknown): boolean {
    return verifySmsWebhook(
      this.opts.webhookSecret,
      headers,
      body,
      this.opts.now?.() ?? Date.now(),
    );
  }

  /** `{ kind: 'receipt', message_id, status: 'delivered' | 'failed' | 'unknown' }` */
  parseDeliveryReceipt(payload: unknown): DeliveryReceipt {
    const r = sandboxReceipt(payload);
    if (!r) throw new Error('SandboxSmsAdapter: invalid delivery receipt payload');
    return {
      provider_message_id: r.message_id,
      status: r.status,
      raw_status: `sandbox_${r.status}`,
      recorded_at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
  }

  /** `{ kind: 'inbound', message_id, from, body }`, else null */
  parseInboundMessage(payload: unknown): InboundMessage | null {
    const r = sandboxInbound(payload);
    if (!r) return null;
    return {
      from: r.from,
      body: r.body,
      provider_message_id: r.message_id,
      received_at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
  }

  async handleUssdSession(_params: UssdSessionParams): Promise<UssdResponse> {
    return { message: `${SANDBOX_PREFIX} USSD is not handled by the SMS adapter`, action: 'END' };
  }
}

/** Stable, non-reversible provider message id for an idempotency key (no ticket id visible). */
export function sandboxMessageId(idempotencyKey: string): string {
  return `sbx_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{4,128}$/;
const RECEIPT_STATUSES = ['delivered', 'failed', 'unknown'] as const;

/** Exact-shape check of a JSON object (no extra keys). */
function shaped(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length !== keys.length || own.some((k) => !keys.includes(k))) return null;
  return o;
}

function sandboxReceipt(
  v: unknown,
): { message_id: string; status: (typeof RECEIPT_STATUSES)[number] } | null {
  const o = shaped(v, ['kind', 'message_id', 'status']);
  if (!o || o['kind'] !== 'receipt') return null;
  const id = o['message_id'];
  const status = o['status'];
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return null;
  if (!(RECEIPT_STATUSES as readonly unknown[]).includes(status)) return null;
  return { message_id: id, status: status as (typeof RECEIPT_STATUSES)[number] };
}

function sandboxInbound(v: unknown): { message_id: string; from: string; body: string } | null {
  const o = shaped(v, ['kind', 'message_id', 'from', 'body']);
  if (!o || o['kind'] !== 'inbound') return null;
  const { message_id: id, from, body } = o;
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return null;
  if (typeof from !== 'string' || from.length < 1 || from.length > 32) return null;
  if (typeof body !== 'string' || body.length > 480) return null;
  return { message_id: id, from, body };
}

/**
 * SandboxUssdAdapter — test/development USSD adapter.
 *
 * Implements a simple stateful USSD menu for testing:
 *   1. Welcome → service list
 *   2. Select service → join confirmation
 *   3. END
 */
export class SandboxUssdAdapter implements ChannelAdapter {
  private readonly sessionLog: { session_key_hash: string; input: string; response: string }[] = [];

  getSessionLog(): ReadonlyArray<{ session_key_hash: string; input: string; response: string }> {
    return this.sessionLog;
  }

  clearSessionLog(): void {
    this.sessionLog.length = 0;
  }

  async sendMessage(_params: SendMessageParams): Promise<SendResult> {
    return {
      status: DeliveryStatus.FAILED,
      sandbox: true,
    };
  }

  verifyWebhook(_headers: Record<string, string>, _body: unknown): boolean {
    return true;
  }

  parseDeliveryReceipt(_payload: unknown): DeliveryReceipt {
    throw new Error('SandboxUssdAdapter does not handle SMS delivery receipts');
  }

  parseInboundMessage(_payload: unknown): InboundMessage | null {
    return null;
  }

  async handleUssdSession(params: UssdSessionParams): Promise<UssdResponse> {
    const state = (params.session_state ?? {}) as { step?: number };
    const step = state.step ?? 0;

    let response: UssdResponse;

    if (step === 0) {
      response = {
        message: `${SANDBOX_PREFIX} Welcome to QueueBridge\n1. Join a queue\n2. Check status\n3. Recover ticket`,
        action: 'CON',
        next_state: { step: 1 },
      };
    } else if (step === 1) {
      const input = params.input.trim();
      if (input === '1') {
        response = {
          message: `${SANDBOX_PREFIX} Joining queue...\nYou will receive a ticket code.\nReply with any key to confirm.`,
          action: 'CON',
          next_state: { step: 2, intent: 'join' },
        };
      } else if (input === '2') {
        response = {
          message: `${SANDBOX_PREFIX} Enter your ticket code:`,
          action: 'CON',
          next_state: { step: 2, intent: 'status' },
        };
      } else if (input === '3') {
        response = {
          message: `${SANDBOX_PREFIX} Enter your ticket code:`,
          action: 'CON',
          next_state: { step: 2, intent: 'recover' },
        };
      } else {
        response = {
          message: `${SANDBOX_PREFIX} Invalid option. Please enter 1, 2, or 3.`,
          action: 'CON',
          next_state: { step: 1 },
        };
      }
    } else {
      response = {
        message: `${SANDBOX_PREFIX} Thank you for using QueueBridge. Session ended.`,
        action: 'END',
      };
    }

    this.sessionLog.push({
      session_key_hash: params.session_key_hash,
      input: params.input,
      response: response.message,
    });

    console.log(
      `${SANDBOX_PREFIX} USSD session=${params.session_key_hash} step=${step} input="${params.input}" -> action=${response.action}`,
    );

    return response;
  }
}
