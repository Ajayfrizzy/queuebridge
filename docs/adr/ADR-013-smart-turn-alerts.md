# ADR-013: Smart Turn Alerts — In-App First, Best-Effort Web Push, Never Blocking

**Date:** 2026-11-12  
**Status:** Accepted for specification (implementation is milestone M5, task group M5.4)  
**Feature:** F14 — Smart Turn Alerts (M5); SMS turn alerts (M6, F11)  
**Builds on:** ADR-004 (server-authoritative sequence), ADR-008 (relational outbox), ADR-009 (provider-neutral adapters)

## Context

A visitor who has joined a queue and stepped away needs to learn, quickly and accessibly, that they
have been called. Until now the only signals are the open ticket page (assertive live region and a
foreground `navigator.vibrate`, added in M2) and the public board. Constraints that shape the
decision:

- Browsers give **no guarantee** of background vibration, sound or push delivery. The Vibration API
  works only in the foreground and is unavailable on iOS Safari. Web Push needs a service worker,
  user permission, a reachable push service, and on iOS an installed (home-screen) web app. Battery
  savers and Do Not Disturb can suppress or delay it.
- Queue progression is the product. A notification problem must never delay, block or alter a
  queue transition (ADR-004), and must never cost a visitor their place.
- Offline coordinator actions are provisional until committed (ADR-006, ADR-007). Visitors must
  never be told "you are called" on the strength of local-only state.
- Zero personal spending (PRD §2, §13). Web Push is a free open standard.
- AGENTS §4.6: never claim delivery without a confirmed receipt; outbox row in the same
  transaction as the event; idempotency key on every outbound notification.
- The sandbox/live labelling rule and the provider-neutral rule (ADR-009) apply to SMS in M6.

## Decision

1. **In-app alert is the primary, always-available layer.** When the server-confirmed state of a
   visitor's ticket is `called`, the open ticket page shows a persistent visual alert (ticket code,
   counter, plain text, not colour alone) and announces it through an assertive live region. It is
   derived client-side from committed state (SSE with polling fallback), needs no permission and no
   outbox row, and makes no delivery claim.
2. **Sound and vibration are optional enhancements of the in-app layer.** Sound is off by default,
   enabled by an explicit user action (which also satisfies browser autoplay rules), uses a bundled
   asset, plays once per call event and has a "Test alert" control. Vibration uses the Vibration
   API in the foreground only, is feature-detected, can be switched off, and is never described as
   working in the background.
3. **Web Push is opt-in, per ticket, best effort.** It is requested only from an explicit button on
   the ticket page, only where `serviceWorker`, `PushManager` and `Notification` exist. The
   subscription is bound to the ticket, encrypted at rest, revoked when the ticket ends, and
   removable by the visitor. The payload is minimal (ticket code and counter label; no names, phone
   numbers or internal ids), carries a short TTL, and is suppressed if the ticket is no longer
   `called` when the worker sends it.
4. **Alerts are produced from committed events through the outbox (ADR-008).** After a committed
   event leaves a ticket `called` (call-next, out-of-order call, counter transfer), one outbox row
   per active subscription is written in the same transaction with
   `dedup_key = web_push:ticket.called:<ticket_id>:<event_sequence>`. The enqueue runs inside a
   **savepoint**: if it fails for any reason the savepoint is rolled back, the failure is logged and
   the queue command still commits. Offline-applied actions create no alert until the server commits
   them.
5. **Failure never changes queue state.** No alert outcome (push rejected, subscription expired,
   timeout, exhausted retries, no support, permission denied) causes, delays or prevents any ticket
   transition, and **never marks a visitor missed**. Missed handling stays governed solely by the
   configured F4 policy (time- and staff-driven). Automatic miss, if offered, is opt-in per service,
   time-based only, and recorded with the reason `call_window_elapsed`, never an alert reason.
