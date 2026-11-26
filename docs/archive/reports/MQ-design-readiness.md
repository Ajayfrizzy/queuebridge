# MQ (Ask Que, F13) — Design Readiness Report

**Date:** 2026-11-16  
**Branch:** `chore/mq-spec-reconciliation` (from `staging` at `cebbe06`)  
**Scope:** documentation only. No code, dependency, provider, account or spending change.  
**Decisions:** D1–D4 approved by the product owner on 2026-11-16 (section 7).  
**Recommendation:** **READY** for MQ.1 (section 9).

---

## 1. Reviewed documents and baseline

**Baseline**

- M5 merged into `staging` by PR #8 on 2026-11-16 (merge commit `cebbe06`). Local `staging` was
  fast-forwarded from `2da1ced` to `cebbe06` and matches `origin/staging`; the working tree was
  clean before this branch was created.
- CI on PR #8: all six jobs green (lint and typecheck, tests without DB, tests with PostgreSQL
  including Playwright on Chromium, build, security audit, migrations and constraint validation).
- M5 manual acceptance: Set 1 (checks 1–14) 14 / 14 Pass; Set 2 (checks 15–41) deferred to final
  acceptance after M7, as approved by the product owner on 2026-11-16.

**Specification and decision records**

- `.kiro/specs/queuebridge/requirements.md` REQ-F13.1–F13.10
- `.kiro/specs/queuebridge/design.md` §11 (and §12, §15, §15.5a, §15.9, §15.9a, §17 for M5 facts)
- `.kiro/specs/queuebridge/tasks.md` M5 exit criteria, MQ.1–MQ.6, MQ exit criteria
- `docs/adr/ADR-011-ask-que-deterministic-first-assistant.md`
- `docs/adr/ADR-015-ticket-recovery-and-automatic-no-show.md` (including amendment 1)
- `docs/adr/ADR-013-smart-turn-alerts.md` (states and wording)
- `docs/reports/M5-completion.md`
- `.kiro/steering/{architecture,product,security,testing}.md`, `AGENTS.md`, `README.md`
- `docs/QueueBridge_Technical_Architecture_v1.0.md` Addendum A, PRD Addendum A

**Code inspected (read only)**

- Permissions: `apps/api/src/auth/rbac.ts` (`Permission`, `isOrgAdmin`, `queueActorRoles`,
  `AuthContext.sessionExpiresAt`)
- Transition roles: `packages/domain/src/state-machine.ts`
- API routes: `apps/api/src/routes/*.ts` (prefix `/api/v1`), `routes/auth.ts` (`/auth/me`),
  `routes/push.ts` (`/push/capability`), `routes/recovery.ts`, `routes/sync.ts`,
  `routes/fairness.ts`, `routes/public.ts`, `apps/api/src/readiness.ts`
- Web: `apps/web/src/App.tsx` (router), `components/RequireAuth.tsx`, `lib/permissions.ts`,
  `pages/StaffConsole.tsx`, `pages/StaffHome.tsx`, `pages/FacilityLayout.tsx`,
  `pages/Connectivity.tsx`, `components/TurnAlertStatus.tsx`, `vite.config.ts` (service worker)
- Contracts: `packages/contracts/src/{push,health,recovery,queue,admin}.ts`
- Channels: `packages/channels/src/sandbox.ts`; environment examples (`.env.example`)

## 2. Decisions retained

All ADR-011 principles are kept unchanged:

- Deterministic first; Que is complete with the AI layer disabled (REQ-F13.7.4).
- Offline and low-bandwidth: text-only bundles, in-browser search, public bundle precached.
- Role awareness and tenant isolation; restricted content authorized server-side; visitors get
  the public bundle only; facility-specific context read online from endpoints the user can
  already read and never cached.
- Read-only: no mutation endpoint, no tool calling, outside the authoritative sequence (ADR-004).
- Optional AI behind a provider-neutral `InferenceAdapter`, `disabled` by default, `sandbox` test
  double, no paid mode, hard daily cap, staff session required, no AI for anonymous visitors.
