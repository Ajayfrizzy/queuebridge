# M3 Completion Report — Continuity Engine (F1 offline, F9)

**Branch:** `feature/m3-continuity-engine`, created from `staging` @ `25d3686` (M2 merged).
**State:** implemented and locally validated; **uncommitted** in the working tree. Not committed, pushed, reviewed or merged.
**Evidence:** `docs/testing/M3-evidence.md` · **Checklist:** `.kiro/specs/queuebridge/tasks.md` (M3) · **Design notes:** `.kiro/specs/queuebridge/design.md` "M3 implementation notes"

## Completed scope

**Database — `infra/migrations/0005_continuity_engine.sql`** (additive, idempotent; `queue_events` untouched and still append-only):

- Devices: health columns, revocation audit fields, composite tenant FK.
- Queue sessions: coordinator grant/expiry/actions/granted-by; **epoch can never decrease** (trigger); a coordinator always has an expiry.
- Client operations: original envelope, reason code, supervisor resolution (`applied | dismissed`, must name resolver, time and reason); review and temp-ref indexes.

**Contracts / packages:**

- `contracts/src/sync.ts`: offline vocabulary (capture vs advancement), strict per-action payloads, temporary references (`P-XXXXXX`), device, coordinator, snapshot, conflict and dashboard DTOs.
- `continuity`: device-side authority evaluation (clock-offset compensation, rollback high-water mark), durable outbox model, flush loop (lost-ACK safe, per-user), reconciliation, local queue projection. Pure, no I/O.
- `domain`: replay treats `coordinator.*` / `sync.*` events as audit-only.

**API:** devices (register, heartbeat, revoke), `POST /sync/batches`, `GET /sync/queues/:id/snapshot`, coordinator assign / failover / renew / revoke, operations health, conflict list and resolve. Offline commands go through the **same** M2 `applyCommand` (state machine, roles, events) after authority checks. Online advancement is fenced while a coordinator is designated.

**Follow-up hardening (second pass, before commit):**

- **Offline authority timing no longer trusts the device wall clock.** The previous rule compared `created_at_client` (device wall clock) with the expiry, so a clock set backwards could make post-expiry actions commit. Now:
  - the snapshot signs `delivered_at` (server clock) into each authority token;
  - the device attaches `authority_timing` evidence to every offline advancement: elapsed time since it _received_ that token, measured monotonically within a page session, with a persisted elapsed floor across reloads/restarts and wall-clock cross-checking (sleep counts; a backwards clock is detected and is sticky);
  - the server (`apps/api/src/queue/timing.ts`) times the action as `delivered_at + elapsed` and holds as `needs_review` anything it cannot establish safely (missing/mismatched evidence, rollback, inconsistent or future-dated evidence, at/after expiry, restarted-and-synced-after-expiry, elapsed going backwards). `created_at_client` is diagnostic only.
  - Valid work is preserved: monotonic evidence inside the window commits even when synced hours later; a restarted device that syncs before expiry commits (server receipt proves it).
- **One-time status link for offline captures.** After a capture is confirmed, the capturing staff member sees the confirmed code with QR and status link once (`StatusHandoverPanel`). The credential is held in memory only, never persisted, logged, broadcast or shown to others; "New status link" replays the operation to rotate it (same user **and** same device only; the old link stops working).

**Web:**

- IndexedDB outbox + caches; service-worker shell (existing PWA precache) with authorized data cached per user.
- Connectivity bar (Online/Offline from real API reachability, unsent and review counts, revoked/ended/storage/shared-device warnings).
- Staff console: offline capture with temporary reference; coordinator-only offline call/serve/complete/miss; capture-only and "another coordinator holds authority" banners; Local / Pending sync / Synced / Needs review on tickets and an outbox panel.
- Connectivity and recovery dashboard (`/staff/facilities/:fid/connectivity`): this device, queues and coordinator authority (assign / failover with reason / renew / end), device health table with revoke, conflict review (apply / dismiss with reason) and history.
- Safe local data: sign-out with unsent actions asks first; caches erased on sign-out and 401; another person's unsent actions are never sent or silently deleted; explicit "clear local data" for supervisors.

## Test results (exact)

| Gate                           | Result                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| format, lint, typecheck, build | PASS                                                                                             |
| Unit (`pnpm test`)             | 299 passed (contracts 68, domain 67, channels 18, continuity 61, ui 6, worker 6, api 45, web 28) |
| DB (`pnpm test:db`)            | 395 passed in 21 files; 5 consecutive runs before the review round, 3 after (M2 baseline 313)    |
| Playwright                     | 108 passed, 4 pre-existing capture-only skips                                                    |
| DB-validation workflow steps   | 7/7 PASS on a fresh database; migrate ×2 and seed ×2 PASS                                        |
| `pnpm audit`                   | 0 high/critical; 5 low/moderate unchanged from M2                                                |

All six architectural acceptance-gate questions have passing tests (`apps/api/src/acceptance-gate.db.test.ts`, mapping in the evidence file).

## Pull request #5 — review and CI

