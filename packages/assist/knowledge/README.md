# Ask Que knowledge base

Source articles for Ask Que (F13), compiled by `scripts/build-kb.mjs` into one versioned JSON
bundle per audience (`dist/kb/<audience>.json`). Design: `.kiro/specs/queuebridge/design.md` §11.2,
§11.5, §11.10 and §11.10a.

**Status (M6.1, knowledge-base version 4):** 45 articles (18 public, 27 restricted) covering the
M1–M5 behaviour and the M6.1 SMS sandbox as implemented. The SMS articles are shown only where
the TEST-ONLY sandbox is set up and say so; the USSD article stays hidden until M6.2. The capability coverage contract is
`capabilities.json`. Evidence and the coverage matrix: `docs/testing/MQ-evidence.md` (MQ.5,
MQ.6).

## Maintenance rule (MQ.6; applies to M6, M7 and every later milestone)

Every PR that changes user-visible behaviour, a capability, a route or a screen label updates the
affected articles, `capabilities.json` and the registry screen defaults **in the same PR**. CI
enforces it (Group 13.5); there is no separate follow-up step.

| Rule        | What fails                                                                                                                                                   | Where it runs in CI                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| C0–C3       | `capabilities.json` malformed, missing a capability, listing an unknown article, or not listing an article that requires the capability                      | every build (`scripts/build-kb.mjs`) and `kb-consistency.test.ts`                                                                            |
| C4, C5      | the server's manifest status or default availability differs from what the articles were reviewed for                                                        | `apps/api/src/que-kb-consistency.test.ts`                                                                                                    |
| A1          | a shown article says its feature is "not offered" or "not available yet"                                                                                     | API test                                                                                                                                     |
| A2          | an article for a `sandbox` or `preview` capability does not say so                                                                                           | API test                                                                                                                                     |
| A3          | an article dated after the newest shown milestone is not gated on a capability that is not live                                                              | API test                                                                                                                                     |
| A4          | an article for a `live` capability still calls it sandbox or test mode (added in M6.1, for the SMS sandbox → live change)                                    | API test                                                                                                                                     |
| R1–R3       | a related route its audiences cannot open, a body link that is not a related route, a missing screen default                                                 | every build and tests                                                                                                                        |
| V1          | a review date in the future                                                                                                                                  | API test                                                                                                                                     |
| V2          | a content change without an article version bump, a version going backwards, or a changed set without a `kbVersion` bump, **against the base branch's lock** | CI step "Knowledge-base version discipline against the base branch" (`scripts/kb-base-check.mjs`; merge base; fails on an unresolvable base) |
| L1          | an article quotes (in bold) a screen label that no longer exists in `apps/web`, `packages/ui` or `packages/domain`                                           | `apps/web/src/que/kbUiLabels.test.ts`                                                                                                        |
| MQ.5 checks | coverage matrix, screen defaults for every role, role claims = state machine and permission map, truthfulness lint, D4                                       | `kb-content.test.ts`, `que-kb-content.test.ts`                                                                                               |

Any new route in `apps/web/src/App.tsx` must also be registered (or listed as deliberately
unregistered) in `packages/assist/src/registry.ts` (D3 check 2), and every registered screen must
give default help to every role that can open it.

### Applying it in M6 (SMS turn alerts, USSD)

1. Change the server manifest entry (`apps/api/src/que/capabilities.ts`). Done in M6.1 for SMS
   (`planned` → `sandbox`). Still to come: USSD `planned` → `sandbox` (M6.2: C4, C5, A1 and A2
   fail for `visitor.ussd`) and SMS `sandbox` → `live` once a provider is approved (C4, C5 and
   A4 fail for `visitor.alerts.sms` and `staff.sms.alerts`).
2. Rewrite the article for the new behaviour (consent, opt-out, caps) with an explicit sandbox
   label ("test only, no real messages"), and bump its `version`.
3. Update `capabilities.json` (status, default availability, documenting articles). Add articles
   for any staff procedure, with coverage-matrix rows in `kb-content.test.ts`.
