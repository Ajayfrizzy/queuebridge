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
   removable by the visitor. The payload is minimal: type, a non-secret
   `subscription_id` reference, ticket code, counter label, call sequence and a public recovery path.
   It never contains a status token, recovery key, grant, push endpoint, key material, names, phone
   numbers or other internal identifiers. It carries a short TTL, and is suppressed if the ticket is
   no longer `called` when the worker sends it.
4. **Alerts are produced from committed events through the outbox (ADR-008).** After a committed
   event leaves a ticket `called` (call-next, out-of-order call, counter transfer), one outbox row
   per active subscription is written in the same transaction with
   `dedup_key = web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>`; the key must
   contain the subscription because `notification_outbox.dedup_key` is globally unique (migration
   `0001`), so a key that identifies only the ticket would reject the second device's insert. Each
   device is one outbound notification with its own `notifications` row, outbox row, delivery state
   and retries; a conflict skips only a replayed row. The enqueue runs inside a
   **savepoint**: if it fails for any reason the savepoint is rolled back, the failure is logged and
   the queue command still commits. Offline-applied actions create no alert until the server commits
   them.
5. **Failure never changes queue state.** No alert outcome (push rejected, subscription expired,
   timeout, exhausted retries, no support, permission denied) causes, delays or prevents any ticket
   transition, and **never marks a visitor missed**. Missed handling stays governed solely by the
   configured F4 policy (time- and staff-driven). Automatic miss, if offered, is opt-in per service,
   time-based only, and recorded with the reason `call_window_elapsed`, never an alert reason.
6. **Honest delivery states.** For push: `sent` means the push service accepted the message;
   `delivered` is recorded only on a first-party acknowledgement from the visitor's page (which holds
   the status token; the service worker holds no credential) or a provider receipt; `failed` on definitive rejection (404/410 revokes the
   subscription); otherwise `unknown`. Staff see these as plain text and are told the public board
   and calling aloud remain the fallback.
7. **Notification identity is the subscription, not the public code.** Public codes repeat across
   facilities and queue sessions, and the web app already resolves this with a device-local saved-ticket
   `id` and `/ticket/:code?k=<id>`. The server-minted `subscription_id` (random, non-secret, unique per
   ticket and device, grants nothing without the status token) is returned to the page as
   `subscription_ref` and saved on the saved ticket as `pushRef`. It is the notification `tag`
   (`qb-call-<ref>`), the push `Topic`, and the click destination key (`/ticket/<code>?ref=<ref>`
   resolved by `pushRef`, never by code alone). If no saved ticket matches, a neutral "not saved on this
   device" screen makes no status request and offers recovery paths; it never opens another ticket with
   the same code. Push subscriptions follow a service transfer by re-binding to the destination ticket.
   Details: `design.md` §12.4.4 and §12.5.7.
8. **Transport lives behind a narrow interface in `packages/channels`.** `ChannelAdapter` is
   SMS/USSD-shaped, so Web Push uses a separate `PushTransport` interface with a
   `SandboxPushTransport` (labelled test-only, no network) and a `WebPushTransport` that
   implements the open standards directly: RFC 8291 payload encryption with the MIT-licensed
   `http_ece` library (exact-pinned) and RFC 8292 VAPID signing with `node:crypto`, with VAPID
   keys from environment variables. _(Corrected 2026-11-12: this decision first named the
   `web-push` package as MIT-licensed; it is MPL-2.0 and is not used. See implementation note 1.)_ The worker owns
   sending; the API only enqueues. The capability is `disabled` when VAPID keys are absent.
9. **SMS turn alerts (M6) use the same pipeline.** SMS stays under `ChannelAdapter` (ADR-009), with
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

## Implementation notes and deviations (M5.4, 2026-11-12)

Recorded at implementation. None changes a decision above. Item 1 corrected the wording of
decision 8, AGENTS.md §3, the architecture steering, design §2 and REQ-F14.10.4 (2026-11-12).