**PR:** https://github.com/Ajayfrizzy/queuebridge/pull/5 (`feature/m3-continuity-engine` → `staging`, not merged). First commit `1676de4`; the follow-up commit addresses CI and review findings (final SHA and CI results in `docs/testing/M3-evidence.md`).

**Pre-commit review:** full diff checked for secrets, temporary files, debug code and unintended changes. Found and fixed: a `waitForTimeout(1500)` used as a negative assertion in the shared-device browser test (replaced by a deterministic check: force a real flush under the second user and assert no request carried the first user's operation id). The status-link replacement now requires an explicit confirmation stating that the visitor's current link and QR code stop working immediately ("Keep current link" leaves it valid; both paths tested).

**CI on `1676de4`:** the push run passed every job. The pull-request run failed one real-PostgreSQL test (`sync-timing.db.test.ts`, exact-expiry boundary). Cause: a **test** defect. Delivery and expiry came from two separate `Date.now()` reads, so on a slower runner the window was 30 min + δ ms and an action at exactly +30 min correctly fell inside it. Fixed by deriving every instant in that file from one per-test anchor and asserting the window is exactly 30 min. No assertion was relaxed; 8/8 local reruns pass.

**Codex review of `1676de4` — 3 findings (all P2, all valid, all fixed with regression tests):**

1. _Device caches keyed only by facility._ After A signed out and B signed in **without a reload**, B's captures were recorded with A's device id, which the server refuses. Fixed: keyed by user + facility, in-flight lookups cleared on identity change, heartbeats sent only for the current user's devices. Regression: `e2e/offline-review-fixes.spec.ts` "finding 1" (failed before the fix).
2. _"Sign-in ended" block never cleared._ After a 401, signing in again inside the running app never resumed syncing. Fixed: the block is cleared when a session is established (not when it ends, to avoid racing the flush that reports it); unsent actions are untouched. Regression: "finding 2" (failed before the fix).
3. _Authority token selection._ Codex was right: the code still presented the queue's stored tokens truncated to 20. My second-pass change to "only referenced tokens" had **not** been applied — a text replacement silently missed after reformatting — and my earlier report wrongly described it as done. Fixed properly: tokens are resolved **per batch at send time** from exactly the authorities its commands reference; batches are cut so none needs more than 20 distinct tokens; tokens no unsent command needs are pruned after each flush. Regressions: `flush.test.ts` "authority selection per batch" (45 commands × 45 tokens → batches 20/20/5, each with exactly its own tokens; failed before the fix) and "finding 3" browser test (online coordinator commits at once; only the current token remains stored). I audited every other unasserted edit from that pass; the only other misses were the results tables in these two documents (stale counts in `1676de4`), now corrected.

**Environment note:** QueueBridge's disposable test container `queuebridge-pg` stopped cleanly (exit 0, 23:32 UTC) during this session without any command from me; I restarted it. No other container or project (including Avroqen) was touched.

## Security assumptions

1. **Devices are session-bound, not attested.** A device id is a registration owned by one staff user at one facility; the session cookie authenticates every request. Anyone holding a valid staff session and the device id could submit as that device — which is exactly the staff user's own authority.
2. **Coordinator tokens are HMAC-signed server-side** (`COORDINATOR_SIGNING_KEY`, or derived from `SESSION_SECRET`). The browser cannot verify them and uses the claims only for UI. Rotating the key invalidates outstanding tokens; their unsent advancement then returns `authority_token_missing` (refused, never applied).
3. **Device clocks are untrusted; offline timing is evidence, not proof.** The server trusts only its own clock and the `delivered_at` / `expires_at` it signed. The device's elapsed-time evidence is used to place an action on the server's timeline and to detect inconsistency. Two irreducible limits remain, and are documented rather than hidden:
   - a **modified client** (or anyone scripting the API with a staff session and the device's token) can fabricate any evidence — no offline scheme can prove time on a device the attacker controls;
   - for an **unmodified app**, a clock moved while the app is **closed**, by an amount the persisted floor cannot reveal, is not detectable. That is why evidence that crosses a restart is accepted without review **only if the server receives it before expiry**.
     Within one page session the monotonic clock bounds the device. Epoch fencing, short TTLs (5–720 min), sync-on-reconnect and supervisor review are the real controls.
4. **Offline storage is not a confidentiality control.** IndexedDB holds ticket codes, states, counter names and a minimal staff identity (no email, no visitor contact data). Anyone with the unlocked device and browser profile can read it. Clearing it on sign-out and 401 is best-effort.
5. **Pending counts and device health are self-reported** and labelled approximate. They never affect correctness.

## Manual acceptance steps

```bash
docker start queuebridge-pg
export DATABASE_URL=postgres://postgres:password@localhost:55433/queuebridge
pnpm install && pnpm build && pnpm db:migrate
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
NODE_ENV=development pnpm dev:api     # :3002
pnpm --filter @queuebridge/web build && pnpm --filter @queuebridge/web preview   # service worker needs a build
```

1. Set up a facility, service, counter and open today's queue (as in M2). Invite a counter operator and sign them in in a second browser profile.
2. **Register the device:** as the counter operator, open the queue console online. The device registers automatically.
3. **Designate:** as admin/supervisor, open **Staff console → facility → Connectivity and recovery**, choose the counter's device, **Make coordinator**. The counter's console shows "This device is the offline coordinator…"; Call next on other devices is paused.
4. **Outage:** take the counter's browser offline (DevTools → Network → Offline). The bar shows Offline. Issue a walk-in: a temporary reference `P-XXXXXX` appears marked **Local**. Call next: the ticket shows Local; the visitor page and display board do not change.
5. **Reload while offline:** the console reopens and the unsent actions are still listed.
6. **Reconnect:** the actions turn Synced; the walk-in gets a real code; the visitor and board update.
7. **Conflict:** go offline on the coordinator and call next. As supervisor, **End authority** (or fail over to another device) and call the same visitor online. Reconnect the coordinator: its call shows **Needs review** with a reason. In the dashboard, dismiss (or apply) with a reason; the coordinator's device shows the outcome.
8. **Expiry:** designate with a 5-minute authority, go offline and wait: Call next is disabled with "Offline authority expired — ticket capture only"; walk-in capture still works.
   8a. **Clock change:** as coordinator, go offline and set the computer's clock back by an hour: the console shows "This device's clock was changed … ticket capture only". Anything recorded under that authority that syncs later is held for review (`clock_rollback`).
   8b. **Status link after offline capture:** capture a walk-in offline, reconnect: "Confirmed offline tickets" shows the real code (never the `P-` reference) with a QR code. Scan it on a phone; press **Done**. **New status link** produces a fresh link and the old one stops working.
9. **Revoke a device:** in the dashboard, **Revoke → Confirm**. The device's next sync shows "This device was revoked".
10. **Sign-out safety:** with unsent actions, Sign out asks to send or discard.

## Unresolved risks and limits

1. **Not yet run in GitHub CI** (nothing committed). Playwright is Chromium only; Safari/WebKit IndexedDB and service-worker behaviour is unverified.
2. **Single-device durability.** Unsent actions live only in that browser. If the device is lost or storage is cleared before sync, they are gone. The UI warns, but there is no second replica (architecture "Browser storage cleared").
3. **Conservative fence costs throughput.** While a coordinator is designated (even expired), nobody can call online until a supervisor revokes or fails over. This follows the architecture's conservative default, but needs supervisor attention after every outage.
4. **Offline vocabulary is limited** to capture, call next, serve, complete and missed. Hold, return, cancel, transfer and queue controls need the server.
5. **The status-link hand-over is memory-only.** If the page reloads before the staff member sees it, the link is gone; they press "New status link" (needs a connection), which rotates the credential. Only the capturing user on the capturing device can do this, so if that device is lost the visitor has the code but no status link until M5 recovery.
6. **Offline timing limits** (assumption 3): fabricated evidence from a modified client, and undetectable clock changes while the app is closed (bounded by the restart rule). Conservative side effect: a restarted coordinator that reconnects only after expiry has its post-restart actions held for review even if they were genuine.
7. **Timer behaviour varies by platform.** If a browser throttles or suspends `performance.now()` differently from what was tested (Chromium), the wall-clock cross-check makes the estimate larger (more conservative), never smaller.
8. **Rate limits and caps are per API instance** (as in M2). The device cap is 20 live devices per user per facility.
9. **Polling.** The dashboard refreshes every 5 s and the outbox retries every 15 s; the load is unmeasured (M7).
10. **`pnpm audit`** still shows the 5 low/moderate advisories carried from M2.

## Architectural blockers

None. The acceptance gate is answered in code and tests. Offline behaviour is **not** conflict-free: conflicts are detected and surfaced for explicit supervisor resolution, never merged.

## Changes to earlier artifacts

- `CommandResultSchema` (M0): `operation_id` is nullable (for malformed commands); adds `index`, `reason_code`, `ticket_id`, `public_code`, `status_token`. `SyncBatchResponseSchema.queue_session_revision` was replaced by `queue_revisions` (per queue). Neither was used before M3.
- `continuity/reconcile.ts` (M0) was rewritten around the outbox model; `LocalOperation` was replaced by `OutboxOperation`.
- The `SyncStateIndicator` label for `duplicate` is now "Synced" (a repeat of an already-confirmed action); the descriptions say "not confirmed by the server".
- `/auth/me`, login, sign-up and invite acceptance also return `session.expires_at` (additive).
- `vite.config.ts`: dev proxy and service-worker denylist include `/health` (reachability probe).
- `.env.example`: optional `COORDINATOR_SIGNING_KEY`.
- `CoordinatorAuthSchema` gains optional `delivered_at`; `CommandEnvelopeSchema` gains optional `authority_timing` (required in practice for advancement — absent ⇒ needs_review).
- Offline replays are bound to the recording device as well as the user (`operation_id_reused` otherwise).
- `validateCoordinatorEpoch` / `canAdvanceOffline` (M0) are marked `@deprecated` for device use (wall-clock only).

Out of scope and untouched: M4 fairness, MQ Ask Que, M6 SMS/USSD, Smart Turn Alerts, final visual redesign.
