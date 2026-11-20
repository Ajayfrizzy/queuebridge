# M6 Test Evidence — SMS Turn Alerts and USSD

**Branch:** `feature/m6-1-sms-adapter-outbox` (from `staging` @ `94c4b7e`, which contains M0–M5 and MQ.1–MQ.6; CI green at the baseline).
**Status (2026-11-20):** M6.1 merged into `staging` (PR #18, `80eb839`). M6.2 (USSD) implemented locally on `feature/m6-2-ussd-adapter`, uncommitted, awaiting review (section at the end). M6.3 not started. M6.2 (USSD) and M6.3 (channel UI, delivery monitoring) not started.
**Environment:** macOS, Node 24, pnpm 9, Playwright Chromium, PostgreSQL in the disposable Docker container `queuebridge-pg` (port 55433, database `queuebridge_test`). Playwright runs the built API, web app and worker, `workers: 2` (as in CI).
**Spend:** none. No provider account was created; no real message was sent.

---

## M6.1 — SMS adapter and outbox (2026-11-19 to 2026-11-20)

Scope: design §13, REQ-F11.8–F11.13, ADR-009 (provider-neutral adapters), ADR-013 (alerts never block the queue). No architectural change: SMS reuses the M5.4 relational outbox, the savepoint enqueue and the worker lease pattern.

### Architecture mapping

| Concern              | Where                                                                | How                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enqueue              | `apps/api/src/queue/sms-alerts.ts` (`installSmsAlerts`)              | Own SAVEPOINT inside the queue transaction, separate from push; no network I/O; an error rolls back to the savepoint, is logged and counted, and the command commits. Runs only for committed `ticket.called` events (online and via sync). |
| Idempotency key      | `packages/contracts/src/sms.ts` (`smsIdempotencyKey`)                | `sms:ticket.called:<ticket_id>:<event_sequence>` in `notification_outbox.dedup_key` (globally unique). A replayed call adds nothing; a re-call (new sequence) adds one.                                                                     |
| Send                 | `apps/worker/src/sms-alerts.ts` (`processSmsAlerts`)                 | Claim with `FOR UPDATE SKIP LOCKED` and a lease; re-check ticket and facility at send time; one reservation transaction; adapter call; guarded finish.                                                                                      |
| Adapter              | `packages/channels/src/sandbox.ts`, `registry.ts`                    | `SandboxSmsAdapter` implements the full `ChannelAdapter` interface; `createSmsAdapter` refuses any provider other than `sandbox` until one is approved.                                                                                     |
| Receipts and replies | `apps/api/src/routes/sms.ts` (`POST /api/v1/webhooks/sms/:provider`) | Signature, timestamp window, nonce replay table, idempotent transitions.                                                                                                                                                                    |
| Contact data         | `apps/api/src/sms/service.ts`, `packages/channels/src/sms.ts`        | AES-256-GCM ciphertext with an HKDF purpose key (`queuebridge:sms-contact:v1`), keyed lookup hash for STOP.                                                                                                                                 |
| Retention            | `apps/worker/src/sms-alerts.ts` (`purgeSmsData`)                     | Idempotent purge job in the worker loop.                                                                                                                                                                                                    |

The worker never writes `tickets`, `queue_sessions` or `queue_events`. The SMS job has its own try/catch, so it cannot stop push, health or retention jobs, and push cannot stop it.

### Migration `0011_sms_turn_alerts.sql` (additive; nothing dropped)

- `visitor_contacts`: adds `facility_id`, `ticket_id` (unique where not null), `phone_hash`, `consent_version`, `opted_out_at`, `opt_out_source` (`visitor` | `staff` | `keyword`), `erased_at`. Constraints:
  - `visitor_contacts_consent_chk`: no number without consent;
  - `visitor_contacts_erased_chk`: no number after opt-out or erasure;
  - `visitor_contacts_opt_out_pair_chk`: opt-out time and source set together;
  - `visitor_contacts_facility_org_fk`: the facility belongs to the organization.
- `notifications`: adds `visitor_contact_id`, `provider`, `provider_message_id` (unique per provider), `send_started_at`.
- New tables: `facility_sms_settings` (`enabled`, `daily_cap`, CHECK `NOT enabled OR daily_cap > 0`, `updated_by`), `sms_daily_usage` (`usage_date`, `mode` sandbox|live, `scope` `'global'` or a facility id, `sends`), `sms_webhook_nonces` (`provider`, `nonce`).
- Registered in `infra/scripts/db-identity.js`; `pnpm db:check`: applied 11, pending none.

### Adapter behaviour (`SandboxSmsAdapter`, TEST-ONLY)

- No network. Every rendered message starts with `[TEST] `; every log line is `[SANDBOX]` and never contains the number.
- `sendMessage` returns `sent` (accepted) and never `delivered`. Deterministic outcomes by the last three digits of the number: `001` rejected, `002` temporarily unavailable (`retryable`), `003` throws (transport error); anything else is accepted.
- Message id: `sbx_` + SHA-256(idempotency key)[0..32], so the same key always yields the same id.
- `verifyWebhook`: `x-qb-sms-signature: v1=<hex>` = HMAC-SHA-256(secret, `${timestamp}.${nonce}.${rawBody}`), timestamp within ±300 s, constant-time compare.
- `parseDeliveryReceipt` / `parseInboundMessage`: hand-written structure checks (channels has no zod dependency); unknown shapes return a safe error.
- Templates (`renderSmsTemplate`): joined, nearing, called, delayed, missed; 160-character limit enforced.
- The M0 stub it replaces claimed `DELIVERED` on send, accepted every webhook and logged the number. Its tests asserted that behaviour, which contradicts REQ-F11.4, and were replaced.

### Lifecycle and state mapping

| Requested state | Recorded as                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| queued          | `pending`, `send_started_at` NULL                                                                           |
| sending         | `pending`, `send_started_at` set (committed before the adapter call)                                        |
| accepted        | `sent` / `accepted`                                                                                         |
| delivered       | `delivered` / `receipt` (or `sandbox_receipt`), **only** from an authenticated receipt                      |
| failed          | `failed` / `rejected` · `cap` · `ttl_elapsed` · `retries_exhausted` · `sms_unavailable` · `invalid_payload` |
| suppressed      | `suppressed` / `opted_out` · `ticket_changed` · `sms_disabled` · `contact_removed`                          |
| unknown         | `unknown` / `interrupted` · `error`                                                                         |

**At most once per key.** SMS costs money (REQ-F11.5), so it does not use push's at-least-once delivery. The send marker is committed before the adapter call. A reclaimed row whose marker is set becomes `unknown` / `interrupted` and is never resent. A retry happens only on an explicit "not accepted" (`retryable`), with exponential backoff, at most 3 attempts, bounded by the TTL (default 120 s). Delivered is never downgraded by a later receipt.

### End-to-end sandbox demonstration

`apps/web/e2e/sms.spec.ts` runs everything for real except the provider, against the built API, web app and worker:

1. The visitor joins with a number and the consent box ticked. The row holds ciphertext only (no digits of the number).
2. Staff call next. The in-app banner appears without waiting for SMS, and the notification is `pending`.
3. The real worker (`node worker.js --once`) sends through the sandbox. The row becomes `sent` and staff see "Test text message accepted (sandbox: nothing sent to a phone)".
4. A signed receipt is posted to `/api/v1/webhooks/sms/sandbox`. Staff now see "Test receipt received (simulated: no real message)".
5. The visitor stops text messages from the ticket page with the keyboard. The number is deleted and the staff control disappears.
6. The ticket is still `called`: nothing about SMS changed it.

Nothing here proves delivery to a phone.

### Consent and opt-out verification

- **Consent:** a separate, unticked box with the purpose stated ("Send me a text message when I am called."), shown only when the facility has SMS on and the deployment can send. A number without the box is refused in place and creates nothing; an invalid number is refused with a plain message; joining with both empty works as before. Server side: missing, unticked or stale `consent_version` is refused before the join; `normalizePhoneNumber` accepts E.164 and Nigerian national format; the database refuses a number without consent. The number is never written to `localStorage` or `sessionStorage` (browser assertion).
- **Visitor opt-out:** `POST /tickets/:code/sms/opt-out` with the status token. The number is erased at once; the call is idempotent; a token is required.
- **Staff opt-out:** `POST /queues/:queueId/tickets/:ticketId/sms/opt-out`, `WALK_IN` roles, audited as `sms.opted_out` without the number; auditors get no control (UI) and 403 (API); another tenant gets 404.
- **Keyword:** an inbound `STOP` (and listed variants) on the signed webhook is **tenant-scoped**: it opts out the active contacts of the one organization whose message this deployment handed to that provider for that number; ambiguous or unmatched replies change nothing (pre-PR review below).
- An opt-out racing the send: the reservation re-reads the contact under `FOR SHARE`; whichever commits first wins, and there is never a send after an opt-out.
- Opting out changes no queue state (DB assertion).

### Cap verification

- Global `SMS_DAILY_CAP` (default 0 = nothing sent) and a per-facility `daily_cap` (`PUT /facilities/:id/sms`, `FACILITY_CONFIGURE`, audited `sms.enabled` / `sms.disabled` / `sms.cap_changed`; the database refuses "on" without a cap ≥ 1).
- Reservation is atomic and happens before every send, in one transaction with the opt-out check: global first, then facility (one fixed order, so concurrent workers cannot deadlock). `INSERT … ON CONFLICT DO UPDATE … WHERE sends < cap`; no row returned means the cap is reached.
- Beyond either cap the row is closed as `failed` / `cap`. It is never held for later, so there is no overage after the daily reset (UTC day). A facility-cap refusal rolls back its global increment.
- Tested on real PostgreSQL: exactly `cap` messages then `cap` failures; the cap holds across concurrent workers; the facility cap stops one facility without spending global budget; a cap of 0 sends nothing; sandbox sends are counted in `mode = 'sandbox'`, apart from live, and are not a financial charge.

### Delivery and webhook security

- Route `POST /api/v1/webhooks/sms/:provider`: only the configured provider exists (another name, or a deployment without SMS, is 404).
- Order: structure check (400) → signature and timestamp (401) → nonce replay (409) → event type (422). An unknown message id returns the same 200 as a known one (no existence oracle) and changes nothing.
- The raw body is captured in its own plugin for the signature. `/api/v1/webhooks/` is the only CSRF-hook exemption, because webhooks carry no session and are HMAC-authenticated; a session cookie on a webhook request is ignored.
- Rate limits per source on the webhook (`SMS_WEBHOOK_RATE_LIMIT_MAX`, default 120) and on opt-out/settings (`SMS_RATE_LIMIT_MAX`, default 30); tested with a small limit (`[200,200,429]`, `[404,404,429]`).
- `SMS_WEBHOOK_SECRET` must be at least 32 characters. Webhooks change no queue state.

### Configuration

- API: `SMS_PROVIDER` `off` (default) | `sandbox`; the sandbox is refused in production. `SMS_DAILY_CAP` default 0. Documented in `.env.example` and `docs/local-environment.md`.
- Worker: `SMS_PROVIDER` defaults to `off`, like the API (changed from the M0 default `sandbox` at the pre-PR review); the sandbox in production, an unknown provider or a missing contact key disable SMS with one log line and the worker keeps running; `SMS_DAILY_CAP` default 0, so nothing is sent. `.env.example` ships `SMS_PROVIDER=off`.
- Capability manifest `sms_turn_alerts`: `sandbox` / `available` when the deployment can send, otherwise `sandbox` / `unavailable` / `not_configured`. It is never `live` in this milestone.

### Retention

| Data                      | Removed                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone ciphertext and hash | When the ticket ends (completed, cancelled, transferred, missed beyond grace), the session closes, or on opt-out (immediately); backstop at `retention_until` (join + 7 days) for sessions nobody closed |
| `visitor_contacts` row    | Never while it holds the number; 24 h after the number was erased or opted out (or at the backstop)                                                                                                      |
| SMS `notifications` rows  | After 30 days                                                                                                                                                                                            |
| Webhook nonces            | After 24 h                                                                                                                                                                                               |
| Daily usage counters      | After 90 days                                                                                                                                                                                            |

The purge job is idempotent (DB test).

### Knowledge base (MQ.6 rules applied in the same change)

- `visitor.alerts.sms` v2 and new `staff.sms.alerts` (reception audience); knowledge base version 3 → 4 (`kb-base-check` against merge base `94c4b7e` passes); `kb.lock.json` regenerated from staging's lock; 45 articles.
- `capabilities.json`: `sms_turn_alerts` = sandbox, not configured by default, articles `[visitor.alerts.sms, staff.sms.alerts]`. Registry defaults: `visitor.join` and `visitor.ticket` add `visitor.alerts.sms`; `staff.console` adds `staff.sms.alerts`.
- New consistency rule **A4**: an article for a `live` capability must not describe itself as sandbox or test mode. It catches the sandbox → live transition from the other side. Documented in `packages/assist/knowledge/README.md` and `AGENTS.md` §4.7 (A1–A4).
- Keyword changes: `sandbox` removed from `staff.sms.alerts`; `phone number` / `mobile number` shortened to `phone` / `mobile` in `visitor.alerts.sms`. They collided with scripted markers in the `que-ask.db.test.ts` sandbox inference tests, whose `/SMS/` leak check is kept unchanged.

### Security and financial invariants mapped to tests

| Invariant                                                                                  | Test                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A failing SMS hook cannot fail a call; push still enqueues (and the reverse)               | `sms.db.test.ts` "a failing SMS hook…", "a failing push hook…"                                                                                                                    |
| Alerts only from committed events; fenced offline calls enqueue nothing                    | `sms.db.test.ts` "an offline call enqueues only once its sync batch commits…"                                                                                                     |
| One row per key; no number in the payload                                                  | `sms.db.test.ts` "one outbox row with the approved key…"                                                                                                                          |
| `sent` never becomes `delivered` without a receipt                                         | `sms-alerts.db.test.ts` "…recorded `sent`, never `delivered`", "an adapter that claims `delivered`…"                                                                              |
| Never resent after a crash; concurrent workers send once                                   | `sms-alerts.db.test.ts` "a crash between send and record…", "two workers polling concurrently…", "a worker restart…"                                                              |
| No SMS outcome changes ticket, session or event chain                                      | `sms-alerts.db.test.ts` "no SMS outcome changes…"; `sms.db.test.ts` "opting out changes no queue state", "webhooks change no queue state"; e2e final `called` assertion           |
| Caps (global, facility, concurrent, zero, sandbox apart)                                   | `sms-alerts.db.test.ts` cap tests                                                                                                                                                 |
| Ciphertext only; DB refuses a number without consent or after opt-out                      | `sms-alerts.db.test.ts` last two tests; e2e ciphertext check                                                                                                                      |
| Signature, timestamp, replay, provider isolation, CSRF independence, rate limits           | `sms.db.test.ts` webhook tests                                                                                                                                                    |
| Sandbox refused in production                                                              | API: `sms-env.test.ts` and the real server process in `apps/api/src/sms-startup.db.test.ts`. Worker: the real process in `apps/worker/src/sms-startup.db.test.ts` (pre-PR review) |
| `[TEST]` text, no network, no number in logs                                               | `packages/channels/src/sandbox.test.ts`, `sms.test.ts`                                                                                                                            |
| Accessibility of the new controls (axe, 320/375/desktop, keyboard opt-out, focus on error) | `apps/web/e2e/sms.spec.ts`                                                                                                                                                        |

### Mutation checks (each made a test fail, then reverted)

First pass, 16 mutations: 13 killed. Three survived:

- Crash-resend: removing one of the two send-marker guards survived because the other guard covered it (redundant layers).
- Opt-out enqueue: removing one of two number filters survived for the same reason.
- Facility off: survived because of a test bug, since fixed.

One further mutation was mis-quoted and did not apply.

Second pass on the survivors: all 4 killed.

- both send-marker layers removed;
- facility off (after the test fix);
- both opt-out filters removed;
- receipt downgrade allowed.

Also killed:

- cap ignored;
- `delivered` recorded from a send;
- send while the ticket had left `called`;
- signature check skipped;
- nonce check skipped;
- number kept where SMS is not offered;
- invalid number accepted;
- sandbox allowed in production;
- adapter returns `delivered`;
- number written to a log line;
- retention skipped.

### Defects found and fixed

- **The M0 `SandboxSmsAdapter` stub** claimed delivery on send, accepted every webhook and logged the number. Replaced, as described above.
- **`apps/worker/src/health.db.test.ts` (existing M5 test).** The lock poll read `pg_locks` server-wide, so an advisory lock held by another session failed the test. Reproduced 3 of 3 with a foreign lock. The poll is now restricted to the lock holder's `pid`. Then 10 of 10 consecutive passes.
- **Test bugs during M6.1:**
  - e2e lookups scoped by `queue_session_id`, because ticket codes repeat across organizations;
  - `enableSms` asserts 200;
  - `SMS_ON` raises the test rate limits, and a separate test covers the limits themselves;
  - the "nothing is enqueued…" test uses four separate queues and asserts each call.
- **Knowledge-base keyword collisions** with the inference sandbox markers (see the knowledge base section).

### Stabilization: intermittent `sms.spec.ts` end-to-end failure (fixed)

- **Observed:** once, in the first of 5 full Playwright runs. "committed call → worker sends a [TEST] message…" saw the notification still `pending` after the worker run.
- **Investigation:** the database record of the failure showed the test's row, and the next test's row, processed together at 08:05:27.0 by the turn-alerts spec's worker. The test's own worker run at 08:05:15.45 had instead claimed 50 older SMS rows: rows that API DB test runs (`sms.db.test.ts`, which commit calls without a worker) had left pending in the shared test database.
- **Cause:** the worker takes due rows oldest first, 50 per run, by design. The test assumed one worker run reaches its row, which is false when more than 50 rows are ahead. This was a test synchronization problem, not a product defect; production impact is at most one poll interval of delay with a backlog over 50.
- **Reproduced deterministically:** 5 API DB runs left 60 due rows, and the unchanged test failed with `Expected "sent"`, `Received "pending"`.
- **Fix:** before running the worker, the test counts the due rows ordered ahead of its own (same ordering as the claim: `next_attempt_at, id`). It then runs the real worker exactly `ceil((ahead + 1) / 50)` times.
  - This is not a retry: rows created or re-leased later sort after the test's row, and concurrent workers only shorten the line.
  - The `sent` assertion and its timeout are unchanged.
- **Verified:**
  - with 119 rows ahead: 3 worker runs, all 8 SMS tests pass;
  - `sms.spec.ts` + `turn-alerts.spec.ts` with `--repeat-each 5`: 140 of 140;
  - the full suite: 293 passed, 7 skipped.
- **Related observation:** `turn-alerts.spec.ts` (M5) made the same one-run assumption for `web_push` rows. It was proven to fail the same way and fixed at the pre-PR review (below); both specs now use one shared helper.

### Provider research (public sources, accessed 2026-11-19, links rechecked 2026-11-20; no account created)

| Provider                                                                                                                     | Test option                                                                                                                                                                                                 | Cost signals                                                                                                                                                                                                                                                                                                | Callback authentication                 | Notes for Nigeria                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Termii](https://developer.termii.com/)                                                                                      | Its [sandbox announcement](https://termii.medium.com/introducing-termii-sandbox-fe86d2f3c049) says normal messaging fees apply                                                                              | Unit prices vary by network and route and are not published as flat rates                                                                                                                                                                                                                                   | Not confirmed in the public docs        | DND route by arrangement with support; reported restriction of the generic route on MTN overnight (to confirm) |
| [Africa's Talking](https://help.africastalking.com/en/articles/1170660-how-do-i-get-started-on-the-africa-s-talking-sandbox) | Free sandbox with a simulator instead of a handset                                                                                                                                                          | Wallet billing                                                                                                                                                                                                                                                                                              | Not documented as signed                | Documents and a transactional bind of two weeks or more reported                                               |
| [Infobip](https://www.infobip.com/docs/essentials/getting-started/free-trial)                                                | Free trial, verified recipients only                                                                                                                                                                        | Trial credits "up to 100 messages" per channel per the docs; the [signup guide](https://www.infobip.com/guides/get-started-guide/signup) mentions 15 SMS, and the [SMS guide](https://www.infobip.com/guides/get-started-guide/sms) up to 5 verified numbers. The pages disagree, so this must be confirmed | HMAC signature header                   | Local sender ID registration reported over 20 days; two-way not offered in Nigeria                             |
| [Twilio](https://www.twilio.com/docs/usage/trials)                                                                           | 100 trial SMS, 30-day trial, up to five verified recipients                                                                                                                                                 | Paid after trial                                                                                                                                                                                                                                                                                            | `X-Twilio-Signature`                    | Sender ID registration of 2–3 weeks reported; two-way not offered in Nigeria                                   |
| [Vonage](https://developer.vonage.com/messages/concepts/signed-webhooks)                                                     | Small demo credit; demo text appended to messages                                                                                                                                                           | Paid after demo                                                                                                                                                                                                                                                                                             | JWT-signed webhooks                     | MTN reported to need a pre-registered sender ID                                                                |
| [Sendchamp](https://sendchamp.readme.io/reference/webhook)                                                                   | No free test mode found                                                                                                                                                                                     | Price not published                                                                                                                                                                                                                                                                                         | Webhook URL only; no signature found    | Inbound reported as "coming soon"                                                                              |
| [BulkSMSNigeria](https://www.bulksmsnigeria.com/api)                                                                         | Free starting credit, no card required (a [tutorial](https://www.bulksmsnigeria.com/resources/api-integration-tutorial) says 50 SMS; [features](https://www.bulksmsnigeria.com/features) says ₦50: confirm) | [From ₦6.49 per SMS page, excluding VAT](https://www.bulksmsnigeria.com/pricing), no monthly fee                                                                                                                                                                                                            | Not signed (secret in the callback URL) | Inbound not documented                                                                                         |

Content was rephrased for compliance with licensing restrictions. Items marked "reported" come from the 2026-11-19 research pass and were not all rechecked on 2026-11-20.

**Conclusion:** no provider can be used live without spending beyond small trial credits, and every trial restricts recipients. No live adapter is implemented (task left open). Two points affect any provider:

- "STOP to 2442" is the NCC Do-Not-Disturb registration, not a per-sender opt-out.
- Alphanumeric senders are one-way, so a keyword STOP needs a two-way number.

**Activation gates, to verify with a provider before any live traffic:**

1. Sponsorship or free credits that cover the expected volume, with no card or personal funds.
2. The current price.
3. DND/transactional route eligibility.
4. The sender ID timeline.
5. Provider-side hard caps.
6. Signed or otherwise authenticated callbacks; without them the webhook cannot be trusted.
7. Inbound and STOP handling.
8. KYC requirements.
9. Send windows.
10. **Recipient verification.** Today a visitor can enter someone else's number (decision 7 below). Before live traffic, decide and implement a verification step or record an explicit acceptance of the risk with its cost.
11. **Ambiguous STOP handling.** A STOP reply matched to several organizations changes nothing. Before live traffic, either give each organization its own sender (so replies attribute directly) or keep all user-facing wording pointing to the ticket page and staff, as it does now.

The boundary is ready: `SmsAdapter`, `createSmsAdapter`, the webhook route and signature verification per provider.

### Decisions (approved by the product owner on 2026-11-20; see "Product-owner decisions")

1. **Only `ticket.called` is sent.** The consent text approved in design §13.2 states that purpose. The other four templates exist but need consent wording and trigger thresholds (open decision).
2. **Inbound STOP is tenant-scoped** (revised at the pre-PR review; the first version was cross-tenant). See the review section for the rule and its limits.
3. **Retention** (revised at the pre-PR review): the number is erased when the visit ends; the consent record lives as long as the number and 24 h after; a 7-day backstop (`retention_until`) applies only to sessions nobody closed.
4. **Staff opt-out is offered only in the console's alert panel for the called ticket.** A per-ticket management view is M6.3.
5. **The worker's `SMS_PROVIDER` default is `off`** (revised at the pre-PR review, from the M0 default `sandbox`).
6. **CSRF exemption** for `/api/v1/webhooks/` only.
7. **No number verification (no OTP).** A visitor could enter someone else's number, and that person would get one `[TEST]` message per call. Mitigated by consent, the per-facility and global caps, opt-out (ticket page, staff, STOP where attributable) and erasure when the visit ends. A verification step would cost an extra message per join.

### Limitations

- Sandbox only. Nothing in this milestone proves delivery to a real phone, and no real network, DND, sender ID or send-window behaviour was exercised.
- The live provider adapter is not implemented, because no provider is approved.
- The facility SMS setting has an API but no screen (M6.3); end-to-end tests turn it on through the API.
- SMS delivery counts are not yet on the device-health or delivery-monitoring dashboard (M6.3).
- Real-device manual checks for the new controls are not yet recorded. They belong with the M5 Set 2 final acceptance and M6.3.

### Deferred to M6.2 / M6.3

- **M6.2:** USSD adapter, sessions and menus, and the `visitor.ussd` knowledge-base update.
- **M6.3:**
  - the channel management UI, including the facility SMS setting and cost-control screen;
  - per-ticket SMS management for staff;
  - delivery monitoring and dashboard counters for SMS.

### Pre-PR security and deployment review (2026-11-20)

Scope: production-disabled startup, STOP tenant isolation, consent and retention, SMS triggers, the outbox test-stability risk in `turn-alerts.spec.ts`, and the audit exception. The architecture is unchanged: no new package, table or dependency, and no change to migration `0011`.

#### 1. Production startup with SMS unavailable

**Finding.** The worker did not reject production configurations. With the M0 default `SMS_PROVIDER=sandbox` it started, logged an error ("refused in production") on every start and disabled SMS. Two weaknesses remained:

- a worker started without `NODE_ENV=production` ran the sandbox by default, still sending nothing because the cap defaults to 0;
- `.env.example` shipped `SMS_PROVIDER=sandbox`.

**Change:**

- The worker's default is now the explicit safe disabled mode `off`, the API's default. `.env.example` ships `off`.
- The worker's startup line reports why SMS is disabled: `reason` is `off`, `sandbox_refused_in_production`, `unknown_provider`, `no_contact_key` or `configured`, plus `sandbox` and `daily_cap`.
- With a working adapter and `SMS_DAILY_CAP=0` the worker warns once.
- The API keeps failing closed: the sandbox named in production stops the API before it listens, as the existing `QUE_AI_ADAPTER` rule does. Its default `off` starts normally.

**Behaviour, verified on the real processes:**

| Configuration (production unless stated)                   | API                                                                                         | Worker                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No SMS variables (default)                                 | Starts, ready; manifest `sms_turn_alerts` = `sandbox` / `unavailable`; no SMS webhook (404) | Starts, all jobs run (device health recorded `SMS_PROVIDER: disabled`, checkpoints enabled), exit 0; no SMS error line; due SMS rows not claimed; rows past the TTL closed `failed` / `sms_unavailable` |
| Cap set, provider unset or `off`                           | Same as default                                                                             | Same as default                                                                                                                                                                                         |
| `SMS_PROVIDER=sandbox`                                     | Refused at startup (exit ≠ 0, message names the rule, never listens)                        | Starts and runs; one error line; SMS disabled (`sandbox_refused_in_production`); nothing claimed or reserved                                                                                            |
| Unknown or would-be live name (`termii`, `live`, `twilio`) | Refused by the env schema (existing test)                                                   | Starts and runs; SMS disabled (`unknown_provider`)                                                                                                                                                      |
| Development, sandbox, no contact key                       | n/a                                                                                         | SMS disabled (`no_contact_key`)                                                                                                                                                                         |
| Development, sandbox, `SMS_DAILY_CAP=0`                    | Not offered (existing test)                                                                 | Warns; every due row closed `failed` / `cap`; no send marker, no reservation                                                                                                                            |
| Control: development, sandbox, cap 5                       | Offered                                                                                     | Sends: `sent`, one global and one facility unit reserved                                                                                                                                                |

In every non-control case the tests assert that nothing was dispatched:

- no `send_started_at`;
- no `sent` or `delivered` status;
- no `sms_daily_usage` unit;
- no "SMS accepted" log line.

The control run proves those checks can fail.

Tests:

- `apps/worker/src/sms-startup.db.test.ts` (6): the built worker, `--once`, against its own throwaway migrated database.
- `apps/api/src/sms-startup.db.test.ts` (4): the built server over HTTP.
- `apps/worker/src/env.test.ts`: the default and production parsing.

#### 2. STOP and cross-tenant protection

**Findings:**

- **Attribution.** The inbound message carries the sender's number, our sender identity and the text. It never names an organization: all tenants send from one deployment-wide sender, and a two-way number is needed for replies at all (alphanumeric senders are one-way).
  - The provider is identified by the route and its HMAC secret.
  - The sender identity is the deployment's.
  - The intended organization cannot be read from the message.
- **Authorization.** Cross-tenant opt-out was never explicitly authorized; it was an implementation decision listed for review.
- **Harm.** It could suppress another organization's legitimate notifications. One organization (or someone joining there with another person's number) could get a STOP for that number applied to every tenant. A shared-phone household (F2) visiting two organizations lost both alerts with one reply.
- **Ambiguity.** A shared sender is ambiguous by construction.
- **Abuse resistance.** Already in place before the review:

  - spoofed webhooks need the HMAC secret;
  - replays are refused by the nonce table and the ±5 min window;
  - concurrent STOPs were idempotent.

  Spoofing the visitor's own number at the carrier level stays outside our control. It is now confined to one organization at most.

**Final rule (`applyInboundMessage`, one transaction):**

- Lock the number's active contacts (`FOR UPDATE`, id order).
- Collect the organizations that this deployment actually handed a message to, through this provider, for those contacts. "Handed" means `send_started_at` is set and the status is not `failed`. A refused message, one waiting to retry after "not accepted", and a merely queued one reached nobody, so they are not evidence.
- If that is exactly one organization: opt out that organization's active contacts for the number (`keyword`), and no other organization's.
- If several organizations, or none: change nothing.
- The response is the same `200 {ok:true}` in every case. The log carries only `attribution` (`organization` | `ambiguous` | `no_message` | `not_stop` | `unreadable`) and counts.
- STOP is not a blocklist: a later join is a new explicit consent.

**Supported alternative when a STOP cannot be attributed:**

- **Stop text messages** on the ticket page (immediate);
- staff at the desk (`WALK_IN`, audited);
- the number is erased when the visit ends anyway.

The visitor article `visitor.alerts.sms` now says that a reply cannot always be matched and points to these paths.

Real PostgreSQL tests (`apps/api/src/sms.db.test.ts`, new and replaced):

- only the messaging organization is opted out, including its not-yet-messaged contacts, while another tenant with the same number keeps it;
- ambiguous: nothing changes, and the per-ticket opt-out still works;
- no evidence (never messaged, another provider, queued only, retrying after "not accepted", rejected): nothing changes;
- abuse: forged signature (401), stale timestamp (401), other provider route (404) and an unknown number (identical 200) change nothing; an exact replay is refused (409);
- 12 concurrent STOPs: applied once to one tenant, never re-stamped, never spilling into another;
- STOP racing the visitor and staff opt-outs: one opt-out wins, with at most one staff audit event.

#### 3. Consent, retention and ticket lifetime

**Finding (defect).** The first version set `retention_until` to join + 24 h and deleted the contact row then, whatever the ticket's state. A visit still active after 24 h (an unfinished queue, a session left open overnight) would lose its consent record and number before the ticket ended. The row was deleted, so it was not a privacy leak, but the visitor would silently get no alert.

**Final rules (`purgeSmsData`, idempotent):**

- **Number (ciphertext and hash):** erased as soon as the visit no longer needs it:
  - the ticket is completed or cancelled;
  - transferred away (a service transfer re-binds the contact to the destination ticket first, so the visit keeps it);
  - missed beyond its grace window (it can no longer return to the queue);
  - its session is closed;
  - immediately on opt-out.
- **Backstop:** `retention_until` = join + 7 days, set on creation as before. At the backstop the number is erased even if the session was never closed.
- **Contact row (consent and opt-out record):** never deleted while it holds the number. Deleted 24 h after the number was erased or opted out, or at the backstop.
- Notifications are deleted after 30 days, nonces after 24 h and counters after 90 days (unchanged).

The consent text ("deleted when my visit ends") stays accurate.

Tests (`apps/worker/src/sms-alerts.db.test.ts`):

- an extended visit 30 h old in every active state (`waiting`, `called`, `serving`, `paused`, missed inside grace) and a 6-day unfinished queue keep number and record, and the alert is still sent;
- transfer: the moved contact keeps its number, and one left on a transferred ticket is erased;
- completion, session close and missed beyond grace: erased at once; the record is kept at 23 h and deleted at 25 h;
- opt-out: the record is kept, then deleted after 24 h;
- the 7-day backstop.

API test: `retention_until` = consent + 168 h.

#### 4. SMS triggers

- `ticket.called` remains the only active template.
- `SMS_INACTIVE_TEMPLATES` (joined, nearing, delayed, missed) are wording-only definitions.
- The API enqueues only `ticket.called` (unchanged).
- New defence in depth: the worker closes any row for a template outside `SMS_SENT_TEMPLATES` as `failed` / `invalid_payload` without sending, whatever wrote it.
- Tests:
  - contracts: the active/inactive split, and the consent text names only the called purpose;
  - worker DB: each inactive template is closed unsent.
- Activation still needs approved purpose-specific consent wording and trigger rules.

#### 5. Outbox batching in `turn-alerts.spec.ts`

- **Proven:**
  - each API `turn-alerts.db.test.ts` run leaves about 16 due `web_push` rows in the shared test database;
  - with 85 rows ahead, the unchanged spec failed "14.3 … the worker sends…" (`outcomeOf` timed out on `pending`); later tests in the file passed because the backlog had shrunk;
  - this is the same false failure as the SMS test.
- **Fix (fixture synchronization only):**
  - `runWorkerUntilReached(label, channel, notificationIds)` in `apps/web/e2e/worker-once.ts`, shared by both specs;
  - it counts the due rows of that channel ahead of the last target, in the claim's order, and runs the real worker `ceil((ahead + 1) / 50)` times;
  - the three single-run sites in `turn-alerts.spec.ts` use it;
  - no assertion, poll or timeout changed.
- **Verified:**
  - with 96 rows ahead: 2 worker runs, 14 of 14;
  - full suite with 194 SMS and 21 push rows ahead: 293 passed;
  - `sms`, `turn-alerts` and `device-health` specs `--repeat-each 3`: 117 of 117.

#### 6. Audit exception GHSA-fc5q-39xc-vjpf

**Proof:**

- **Withdrawn upstream.** The GitHub Advisory API (`api.github.com/advisories/GHSA-fc5q-39xc-vjpf`, read 2026-11-20) reports `withdrawn_at` 2026-11-18T15:38:56Z and the summary "Withdrawn Advisory". It says the advisory "has been withdrawn because it is not a security issue" and still lists `<= 4.0.7` with no patched version.
- **Not reported by npm.** The npm bulk advisory endpoint returns `{}` for picomatch 2.3.2 and 4.0.7.
- **Full audit is clean.** `pnpm audit --json` (development dependencies included) reports 0 high and 0 critical findings: 1 low (`@eslint/plugin-kit`) and 3 moderate (`glob`, `minimatch`).

**Not a dependency fix.** The lockfile still resolves picomatch 2.3.2 and 4.0.7; nothing was upgraded (lockfile unchanged since MQ.1). The exception is unnecessary because the finding no longer exists.

**Change:**

- `infra/security/audit-policy.json` now has `exceptions: []`.
- The exception, as approved, moved to the test fixture `apps/api/src/testing/audit-policy.fixture.json`, so the gate's exception rules stay tested. The gate never reads it.
- New gate tests: the committed policy is valid and empty; with it, the same picomatch finding (if ever re-published) blocks, any new high or critical finding blocks, and a clean audit passes.
- The CI comment, the MQ evidence (dated pointer) and both gates are kept:
  - `pnpm audit --prod --audit-level high` with no exceptions;
  - `audit-gate.js` over the full tree.

#### Mutation checks (each made a test fail, then reverted)

**Killed:**

- **STOP:**
  - organization filter dropped (cross-tenant);
  - ambiguous applied to everyone;
  - another provider's sends counted;
  - unstarted sends counted;
  - failed sends counted.
- **Retention:**
  - API back to 24 h;
  - record deleted at once after erasure;
  - the old rule (rows only at `retention_until`);
  - an active waiting ticket erased;
  - backstop removed.
- **Triggers:** inactive-template guard removed.
- **Worker startup:**
  - default back to `sandbox`;
  - production sandbox refusal removed;
  - cap 0 ignored.

**Survived once, then fixed:**

- "STOP counts queued sends" survived because the provider filter excluded queued rows anyway.
- The fix: the test now covers a retry-pending row (provider kept, marker cleared) and a rejected row (marker kept).
- That exposed a design gap: a rejected message would have counted as evidence. The rule now excludes `failed`.
- Both mutations are now killed.

#### Remaining risks (for the product owner)

- **Ambiguous STOP.** It changes nothing. A visitor with live SMS alerts from two organizations through the same provider who replies STOP keeps receiving them until they use the ticket page, staff stop them, or the visits end. Only `ticket.called` is sent (one message per call), which bounds the impact. The alternative, applying STOP to all tenants, is the cross-tenant behaviour this review removed.
- **Carrier-level spoofing.** A spoofed sender number delivered by the provider is trusted as the provider reports it. Its effect is now limited to one organization's SMS for that number. Queue state, in-app alerts and the board are never affected.
- **7-day backstop.** It is a product decision. A ticket still active after 7 days in a session nobody closed loses its SMS number.
- **One sender per provider.** If a provider later gives each organization its own sender, inbound `to` could attribute directly. This build stores no per-notification sender, so that would be an M6.3 or activation-time change.
- **`turn-alerts` DB backlog.** The API DB suites still leave pending rows in the shared test database. The e2e helpers now cope; cleaning those suites is not in scope.

### Product-owner decisions (2026-11-20)

Approved for M6.1. They complete the M6.1 review; the architecture is unchanged.

| #   | Decision                                                                                                                                                    | Where it is enforced and tested                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Only `ticket.called` SMS notifications are active                                                                                                           | `SMS_SENT_TEMPLATES` / `SMS_INACTIVE_TEMPLATES` (contracts test); API hook enqueues only `ticket.called`; worker closes any other template unsent (`sms-alerts.db.test.ts`)                                                                       |
| 2   | STOP is tenant-scoped when provider send history establishes one unambiguous organization                                                                   | `applyInboundMessage`; `sms.db.test.ts` STOP tests                                                                                                                                                                                                |
| 3   | An ambiguous STOP never alters another tenant's records; the limitation stays documented and no user-facing text promises unconditional reply-based opt-out | `sms.db.test.ts` "ambiguous…"; `visitor.alerts.sms` wording; the message hint now reads "Stop texts on your ticket page." instead of "Reply STOP to stop." (`packages/channels/src/sms.ts`, test in `sms.test.ts`), found at the final checkpoint |
| 4   | Phone ciphertext is erased when the visit ends or the visitor opts out                                                                                      | `purgeSmsData`, opt-out routes; worker and API DB tests                                                                                                                                                                                           |
| 5   | Consent records are removed 24 hours after erasure                                                                                                          | `purgeSmsData`; worker retention tests (kept at 23 h, deleted at 25 h)                                                                                                                                                                            |
| 6   | A seven-day maximum retention backstop applies to abandoned contacts, without changing queue state                                                          | `retention_until` = join + 168 h; backstop test; the worker writes no queue table (static check and "no SMS outcome changes…" test)                                                                                                               |
| 7   | SMS defaults to `off` in production until a live provider is approved                                                                                       | API and worker defaults; `.env.example`; startup tests on the real processes                                                                                                                                                                      |
| 8   | The withdrawn picomatch advisory exception is removed, provided both unmodified audit gates stay green                                                      | `infra/security/audit-policy.json` empty; `audit-gate.test.ts`; both CI audit steps unchanged and passing                                                                                                                                         |

Open for later decisions: activating the four inactive templates (needs purpose-specific consent wording and trigger rules), recipient verification and ambiguous STOP handling (live-activation gates 10 and 11 in the provider section).

### Final scope verification (2026-11-20)

- **Files:** every changed file belongs to M6.1 or its approved corrective work (pre-PR review and this checkpoint); inventory in the pull request.
- **Migration `0011`:** additive only (`ADD COLUMN IF NOT EXISTS`, new tables, new CHECKs, indexes); no `DROP`, `TRUNCATE`, `DELETE`, `RENAME` or column type change; no other migration modified. Before M6.1 no code wrote `visitor_contacts`, so the new purge cannot remove earlier data.
- **Logs:** no SMS log call includes a number, hash, token, key or message body (static search of the API service, routes, hook, worker and channels code); recovery credentials are not touched by M6.1.
- **Queue neutrality:** the worker has no `INSERT`, `UPDATE` or `DELETE` on `tickets`, `queue_sessions`, `queue_events`, `ticket_transitions` or `client_operations`; DB tests assert that SMS outcomes, opt-outs and webhooks change no ticket, session or event chain; fairness and coordinator code are untouched.
- **Independence:** push and in-app alert code (`apps/api/src/queue/turn-alerts.ts`, `apps/worker/src/turn-alerts.ts`) is unchanged from `staging`; separate savepoints and jobs; tests for a failing SMS hook and a failing push hook.
- **Honest states:** a sandbox send is `sent` / `accepted`, never `delivered`; a simulated receipt is `delivered` / `sandbox_receipt` and every screen and message is labelled test mode.
- **No live provider:** `createSmsAdapter` builds only the sandbox; the API env accepts only `off` | `sandbox`; no network call exists in the SMS code.

### Gate results (local, 2026-11-20, after the pre-PR review)

| Gate                                                                                 | Result                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` (production builds) | pass (lint: zero errors)                                                                                                                                                                                                                                 |
| `pnpm test`                                                                          | contracts 205, ui 6, channels 46, domain 109, assist 262, continuity 64, api 191, worker 13, web 177: all pass (re-run at the final checkpoint, with migration validation: fresh database 11/11, second run applies nothing, `0011` re-executes cleanly) |
| `pnpm test:db`                                                                       | api 717, worker 100: all pass                                                                                                                                                                                                                            |
| Production-disabled startup                                                          | worker `sms-startup.db.test.ts` 6/6, API `sms-startup.db.test.ts` 4/4                                                                                                                                                                                    |
| Focused concurrency and tenant isolation                                             | API `sms.db` + `sms-startup.db` + `queue-concurrency.db` + `queue-security.db`: 83/83, 5 consecutive runs; worker `sms-alerts.db` + `sms-startup.db`: 37/37, 3 consecutive runs                                                                          |
| Playwright (full)                                                                    | 293 passed, 7 skipped (the existing environment-dependent skips), 0 failed, with 194 SMS and 21 push rows queued ahead                                                                                                                                   |
| Playwright stabilization                                                             | `sms`, `turn-alerts`, `device-health` `--repeat-each 3`: 117 of 117; `turn-alerts.spec.ts` with 96 push rows ahead: 14 of 14 (unchanged spec: 1 failed with 85 ahead)                                                                                    |
| Knowledge base                                                                       | `kb-base-check` against merge base `94c4b7e`: kbVersion 3 → 4 accepted, 45 articles; Group 13.5 consistency (assist 262, API KB tests 41) pass                                                                                                           |
| `pnpm audit --prod --audit-level high`                                               | no known vulnerabilities                                                                                                                                                                                                                                 |
| `node infra/scripts/audit-gate.js`                                                   | PASS with no exception in the policy                                                                                                                                                                                                                     |
| `pnpm db:check`                                                                      | applied 11, pending none                                                                                                                                                                                                                                 |

The first-pass results (before the review) were: unit api 188, worker 12, contracts 204; DB api 708, worker 88; Playwright 293 passed. The audit gate then still carried the stale exception.

---

## M6.2 — USSD adapter (2026-11-20)

Scope: REQ-F12.1–F12.5, ADR-009 (provider-neutral adapters), ADR-015 (recovery credentials). Baseline: `staging` at `80eb839` (M6.1 merged). No architectural change: no new package, no parallel queue engine. USSD reuses the public catalog, `joinQueue`, the recovery-key check and the status view.

### Architecture mapping

| Concern                                    | Where                                                                              | How                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Request format, signature, response format | `SandboxUssdAdapter` (`packages/channels/src/sandbox.ts`), `UssdAdapter` interface | Exact-shape JSON `{session_id, msisdn, text}`; HMAC over the raw body with a USSD-only context; `CON`/`END` text |
| Menu (shared by every adapter)             | `runUssdMenu` (`packages/channels/src/ussd.ts`)                                    | Stateful machine over JSON state; reaches the queue only through `UssdApplication`; no I/O, no logging           |
| Queue operations                           | `apps/api/src/ussd/application.ts`                                                 | Existing services only (below)                                                                                   |
| Session store, step order, replays, expiry | `apps/api/src/ussd/service.ts`                                                     | `ussd_sessions` in PostgreSQL; one transaction per step                                                          |
| Webhook and facility setting               | `apps/api/src/routes/ussd.ts`                                                      | `POST /api/v1/webhooks/ussd/:provider`; `GET                                                                     | PUT /facilities/:id/ussd` |
| Retention                                  | `apps/worker/src/ussd-retention.ts`                                                | Idempotent purge in the worker loop                                                                              |

Reused, not duplicated:

- **Discovery:** `findPublicFacility` and `publicFacilityView` (only queues with `accepting_visitors`).
- **Joining:** `joinQueue`, with a new optional `channel: 'ussd'`. The web route passes nothing, so it stays `web`.
- **Status and recovery:**
  - `withVerifiedRecoveryKey`, the M5.1 key check moved into one function, now used by `recoverWithKey` (web) and `verifyRecoveryKey` (USSD);
  - `resolveVerifiedTicket`, the token chain-following shared with `resolveStatusToken`;
  - `ticketStatusView`.
- The existing recovery tests (61) pass unchanged after the refactor.

### Migration `0012_ussd_sessions.sql`

- **`ussd_sessions`:**
  - `facility_id` may be NULL until the facility code is entered;
  - new columns:
    - `organization_id`;
    - `msisdn_hash` (keyed hash);
    - `step`;
    - `last_text_hash`;
    - `last_response_ct` (AES-256-GCM);
    - `ended_at`;
    - `joined_at`;
  - CHECK that facility and organization are set together, composite FK to `facilities(id, organization_id)`, `step >= 0`, and an index for the per-phone join count.
- **New table `facility_ussd_settings`:** `enabled`, a server-generated `access_code` (`^[1-9][0-9]{5}$`, unique), `updated_by`, composite FK.
- **`tickets_created_channel_chk`** widened to accept `ussd`, the way 0009 widened channel checks.
- **Nothing destructive:** no drop, rename, delete or type change. Nothing wrote `ussd_sessions` before M6.2, so no data is affected.
- **Validation:**
  - fresh database 12/12;
  - a second run applies nothing;
  - `0012` re-executes cleanly;
  - local development database migrated to 12/12 (`db:check`);
  - registered in `infra/scripts/db-identity.js`.

### The four flows

- **Service discovery:** the visitor enters the facility's 6-digit access code.
  - The code is a public identifier, generated by the server when an administrator turns USSD on (`PUT /facilities/:id/ussd`, audited `ussd.enabled` / `ussd.disabled`). It is kept when USSD is turned off, so posters stay valid.
  - The menu lists only that facility's services accepting visitors, 4 per page, with waiting counts.
  - Unknown, disabled and suspended facilities read "No facility has that code"; after three tries the session ends.
  - With no open service: "No service … is taking visitors right now."
- **Join:**
  - The confirm screen re-reads committed figures and fixes an operation id (UUID v7) in the session state.
  - `joinQueue` then creates an ordinary waiting ticket: normal class, no provisional source, under the same session lock and acceptance checks as a web join.
  - The join proof is an HMAC bound to the USSD session; it is never stored.
  - The end screen shows the real ticket code and its 32-character recovery key, grouped in fours.
  - Refusals are explained: paused, closed, not taking visitors, per-phone limit (`USSD_JOINS_PER_PHONE_PER_HOUR`, default 5) or unavailable. None creates a ticket.
- **Status:** ticket code, then recovery key. The result is the committed state:

  - waiting, with "you are next" or "N ahead of you" and an estimate range, never a promise;
  - called, with the counter;
  - serving, on hold or missed.

  No status token is issued, so the visitor's browser tokens and the 3-token cap are untouched.

- **Recovery:** with the code and key, the visitor sees the current ticket, including "Moved from …" after a transfer. "I lost my code or key" gives the staff-assisted path and looks nothing up.

### Authentication and recovery protections

- A public ticket code alone, or a phone number alone, never opens a ticket. Status and recovery require the code and its recovery key, the approved credential (ADR-015).
- The check is the web one: throttles L1–L4 keyed on public identifiers and the source, where the source is `ussd:<phone hash>` (never the provider's address, never the guess). The uniform failure applies to unknown, wrong, other-facility and ended tickets alike, and there is no lockout.
- Tested on PostgreSQL:
  - the 6th wrong key from one phone is throttled;
  - the right key from a clean phone still succeeds.
- The key is used for one check and never enters the session state.
- The join end screen, which shows the key once, is stored encrypted for provider retries. It is cleared by the worker 10 minutes after the session expires.
- Staff grants (QR redemption) are not offered over USSD: a feature phone cannot redeem one.
- No admin event is recorded for a USSD check, because no credential is issued. Failures and abuse thresholds are still recorded by the shared throttle.

### Session and webhook security

- **Order of checks:**
  1. configured provider (404);
  2. JSON body, exact request shape and the three headers (400), before the signature;
  3. HMAC-SHA-256 over the raw body with the context `ussd.v1.` and a ±5 min window (401);
  4. nonce once per provider (409; stored in `sms_webhook_nonces` under `ussd:sandbox`, purged after 24 h with the SMS nonces);
  5. the step.
- **Signatures:** an SMS signature never verifies on the USSD webhook, even with the same secret and renamed headers.
- **Limits:** 4 KB body limit (413); per-address rate limit `USSD_WEBHOOK_RATE_LIMIT_MAX` (default 600, tested `[200,200,429]`). Webhooks are CSRF-exempt, use no session, and ignore cookies.
- **Concurrency:** one transaction per step, holding an advisory lock for the phone and the session row lock.
  - A repeated callback (same step, same text) returns the stored screen. Tested: 6 concurrent repeats of a confirm give one ticket and identical screens.
  - Different concurrent inputs for one step: one applies; the others end the session without effect.
  - A gap in steps, or another phone using the session id, ends without effect.
- **Expiry:** `USSD_SESSION_TTL_SECONDS` (default 180, database time). An expired session cannot join, and a fresh dial with the same id restarts safely.
- **Restart:** a session resumes on a new API process (tested with two app instances).
- **Database unavailable:** the reply is `503` with an END screen, and nothing is created.
- **Bounded concurrency:** at most 2 USSD steps run per process, each holding one connection plus at most one more, so they can never exhaust the pool. Waits beyond 10 s get a "busy" END screen.
- **Hashes only:** the session id and the number are stored as keyed hashes (HKDF purposes `ussd-session`, `ussd-msisdn` from `CONTACT_ENCRYPTION_KEY`). No log line contains a number, session id, input or screen.
- **Tenant scope:** the first facility chosen is fixed for the session. Every lookup is filtered by that facility and its organization; another organization's ticket with the same code and its own key never opens.

### Queue neutrality

Browsing, invalid input, failed joins, status and recovery append no `queue_event` and change no ticket. A join appends exactly one `ticket.create`, and the event chain verifies.

### Capability manifest and Ask Que (MQ.6)

- **Manifest:** `ussd` is `sandbox` / `available` when the deployment can answer, and otherwise `sandbox` / `unavailable` / `not_configured`. It is never `live`.
- **Article:** `visitor.ussd` v2 covers test mode, the facility code, the menu numbers and the code-and-key rule. It never names a shortcode to dial.
- **Contract and version:** `capabilities.json` is updated; knowledge-base version 4 → 5 (`kb-base-check` passes); lock regenerated; README review record.
- **Consistency tests:** the production fixture now has USSD `sandbox`. The former forward-looking test now asserts that the v1 "not offered" article fails A1 and A2.
- **Ask Que wording:** the notice uses the shared sandbox text "sandbox (test only, no real messages)".

### Corrections made during M6.2

- **The M0 `SandboxUssdAdapter` placeholder** accepted every webhook (`verifyWebhook` returned true), logged every input with `console.log` (inputs can hold a recovery key) and had no real flows. It was replaced, and its tests replaced with Group 10 contract tests.
- **Ticket position wording:** the menu first read `position` as a place in line. It is the number of tickets ahead (0 = next), as on the web page. Found by the PostgreSQL test, and fixed.
- **Two static guards met false positives; both guards are unchanged.**
  - The push guard bans `.open(` in the API, to keep push-subscription ciphertext from being decrypted there. The USSD screen cipher, a different purpose key, names its methods `sealScreen`/`openScreen`.
  - The L1 label rule treats bold article text as web controls, so the USSD menu wording in `visitor.ussd` is plain text.
- **Defaults:** the worker's unused `USSD_PROVIDER` default changed from `sandbox` to `off`, like SMS. `.env.example` ships `USSD_PROVIDER=off`.

### Mutation checks (each made a test fail, then reverted)

**Killed:**

- **Webhook:**
  - signature check skipped;
  - nonce check skipped;
  - signature without the USSD context.
- **Session handling:**
  - stored-screen replay removed;
  - foreign phone accepted;
  - expiry ignored;
  - out-of-step processed.
- **Recovery and status:**
  - throttle source shared by all phones;
  - any key opens.
- **Joining and discovery:**
  - per-phone join limit removed;
  - channel `web` instead of `ussd`;
  - non-accepting services listed.
- **Menu engine:**
  - a new operation id on every confirm;
  - the key kept in state.

**Survived, then explained:** "disabled facility still found" survived when only one of its two enabled-flag checks was removed (redundant layers). Removing both is killed.

### Limitations and decisions for review

1. **Key exposure.** The recovery key is shown on a USSD screen, so it transits the USSD provider and network. It never enters our logs, and our stored copy is encrypted and short-lived. This needs a product decision before any live provider.
2. **Key entry.** Typing a 32-character key on a feature-phone keypad is laborious. A shorter credential would be a separate security decision; it was not invented here.
3. **Same credential each time.** Status by USSD needs the code and key at every check, because a feature phone holds no token.
4. **Access code.** The facility access code is a new public identifier. Its screen is in M6.3 (API-only today).
5. **Trusted number.** The per-phone join limit relies on the number the provider reports.
6. **Ask Que wording.** The generic Ask Que sandbox notice says "no real messages", which is accurate but message-oriented.
7. **No SMS opt-in over USSD.**
8. **Real devices.** No real handset or network was exercised. The sandbox proves server behaviour only.

### Live-activation gates (all required before real traffic)

1. An approved aggregator and shortcode, with no card and no personal funds, and its per-session cost.
2. That provider's request format, response format, character set and session timeouts, implemented in its own `UssdAdapter`.
3. Its callback authentication, which must be at least as strong as the sandbox HMAC.
4. Its retry and nonce behaviour.
5. How far its reported MSISDN can be trusted.
6. The key-exposure decision (item 1 above).
7. A real-device acceptance pass.

### Test evidence (local, 2026-11-20)

| Suite                                                            | Result                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                                                                                                        |
| `pnpm test`                                                      | contracts 205, ui 6, channels 66, domain 109, assist 262, continuity 64, api 196, worker 13, web 177: all pass                                                                              |
| `pnpm test:db`                                                   | api 744, worker 102: all pass                                                                                                                                                               |
| New USSD tests                                                   | channels `ussd.test.ts` + `sandbox.test.ts` (Group 10); API `ussd.db.test.ts` 27 (3 consecutive runs), `ussd-env.test.ts` 4; worker `ussd-retention.db.test.ts` 2; browser `ussd.spec.ts` 2 |
| Playwright (full)                                                | 295 passed, 7 skipped (the existing environment-dependent skips), 0 failed                                                                                                                  |
| Knowledge base                                                   | `kb-base-check` against `staging`: kbVersion 4 → 5 accepted, 45 articles                                                                                                                    |
| `pnpm audit --prod --audit-level high`, `audit-gate.js`          | no known vulnerabilities; PASS with no exception                                                                                                                                            |
| Migrations                                                       | fresh database 12/12, idempotent; `db:check` 12/12                                                                                                                                          |