1. **Library: `http_ece` instead of `web-push` (licence).** Decision 8 originally said the `web-push` library
   is MIT-licensed. It is not: every published version (including 3.6.7 and 4.0.0) is MPL-2.0, and
   AGENTS.md §3, the architecture steering and REQ-F14.10.4 repeated the MIT statement. Rather than
   add a dependency whose licence differs from the approved one, `WebPushTransport` implements the
   standards directly: RFC 8291 `aes128gcm` payload encryption with `http_ece@1.2.1` (MIT, no
   dependencies, exact-pinned, `packages/channels` only) and RFC 8292 VAPID (ES256 JWT) with
   `node:crypto`. It is tested against the RFC 8291 §5 test vector and a local HTTP push-service
   round trip. It sits behind `PushTransport`, so `web-push` can replace it if MPL-2.0 is accepted.
   The documents that called `web-push` MIT-licensed now state this implementation.
2. **One enqueue point, registered, not imported.** Instead of calling `enqueueTurnAlerts` at each
   call site, `appendEvent` runs registered transition hooks for every committed transition, each
   inside its own SAVEPOINT; the turn-alert hook acts on `→ called` (any call path, online or synced)
   and re-binds subscriptions on `→ transferred`. `app.ts` registers it. The queue core therefore
   has no import path to alert code, which keeps the automatic no-show sweep's static independence
   check (testing 8.R12(f)) true.
3. **Click destination carries two more public values.** `/ticket/<code>?ref=<ref>&seq=<n>&rp=<path>`:
   `seq` lets the page acknowledge exactly the call that was shown, and `rp` lets the neutral
   "not saved on this device" screen offer the recovery path. Both are public and validated
   (`rp` must match `/recover/<org>/<facility>/<code>`); `ref` alone still decides which ticket opens.
4. **Endpoint allow-list (SSRF).** The worker POSTs to the subscription endpoint, so the API accepts
   endpoints only over HTTPS on the default port, with no IP literal or credentials, on the major
   browsers' push services (FCM, Mozilla, Apple, WNS) plus `PUSH_ENDPOINT_HOSTS`. The worker's
   transport re-checks the same policy before every send (an endpoint stored before a policy
   change is never contacted) and refuses to connect when DNS resolves the name to a loopback,
   private, link-local or otherwise non-public address (checked on the address actually used, so
   there is no gap for DNS rebinding). No redirects, a 10 s deadline, the response body unread.
5. **Shared per-ticket change limit.** Subscribe and turn-off changes are counted per ticket in
   PostgreSQL (`push_subscription_throttle`, one atomic upsert), so the limit of 20 per minute
   holds across API instances. Turning push off is counted but never refused. Windows expire by
   themselves; the worker deletes them after an hour.
6. **Lease renewal before each send.** A worker renews its lease in one guarded statement just
   before sending and skips a row another worker has re-claimed, so a long batch that outlives
   its lease does not cause a second send.
7. **Push controls live on the ticket page,** not in the display-settings dialog: a subscription
   belongs to one ticket and needs that ticket's status token. Sound, vibration, quiet mode and
   "Test alert" stay in the dialog (M5.2).
8. **Subscriptions are bound to the status token** that created them. Every token revocation (cap
   eviction, join replay, "sign out other devices", staff revoke-all) revokes its subscriptions in
   the same transaction (`credentials_revoked`). One browser has one push subscription per site,
   shared by all its saved tickets; turning push off for one ticket unsubscribes the browser only
   when no other saved ticket uses it.
9. **Configuration consistency.** The worker reports its non-secret settings with each health
   evaluation; the dashboard names any that differ from the API's (M5.3 thresholds, the VAPID public
   key, `TURN_ALERT_TTL_SECONDS`). Enqueue errors are counted per facility over the last hour in
   each API process (not shared across instances; diagnostic only).
10. **Not verified here:** delivery through real push services and on real devices (Android Chrome,
    iOS installed app). Browser tests use a push double and the sandbox transport; see
    `docs/testing/M5-evidence.md`.
