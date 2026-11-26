# ADR-009: Provider-Neutral SMS and USSD Adapters

**Date:** 2026-10-30  
**Status:** Accepted

## Context

QueueBridge targets Nigerian and regional markets where multiple SMS and USSD aggregators are available (Twilio, Africa's Talking, Termii, Infobip, and others). Selecting a specific provider requires verifying actual tariffs, approval timelines, sender-ID registration requirements, and available credits. The system should not be tightly coupled to a single provider before this selection is made.

## Decision

**`ChannelAdapter` interface** in `packages/channels` abstracts all provider-specific behavior.

```typescript
interface ChannelAdapter {
  sendMessage(params): Promise<SendResult>;
  verifyWebhook(headers, body): boolean;
  parseDeliveryReceipt(payload): DeliveryReceipt;
  parseInboundMessage(payload): InboundMessage | null;
  handleUssdSession(params): Promise<UssdResponse>;
}
```

All adapters shipped at M0:

- `SandboxSmsAdapter` — logs `[SANDBOX]`, never real network, records sends for testing
- `SandboxUssdAdapter` — stateful in-memory USSD menu for testing

Live provider adapters are implemented in M6 after a provider is selected and credentials are available. The adapter registry (`getAdapter(provider: string)`) is configured via the `SMS_PROVIDER` environment variable.

> **Update 2026-11-12 (ADR-013):** M6 additionally delivers SMS _turn alerts_ ("you are called")
> through this same `ChannelAdapter` interface and the outbox pipeline built in M5, with explicit
> consent, opt-out, hard daily caps and the zero-personal-spending rule above. Web Push, which is not
> an SMS/USSD channel, uses a separate narrow `PushTransport` interface in `packages/channels`
> rather than widening `ChannelAdapter`. The decision in this ADR is otherwise unchanged.

## Consequences

**Positive:**

- Core queue logic (M1–M5) can be implemented and tested without a real provider
- Switching providers requires a new adapter implementation, not changes to business logic
- Sandbox traffic is unmistakably labeled — no confusion about whether sends are real

**Negative:**

- Interface must be comprehensive enough to accommodate different provider capabilities
- Live provider testing requires real credentials (not available at M0)
- USSD requires provider-specific webhook formats — the interface abstracts this but each adapter is non-trivial

## Provider selection criteria (open decision, see PRD §13)

Before M6 live activation, compare providers by:

- Setup and short-code fees
- Per-SMS tariffs and per-USSD-session fees
- Inbound SMS/USSD availability
- Sender-ID registration requirements and timeline
- Sandbox access and webhook authentication support
- Nigerian network coverage (MTN, Airtel, Glo, 9mobile)
- Hard spending limits and prepaid controls
- Approved affordable cost (personal funds not authorized)