- No personal spending, payment card, paid inference or automatic overage. **No provider selected.**
- Truthful capability status from a manifest generated from server flags, now with a separate
  availability indicator (D1).
- AI layer **disabled by default**; the zero-out-of-pocket rule stays mandatory.
- Offline restricted help: generic procedures only, elapsed-time expiry bounded by the session,
  role-digest binding, invalidation triggers (design §11.5.1–§11.5.3) — unchanged.
- MQ.1–MQ.6 and the MQ exit criteria are preserved; no task or criterion was removed or weakened.

## 3. Corrections made and reasons

| #   | Finding                                                                                                                                                                                             | Action                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | ADR-011 was Proposed; acceptance was listed as part of MQ.1                                                                                                                                         | Status set to Accepted (2026-11-16), recording the product-owner direction approval of 2026-11-07 and this reconciliation; principles listed; "no provider selected" restated. Architecture steering table and section heading updated |
| F2  | MQ entry gate said "M5 exit criteria met", but several M5 exit boxes stay open until Set 2 by the approved schedule                                                                                 | Original gate text kept; a reconciled entry checklist added below it in `tasks.md` (section 8). Open M5 boxes not ticked                                                                                                               |
| F3  | Design §11.2 said `org_admin` "inherits facility-admin articles"; the API lets an org admin satisfy every permission and act as supervisor                                                          | Corrected: `org_admin` receives every staff audience in its organization; links still filtered per facility. Without this, approval, audit and device-health help would be missing for a role that can use them                        |
| F4  | Counter actions (call, serve, complete, miss, recall) are gated by domain transition roles, not by a `Permission` entry; the route registry design mentioned only permissions                       | Design §11.3 clarified: screens use API permissions, article steps reference domain transitions. MQ.1 task text unchanged                                                                                                              |
| F5  | `KbTopic` had no topic for alerts, accessibility or audit                                                                                                                                           | Added `turn_alerts`, `accessibility`, `audit` (additive)                                                                                                                                                                               |
| F6  | The capability manifest has four statuses, but Web Push is built yet switched off without VAPID keys (`/push/capability` returns `disabled`)                                                        | Resolved by D1: separate `availability` indicator (§11.2); never offered as usable when unavailable                                                                                                                                    |
| F7  | `/supervisor/*` is a placeholder page whose code comment says "device health — M5"; device health actually lives on `/staff/facilities/:fid/connectivity`                                           | Marked "not registered" in §11.3.1 so Que never links to it. Code not changed (out of scope); removal or relabel suggested for M7.1                                                                                                    |
| F8  | M5 knowledge-base content was described in one row of §11.10                                                                                                                                        | §11.10a added: article inventory for M5 and capability entries, with "must not say" constraints                                                                                                                                        |
| F9  | Stale status text: tasks header ("not yet merged"), M5.0 and gate-set notes ("CI not run"), `AGENTS.md`, product and architecture steering, `README.md` milestone table                             | Factual status updates only (M5 merged, CI green). No checkbox ticked                                                                                                                                                                  |
| F10 | The service worker's only runtime cache rule matches `/api/v1/facilities/.+/public`, but the real public path is `/api/v1/public/facilities/...`, so the rule matches nothing (pre-existing, M2/M3) | Not changed (code; outside this task). Recorded for MQ.2 correction and regression coverage (sections 5 and 9)                                                                                                                         |
| F11 | REQ-F13.3 IDs are out of order (3.6–3.9 appear before 3.5)                                                                                                                                          | Left as is: IDs are referenced by tests and documents; renumbering would break traceability                                                                                                                                            |
| F12 | "Capability" means three things in the code base: counter-service capabilities (`/counter_service_capabilities`, `routes/capabilities.ts`), `/push/capability`, and Que's capability manifest       | No change. MQ.1 should keep the term "capability manifest" and the `/que/` path prefix and avoid adding to `routes/capabilities.ts`                                                                                                    |

