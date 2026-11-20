import {
  type DeliveryReceipt,
  type InboundMessage,
  type SendMessageParams,
  type SendResult,
  type UssdResponse,
  type UssdSessionParams,
} from '@queuebridge/contracts';

/**
 * Provider-neutral channel adapter interface.
 * Every SMS/USSD provider must implement this interface.
 * Test doubles and sandbox adapters must also implement it.
 *
 * Architecture ADR-009: provider selected after checking actual tariffs/approvals.
 */
export interface ChannelAdapter {
  /** Send a templated message (SMS or other channel) */
  sendMessage(params: SendMessageParams): Promise<SendResult>;

  /**
   * Verify an inbound webhook signature.
   * Must be called before processing any webhook payload.
   * Returns true if valid, false if invalid/unsigned.
   */
  verifyWebhook(_headers: Record<string, string>, _body: unknown): boolean;

  /**
   * Parse a delivery receipt from a provider webhook payload.
   * Returns the receipt or throws if the payload is malformed.
   */
  parseDeliveryReceipt(_payload: unknown): DeliveryReceipt;

  /**
   * Parse an inbound message (for providers that support two-way SMS).
   * Returns null if the payload is not an inbound message.
   */
  parseInboundMessage(_payload: unknown): InboundMessage | null;

  /**
   * Handle a USSD session step.
   * Session state is managed server-side; this function is stateless.
   */
  handleUssdSession(_params: UssdSessionParams): Promise<UssdResponse>;
}

/**
 * An SMS-capable adapter (M6.1). `sandbox` adapters never use the network and their traffic is
 * labelled test-only everywhere; `provider` names the adapter for receipts and logs.
 */
export interface SmsAdapter extends ChannelAdapter {
  readonly provider: string;
  readonly sandbox: boolean;
  /** The provider forwards inbound replies, so "STOP" works (design §13.2) */
  readonly supportsInboundKeywords: boolean;
}

/** Providers with an adapter in this build. Live providers are added only after approval. */
export const SMS_PROVIDERS = ['sandbox'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];