6. **Honest delivery states.** For push: `sent` means the push service accepted the message;
   `delivered` is recorded only on a first-party acknowledgement from the visitor's device (service
   worker or page) or a provider receipt; `failed` on definitive rejection (404/410 revokes the
   subscription); otherwise `unknown`. Staff see these as plain text and are told the public board
   and calling aloud remain the fallback.
7. **Transport lives behind a narrow interface in `packages/channels`.** `ChannelAdapter` is
   SMS/USSD-shaped, so Web Push uses a separate `PushTransport` interface with a
   `SandboxPushTransport` (labelled test-only, no network) and a `WebPushTransport` using the
   MIT-licensed `web-push` library with VAPID keys from environment variables. The worker owns
   sending; the API only enqueues. The capability is `disabled` when VAPID keys are absent.
8. **SMS turn alerts (M6) use the same pipeline.** SMS stays under `ChannelAdapter` (ADR-009), with
   explicit consent, opt-out, hard spending caps, sandbox by default and live only with approved
   free or sponsored credits. In-app, push and SMS are independent: failure of one never affects the
   others or the queue.

## Consequences

**Positive**

- Works for every visitor with the page open, with no permission, no cost and no provider.
- Push and sound add reach where supported, with no promise they will arrive.
- A failing or absent push service cannot stall a queue, because enqueue is isolated by a savepoint
  and sending happens out of band.
- Delivery claims are limited to what is known, in line with AGENTS §4.6.

**Negative / risks**

- A visitor who closes the page, denies permission, or uses iOS without installing the app may not
  be alerted. This is a platform limit and is stated in the UI and the knowledge base, never hidden.
- Schema work: a dedicated M5.4 migration (additive; numbered after the M5.1 and M5.3 migrations) adds `push_subscriptions`, a detail code on
  `notification_deliveries`, and widens the `notifications.channel` and `notifications.status`
  CHECK constraints (constraint replacement; no table or column dropped).
- A service worker push handler must coexist with the M3 offline shell. It is added through the
  existing `generateSW` configuration (`importScripts`) so the M3 offline behaviour is unchanged
  and re-tested.
- Push endpoint URLs are capability URLs; they are encrypted at rest and never logged.

## Confirmed defaults and retention (2026-11-12)

Web Push TTL 120 seconds (configurable); at most 3 push subscriptions per ticket (a fourth is refused);
automatic no-show disabled by default (its execution rules are in ADR-015); every channel is best effort; visitors explicitly opt in; push
failure never changes queue state. Subscriptions are encrypted at rest, revoked (ciphertext removed)
on opt-out, ticket end, 404/410, session close or credential revocation, tombstoned for 24 hours and
then deleted; notification rows are kept 30 days (`design.md` §12.13). Grace periods are the existing
`grace_window_seconds`; this ADR introduces no grace default.

## Alternatives considered

- **Push as the primary channel:** rejected. It needs permission, support and a push service, and
  cannot be guaranteed.
- **Third-party push SaaS (OneSignal, Firebase paid tiers):** rejected. Adds a vendor dependency,
  data sharing and potential cost; the open Web Push standard suffices.
- **Send alerts inside the queue transaction without a savepoint:** rejected. A defect in alert code
  could roll back a queue command.
- **Auto-marking a visitor missed when an alert fails or is unacknowledged:** rejected. It would
  punish the visitor for a platform limit and conflicts with F3/F4 fairness.
- **Making the enqueue conditional on a successful push probe:** rejected. It puts an external
  dependency on the commit path.

## Verification (see testing steering, Group 14)

Savepoint isolation (injected enqueue failure still commits the call), no state change or
`ticket.miss` after any alert failure, idempotency under retry, stale suppression, committed-only
triggering (offline-applied calls), honest state transitions, minimal payload, encrypted
subscriptions, tenant isolation, keyboard and screen-reader paths, reduced motion, and real-device
checks recorded without overstating results.