## 4. M5-to-MQ mapping

Each M5 behaviour the user asked Que to explain, with the article that covers it (design §11.10a)
and the code that the article must agree with.

| Topic                                        | Article(s)                                                                  | Audience                                                     | Behaviour as built (source)                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visitor joining and ticket status            | `visitor.join.status`                                                       | visitor                                                      | No account; ticket saved on device; status needs the device status token (`/tickets/:code/status`)                                                                                 |
| Recovery keys and safe recovery              | `visitor.recovery.key`, `visitor.recovery.how`                              | visitor                                                      | 160-bit key shown once, URL fragment only, HMAC-stored; code alone never recovers; up to 3 devices; waits self-expire within 15 min, no lockout; today's tickets only (limitation) |
| Staff-assisted recovery with second approver | `visitor.recovery.staff`, `staff.recovery.assist`, `staff.recovery.approve` | visitor; `WALK_IN` roles; `QUEUE_MANAGE` roles               | Two answers; restricted assistance gives no credential; grant needs a different `QUEUE_MANAGE` approver; single use, 10 min, QR on the visitor's phone; approval list queue-scoped |
| Recovery activity auditing and visibility    | `staff.recovery.activity`                                                   | `AUDIT_VIEW` roles                                           | `GET /queues/:id/recovery/audit` (auditor, supervisor, facility admin, org admin); current display names; no secrets                                                               |
| Missed turns, self-resume, grace             | `visitor.missed.grace`, `staff.missed.rejoin`, `admin.policy.recovery`      | visitor; counter+; facility admin                            | `grace_window_seconds` default 300; `rejoin_policy` `staff_resume` default; ticket status exposes `rejoin_available`, `grace_ends_at`                                              |
| Automatic no-show (default off)              | `visitor.auto_miss`, `staff.auto_miss`                                      | visitor; counter+, auditor                                   | Off by default, 60–3600 s; actor `system`, `call_window_elapsed`; refused while a coordinator is assigned; status exposes `auto_miss_after_seconds`                                |
| Offline sync states                          | `staff.sync.states`, `visitor.offline`                                      | all staff; visitor                                           | Six states; devices registered online first, per browser address; offline walk-ins get temporary references                                                                        |
| Device health and coordinator limitations    | `staff.device.health`, `staff.coordinator.limits`                           | `OPERATIONS_VIEW` (own-device warning for reception/counter) | Eight alert kinds; acknowledge needs `QUEUE_MANAGE`; observation only, never failover                                                                                              |
| In-app alerts, sound, vibration, Web Push    | `visitor.alerts`                                                            | visitor                                                      | In-app first; sound off by default; vibration foreground only; push opt-in, only when set up here; best effort                                                                     |
| Push attempted, sent, confirmed, failed      | `staff.alerts.status`                                                       | counter+, auditor                                            | States `pending`, `sent`, `delivered`, `failed`, `suppressed`, `unknown`; UI labels "Push sent, not confirmed", "Seen on device" (page acknowledgement); counter "Attempted"       |
| Permissions and role workflows               | `staff.roles.workflows`                                                     | all staff                                                    | Permission map in design §11.3.1; transition roles from the domain state machine                                                                                                   |

**Terminology note.** The request's "confirmed" corresponds to the `delivered` state, which the UI
labels "Seen on device" and which is set only by the visitor page's acknowledgement. Articles use
the UI labels and never equate `sent` with seen.

**Channel status.** No channel is described as live without justification: Web Push is `live`
only where VAPID keys are configured; SMS and USSD are `planned` (M6). The worker already defaults
to `SMS_PROVIDER=sandbox` and `packages/channels` has a `[SANDBOX]` adapter, but no SMS or USSD
path is reachable by users yet, so `sandbox` is not claimed until M6 ships it.

## 5. Architecture and security compatibility