4. Bump `kbVersion`, run `pnpm --filter @queuebridge/assist kb:lock`, and commit the lock.

### Applying it in M7 (redesign, landing page, onboarding)

1. Renamed or removed controls fail L1: update the articles that quote them (version bump).
2. New screens fail D3 check 2 and the screen-default check until they are registered with
   default articles; new onboarding articles need coverage-matrix rows.
3. Review every article against the final UI and manifest, and record the review below.

## Rules

- One file per article: `knowledge/<audience>/<article-id>.md`. The folder must be one of the
  article's audiences; the file name must equal the `id`.
- Front-matter: `key: value`, inline lists `[a, b]` on one line, integers. Every field of
  `KbArticle` is required. The body is Safe Markdown: headings, lists, emphasis and
  `[text](route:<RouteId>)` links only. Prettier formats the body but not the front matter
  (`embeddedLanguageFormatting: off` for this folder in `.prettierrc.json`), because the compiler
  reads one-line lists only.
- No tenant data: no emails, phone numbers, UUIDs, ticket codes, placeholders or secrets (the
  build fails).
- Staff-only articles may list `privatePhrases`; the build fails if any public article contains
  one (decision D4). The key is build-time only and is never shipped.
- Any content change needs a higher article `version`; any change to the set needs a higher
  `kbVersion` in `kb.json`. Then run `pnpm --filter @queuebridge/assist kb:lock` and commit
  `kb.lock.json`. The normal build only checks the lock.
- Write from the implementation, not the specification. Name buttons and labels exactly as the
  screen shows them.
- A step that names a queue action lists its roles as `- <Step>: <Role>, <Role>.` under
  `## Who can do this`; a permission-gated procedure lists them as one line under
  `## Who can do this` or `## Who can open it`. `apps/api/src/que-kb-content.test.ts` compares
  these lines with the state machine and the permission map, and fails on any role section it
  does not check.
- Mention SMS, text messages or USSD only in articles that require `sms_turn_alerts` or `ussd`,
  and push alerts only in articles that require `turn_alert_web_push`
  (`packages/assist/src/kb-content.test.ts`).
- Describe per-service policy conditionally ("some facilities…"), deployment configuration
  conditionally ("if this site has … set up"), and device support as detected by the page.

## Content review checklist (applied at MQ.5, 2026-11-18)

Each article was checked against the implemented screens, API and state machine:

1. Accurate: labels, steps and limits match the code (sources in the MQ.5 evidence).
2. Roles: only roles the API and state machine allow are named; tested automatically.
3. No promised times: estimates are ranges; no clock times; tested automatically.
4. No promised delivery: push and sound are best effort; `sent` is not `delivered`; no
   background vibration; tested automatically.
5. No fabricated capabilities: SMS and USSD are gated on planned capabilities; AI is described as
   off unless a provider exists; absent features (password reset, email invitations) are stated
   as absent.
6. Privacy: no staff verification questions or answers in public articles (D4); no secrets.
7. Plain language: short sentences, one idea each, no jargon without explanation.
8. Recovery never described as changing queue position; a failed alert never causes a miss.

Not covered by this review: testing with real visitors and staff, and a second reviewer. Both
remain open (MQ.5 evidence, remaining gaps).

## Review record

| Date       | kbVersion | Reviewer    | Scope                                                                                                                                                                                                                                                                                                  |
| ---------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-17 | 1         | Kiro (MQ.2) | Four initial delivery articles                                                                                                                                                                                                                                                                         |
| 2026-11-18 | 2         | Kiro (MQ.5) | Full M1–M5 inventory; the four MQ.2 articles re-reviewed (three corrected, one unchanged apart from its review date)                                                                                                                                                                                   |
| 2026-11-19 | 3         | Kiro (MQ.6) | Consistency rules applied to all 44 articles: `org.signup` no longer relates the administration screen a visitor cannot open (R1); `admin.services` quotes the real form legend (L1)                                                                                                                   |
| 2026-11-19 | 4         | Kiro (M6.1) | SMS moved from `planned` to the TEST-ONLY `sandbox` (MQ.6 rule applied in the same PR): `visitor.alerts.sms` rewritten (v2), new `staff.sms.alerts`, `capabilities.json` updated (status `sandbox`, default `not_configured`), screen defaults for the join, ticket and console screens; rule A4 added |

