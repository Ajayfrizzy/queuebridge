import {
  type DeliveryReceipt,
  DeliveryStatus,
  type InboundMessage,
  type SendMessageParams,
  type SendResult,
  type UssdResponse,
  type UssdSessionParams,
} from '@queuebridge/contracts';
import type { ChannelAdapter } from './adapter.js';

/** Prefix used on ALL sandbox log output — must never be stripped. */
export const SANDBOX_PREFIX = '[SANDBOX]';

/**
 * SandboxSmsAdapter — test/development SMS adapter.
 *
 * - Never makes real network calls.
 * - Logs every send attempt with the [SANDBOX] prefix.
 * - Records all sent messages in memory for test assertions.
 * - Returns DELIVERED status without a real provider.
 */
export class SandboxSmsAdapter implements ChannelAdapter {
  private readonly sentMessages: SendMessageParams[] = [];

  getSentMessages(): ReadonlyArray<SendMessageParams> {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    console.log(
      `${SANDBOX_PREFIX} SMS to=${params.to} template=${params.template_key} key=${params.idempotency_key}`,
    );
    this.sentMessages.push(params);
    return {
      provider_message_id: `sandbox-${params.idempotency_key}`,
      status: DeliveryStatus.DELIVERED,
      sandbox: true,
    };
  }

  verifyWebhook(_headers: Record<string, string>, _body: unknown): boolean {
    // In sandbox mode, all webhooks are considered valid for testing.
    // Real adapters must verify HMAC signatures here.
    return true;
  }

  parseDeliveryReceipt(payload: unknown): DeliveryReceipt {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('provider_message_id' in payload) ||
      typeof (payload as Record<string, unknown>)['provider_message_id'] !== 'string'
    ) {
      throw new Error('SandboxSmsAdapter: invalid delivery receipt payload');
    }

    const p = payload as Record<string, unknown>;
    return {
      provider_message_id: p['provider_message_id'] as string,
      status: DeliveryStatus.DELIVERED,
      raw_status: 'sandbox_delivered',
      recorded_at: new Date().toISOString(),
    };
  }

  parseInboundMessage(_payload: unknown): InboundMessage | null {
    return null;
  }

  async handleUssdSession(_params: UssdSessionParams): Promise<UssdResponse> {
    return {
      message: `${SANDBOX_PREFIX} USSD not implemented in SMS adapter`,
      action: 'END',
    };
  }
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