**Permission map and route registry (verified, design §11.3.1).** Every protected screen maps to
one API permission enforced in `rbac.ts`; the web router itself checks only sign-in, so Que's
registry is where screen permissions are recorded and the MQ.1 contract test keeps them equal to
the API. Recovery request approval is `QUEUE_MANAGE` and queue-scoped; recovery activity is
`AUDIT_VIEW`; device health is `OPERATIONS_VIEW` with acting gated by `QUEUE_MANAGE`; staff
recovery is `WALK_IN` and never auditors. Cross-tenant facility lookups return 404 through
`requireFacilityPermission`; Que endpoints reuse it.

| Requirement                                             | Compatible? | Basis                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RBAC preserved                                          | Yes         | Que adds read endpoints that reuse `requireAuth` and the permission map; no permission refactor needed. The MQ.1 move of `Permission` to `contracts` is a relocation (`Role` already lives there)                                                    |
| No unauthorized articles or links                       | Yes         | Server-side bundle filtering by audience; per-facility link filtering; F3 and F4 corrections close two gaps in the design                                                                                                                            |
| Visitor help needs no staff authentication              | Yes         | `/que/kb/public` and `/que/capabilities` are public reads; the existing public read rate limit (`PUBLIC_READ_RATE_LIMIT_MAX`) applies                                                                                                                |
| Restricted content authorized server-side               | Yes         | `/que/kb` behind `authenticate`; audiences resolved from `AuthContext.roles`                                                                                                                                                                         |
| Offline cache holds no tenant-sensitive data            | Yes         | §11.5.1 unchanged. Per-service policy (self-resume, auto-miss, staff recovery) is read online only (§11.10a). Que must not reuse the existing staff offline data caches                                                                              |
| Expiry and invalidation                                 | Yes         | `AuthContext.sessionExpiresAt` already exists and `/auth/me` returns `session.expires_at`, so `authorizedUntil = min(session end, issue + TTL)` needs no new session data. Role digest issued by the server with the restricted bundle (D2, §11.5.4) |
| No mutation pathway                                     | Yes         | Que has no write endpoint. The facility AI opt-in (REQ-F13.4.4) is a facility setting written through the admin settings path with the existing `recordAdminEvent` / `admin_events`, not by a Que endpoint, so REQ-F13.6.3 holds                     |
| CSRF on cookie POST (`/que/ask`)                        | Yes         | Existing `onRequest` hook in `app.ts` requires the `x-qb-csrf` header and an allowed Origin on every non-GET `/api/` request                                                                                                                         |
| Package boundaries                                      | Yes         | `packages/assist` imports `contracts` only; `AGENTS.md` already lists it as planned; at MQ.1 the `apps/web` row gains `assist` (`apps/api` already imports all packages)                                                                             |
| Authoritative sequence, single coordinator, audit chain | Unaffected  | Que touches none of them                                                                                                                                                                                                                             |

**Risks to carry into MQ (not blockers).**

- **Bundle size.** The visitor bundle is 180.8 kB gzip against a 100 kB target (M5 limitation).
  The Que panel and its search must be a lazy-loaded chunk and the KB a separate JSON asset, or
  visitor pages get heavier. MQ.3 should record before/after sizes.
- **Service-worker rule (F10).** The existing runtime cache rule does not match the real public
  path. MQ.2 corrects it for the paths Que relies on, adds the rule for `/api/v1/que/kb/public`,
  and adds a browser regression test proving both are served offline.
- **Shared rate-limit store.** Per-IP limits are in-process (M5 limitation); `/que/ask` limits
  have the same property unless MQ.4 stores them in PostgreSQL like the recovery and push throttles.
  Acceptable while the AI layer is off by default.

## 6. Competitive assessment

Design §11.11 records the position. Summary, limited to behaviour that exists or is specified:

| Quality                                  | How MQ delivers it                                                                                              | How it is verified            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| In-context guidance tied to real screens | Articles attached to registered routes; "On this screen" defaults                                               | 13.4 navigation accuracy (CI) |
| Grounded answers                         | Deterministic answers are KB articles; AI output must cite authorized articles                                  | 13.5, 13.7, 13.11             |
| Role-specific help without leaks         | Server-filtered bundles; per-facility links; recovery verification questions kept out of the public bundle (D4) | 13.1, 13.2, 13.11             |
| Offline usefulness                       | In-browser search over precached bundles                                                                        | 13.3, 13.12, 13.13            |
| Help during outages                      | Sync-state, coordinator, provisional-ticket and lost-device articles in the UI's own words, available offline   | 13.3, 13.13                   |
| Accessibility                            | Same WCAG 2.1 A/AA, keyboard and announcement rules as M5; respects device display preferences                  | 13.6                          |
| Zero paid AI                             | Complete with AI off; no provider; cost-mode guard                                                              | 13.8                          |

Honest limits: English only; content quality depends on KB maintenance (MQ.6); offline expiry is
a display bound, not a confidentiality control; AI explanations, if ever enabled, can still be
wrong while passing validation.

## 7. Decisions D1–D4 (approved by the product owner, 2026-11-16)

These were open in the first version of this report; all four are now accepted and recorded in
ADR-011 ("Reconciliation decisions D1–D4") and design §11.

| ID  | Decision (accepted)                                                                                                                                                                                                                                                                                        | Where specified  | Constraints from the approval                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Capability availability.** Four statuses unchanged. Separate server-computed `availability` (`available` / `unavailable`) with `unavailableReason` (`not_implemented`, `not_configured`, `switched_off`). Usable only when `live` and `available`; missing or unknown availability counts as unavailable | §11.2, §11.10a   | REQ-F13.9.1 and capability truthfulness preserved. Web Push without VAPID: `live` / `unavailable` / `not_configured`. Offline, configuration-dependent features are described conditionally   |
| D2  | **Role fingerprint.** One server-side function in `apps/api` over the effective, facility-scoped grants (with a domain separator and the audience-mapping version), issued with the authenticated restricted KB response                                                                                   | §11.5.2–§11.5.4  | Browser compares opaque server values only and never decides authorization; expiry, role-change, sign-out and 401 handling unchanged; no `/auth/me` field without a documented, approved need |
| D3  | **Permission synchronization.** API `Permission` map shared with Que unchanged; five consistency checks: API permissions, Que route access, frontend role assumptions, state-machine operation roles, cross-facility authorization                                                                         | §11.3            | Authorization semantics and state-machine rules unchanged; web hint lists checked, not rewired; no RBAC redesign                                                                              |
| D4  | **Recovery verification privacy.** Public help describes the staff-assisted procedure but not the verification questions, facts checked or expected answers; those stay in restricted staff articles; a build check enforces it                                                                            | §11.5.1, §11.10a | Staff instructions authorized server-side; recovery procedure (ADR-015, §15.5a) unchanged                                                                                                     |

**Difference from the first recommendation (D2).** The first version proposed a pure digest
function in `packages/assist` used by both server and browser. The approved form keeps the
calculation on the server only, and the browser revalidates the restricted bundle after each
successful online `/auth/me` instead of computing a digest itself. REQ-F13.3.8 is still met:
user changes are detected from `/auth/me`, role changes from the Que response.

**Future decisions (not MQ blockers):** whether any researched inference provider qualifies;
whether anonymous visitors may ever use AI; a second KB language. Until then the AI layer stays
disabled by default, no inference provider is selected, and the zero-out-of-pocket rule (no
personal spending, payment card, paid inference or automatic overage) is mandatory.

## 8. MQ.1 entry criteria

Recorded in `tasks.md` under the MQ heading.