## Inventory (knowledge-base version 4)

Audiences: V visitor, R reception, C counter, S supervisor, FA facility admin, A auditor. An
organization administrator receives every staff audience.

| Article ID                  | Title                                                  | Audiences         | Capabilities              | Routes                                               | Since | v   |
| --------------------------- | ------------------------------------------------------ | ----------------- | ------------------------- | ---------------------------------------------------- | ----- | --- |
| `org.signin`                | Signing in and out                                     | V, R, C, S, FA, A | none                      | `public.login`                                       | M1    | 1   |
| `org.signup`                | Creating an organization                               | V                 | none                      | `public.signup`                                      | M1    | 2   |
| `staff.invite.accept`       | Accepting a staff invitation                           | V, R, C, S, FA, A | none                      | `public.accept_invite`                               | M1    | 1   |
| `visitor.accessibility`     | Display and alert settings                             | V, R, C, S, FA, A | `accessibility_prefs`     | none                                                 | M5    | 1   |
| `visitor.alerts`            | Turn alerts on your ticket page                        | V                 | `turn_alert_in_app`       | `visitor.ticket`                                     | M5    | 1   |
| `visitor.alerts.push`       | Push alerts for your ticket                            | V                 | `turn_alert_web_push`     | `visitor.ticket`                                     | M5    | 1   |
| `visitor.alerts.sms`        | Text message alerts                                    | V                 | `sms_turn_alerts`         | `visitor.join`, `visitor.ticket`                     | M6    | 2   |
| `visitor.auto_miss`         | Services that mark unanswered calls as missed          | V                 | `auto_miss`               | `visitor.ticket`                                     | M5    | 1   |
| `visitor.display.board`     | The public display board                               | V, R, C, S, FA, A | none                      | `public.display`                                     | M2    | 1   |
| `visitor.join.status`       | Joining a queue and following your ticket              | V                 | `visitor_join`            | `visitor.join`, `visitor.ticket`, `public.display`   | M2    | 1   |
| `visitor.missed.grace`      | If you miss your turn                                  | V                 | none                      | `visitor.ticket`, `visitor.join`                     | M5    | 1   |
| `visitor.offline`           | Using your ticket page without a connection            | V                 | none                      | `visitor.ticket`, `visitor.recover`                  | M3    | 1   |
| `visitor.recovery.how`      | Recovering your ticket on another phone                | V                 | `ticket_recovery_key`     | `visitor.recover`                                    | M5    | 2   |
| `visitor.recovery.key`      | Your recovery key                                      | V                 | `ticket_recovery_key`     | `visitor.recover`, `visitor.ticket`                  | M5    | 1   |
| `visitor.recovery.staff`    | Getting help from staff without your recovery key      | V                 | `staff_assisted_recovery` | `visitor.recover`                                    | M5    | 2   |
| `visitor.ticket.states`     | What your ticket status means                          | V                 | none                      | `visitor.ticket`                                     | M2    | 1   |
| `visitor.ussd`              | USSD access                                            | V                 | `ussd`                    | none                                                 | M6    | 1   |
| `visitor.wait.estimate`     | How wait estimates work                                | V, R, C, S, FA, A | none                      | `visitor.ticket`, `visitor.join`, `staff.console`    | M2    | 1   |
| `admin.counters`            | Setting up counters                                    | FA, S, A          | none                      | `admin.facility`                                     | M1    | 1   |
| `admin.facility.create`     | Creating a facility                                    | FA                | none                      | `admin.home`, `admin.facility`                       | M1    | 1   |
| `admin.policy.recovery`     | Missed-turn and recovery rules for a service           | FA                | none                      | `admin.facility`                                     | M5    | 1   |
| `admin.que_ai`              | The AI explanations setting                            | FA                | none                      | `admin.facility`                                     | MQ    | 1   |
| `admin.readiness.join_link` | Readiness, the join link and the QR code               | R, C, S, FA, A    | `visitor_join`            | `admin.facility`, `staff.facility`, `public.display` | M2    | 1   |
| `admin.services`            | Setting up services and the queue order                | FA, S, A          | none                      | `admin.facility`                                     | M1    | 2   |
| `admin.staff.invite`        | Inviting staff and managing roles                      | FA                | none                      | `admin.facility.staff`                               | M1    | 1   |
| `staff.alerts.status`       | Push alert status for visitors                         | C, S, FA, A       | `turn_alert_web_push`     | `staff.console`, `staff.connectivity`                | M5    | 1   |
| `staff.audit.trail`         | The audit trail and integrity check                    | S, FA, A          | none                      | `staff.audit`, `staff.console`                       | M4    | 1   |
| `staff.auto_miss`           | How automatic missed turns work                        | C, S, FA, A       | `auto_miss`               | `staff.console`, `staff.audit`, `admin.facility`     | M5    | 1   |
| `staff.conflicts.review`    | Reviewing offline actions that need review             | S, FA, A          | none                      | `staff.connectivity`                                 | M3    | 1   |
| `staff.coordinator.limits`  | Working offline: the coordinator device                | C, S, FA          | `offline_coordinator`     | `staff.console`, `staff.connectivity`                | M3    | 1   |
| `staff.coordinator.manage`  | Designating, renewing and replacing a coordinator      | S, FA             | `offline_coordinator`     | `staff.connectivity`                                 | M3    | 1   |
| `staff.counter.calling`     | Calling, serving and completing visitors               | R, C, S, FA       | none                      | `staff.console`                                      | M2    | 1   |
| `staff.device.health`       | Device health and alerts                               | R, C, S, FA, A    | `device_health`           | `staff.connectivity`, `staff.console`                | M5    | 1   |
| `staff.device.lost`         | A lost or stolen staff device                          | R, C, S, FA, A    | none                      | `staff.connectivity`, `staff.console`                | M5    | 1   |
| `staff.fairness.priority`   | Queue order, priority changes and calling out of order | R, C, S, FA, A    | none                      | `staff.console`, `staff.audit`, `admin.facility`     | M4    | 1   |
| `staff.missed.rejoin`       | Returning a missed visitor to the queue                | R, C, S, FA       | none                      | `staff.console`, `admin.facility`                    | M5    | 1   |
| `staff.queue.open`          | Opening, pausing and closing today's queue             | R, C, S, FA, A    | none                      | `staff.facility`, `staff.console`                    | M2    | 1   |
| `staff.recovery.activity`   | Recovery activity in the audit trail                   | S, FA, A          | `recovery_audit_view`     | `staff.audit`                                        | M5    | 1   |
| `staff.recovery.approve`    | Approving a staff-assisted recovery                    | S, FA             | `staff_assisted_recovery` | `staff.console`                                      | M5    | 1   |
| `staff.recovery.assist`     | Helping a visitor who has no recovery key              | R, C, S, FA       | `staff_assisted_recovery` | `staff.console`                                      | M5    | 2   |
| `staff.roles.workflows`     | What each staff role can do                            | R, C, S, FA, A    | none                      | `staff.home`, `admin.facility.staff`                 | M1    | 1   |
| `staff.sms.alerts`          | Text message alerts for visitors                       | R, C, S, FA       | `sms_turn_alerts`         | `staff.console`                                      | M6    | 1   |
| `staff.sync.states`         | What the sync states mean                              | R, C, S, FA, A    | none                      | `staff.console`, `staff.connectivity`                | M3    | 2   |
| `staff.transfers`           | Transferring a visitor                                 | C, S, FA, A       | none                      | `staff.console`, `staff.audit`                       | M4    | 1   |
| `staff.walkin`              | Issuing a walk-in ticket                               | R, C, S, FA       | none                      | `staff.console`                                      | M2    | 1   |