- [x] M5 merged into `staging` (PR #8, `cebbe06`, 2026-11-16)
- [x] Set 1 manual acceptance 14 / 14 Pass
- [x] Set 2 (checks 15–41) deferred to final acceptance after M7 (approved); dependent M5 exit
      boxes stay open and are not claimed
- [x] CI green on the merged tree
- [x] No known open critical security or integrity defect
- [x] ADR-011 accepted; specification reconciled with M5
- [x] Remaining M5 limitations recorded and accepted as non-blocking (below)
- [x] D1–D4 approved by the product owner (2026-11-16)

**Remaining M5 limitations and their effect on MQ** (from `M5-completion.md`):

| Limitation                                                         | Effect on MQ                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Set 2 not run (real-device push, phone QR, drills, screen readers) | Articles must not claim device behaviour beyond what is verified; M7 re-checks |
| Recovery finds only today's operational-date tickets               | `visitor.recovery.how` says recovery is for today's ticket                     |
| Recovery activity shows current display names                      | `staff.recovery.activity` says so                                              |
| "Reconnect once" wording also on online refusals                   | Articles quote the UI as it is; if M7 fixes the text, MQ.6 updates the article |
| Visitor bundle 180.8 kB gzip                                       | Que code and KB must be lazy-loaded / separate assets (section 5)              |
| Per-IP rate limits in-process                                      | Same property for Que limits unless stored in PostgreSQL (section 5)           |
| Worker housekeeping jobs without statement timeouts                | None (Que adds no worker job)                                                  |
| Shared test database growth                                        | Que DB tests add to it; no functional effect                                   |
| WebKit/Firefox print variants not in CI                            | None for Que; Group 13 accessibility runs on Chromium in CI                    |
| Late visitor updates under artificial local stress (unconfirmed)   | None for Que                                                                   |

## 9. Recommendation

**READY for MQ.1.** M5 is merged with green CI and Set 1 closed; ADR-011 is accepted with every
principle intact; D1–D4 are approved and specified; MQ.1–MQ.6 and the MQ exit criteria are
unchanged apart from two cross-reference notes (MQ.1 boundary tables, MQ.5 §11.10a). The design
is compatible with the M5 API, permissions, router and service worker without an architecture
change. The AI layer stays disabled by default and no inference provider is selected.

**Implementation blockers:** none. Items MQ must carry (already in scope, not blockers):

- **MQ.2 service-worker route (F10):** the existing runtime cache rule targets
  `/api/v1/facilities/.+/public`, but the real path is `/api/v1/public/facilities/...`. MQ.2 must
  correct the rule for the paths Que relies on, add the `/api/v1/que/kb/public` rule, and add a
  browser regression test proving both are served offline.
- **Visitor bundle size:** 180.8 kB gzip against a 100 kB target. The Que panel and search must be
  a lazy-loaded chunk and the KB a separate JSON asset; MQ.3 records before/after sizes. Route
  splitting of the existing visitor bundle remains M7 work.
- **`/supervisor/*` placeholder:** excluded from the Que route registry (§11.3.1); the
  registry-to-router contract test must fail if it is ever registered. Removal or relabel of the
  placeholder is suggested for M7.1.
- **MQ.1 boundary tables:** add `assist` to the `apps/web` row when the package is created.

### Files changed in this reconciliation

- `docs/adr/ADR-011-ask-que-deterministic-first-assistant.md` — Accepted; acceptance, M5 reconciliation and D1–D4 sections
- `.kiro/specs/queuebridge/design.md` — §11 header note, §11.2 (topics, `org_admin`, D1 availability), §11.3 (transition roles, D3 checks) and §11.3.1, §11.5.1 (D4), §11.5.2–§11.5.4 (D2), §11.10a, §11.11
- `.kiro/specs/queuebridge/tasks.md` — status line, M5 CI annotations, reconciled MQ entry checklist (D1–D4 approved), MQ.1 and MQ.5 notes
- `.kiro/steering/architecture.md`, `.kiro/steering/product.md`, `AGENTS.md`, `README.md` — status text
- `docs/reports/MQ-design-readiness.md` — this report

`requirements.md` was reviewed and not changed.
