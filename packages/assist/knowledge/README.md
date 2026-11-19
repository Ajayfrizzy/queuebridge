# Ask Que knowledge base

Source articles for Ask Que (F13), compiled by `scripts/build-kb.mjs` into one versioned JSON
bundle per audience (`dist/kb/<audience>.json`). Design: `.kiro/specs/queuebridge/design.md` §11.2,
§11.5, §11.10 and §11.10a.

**Status (MQ.5, knowledge-base version 2):** 44 articles (18 public, 26 restricted) covering the
M1–M5 behaviour as implemented, plus two capability-gated articles for SMS and USSD that stay
hidden until M6 makes those capabilities available. Evidence and the coverage matrix:
`docs/testing/MQ-evidence.md` (MQ.5).

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

| Date       | kbVersion | Reviewer    | Scope                                                                                                                |
| ---------- | --------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-11-17 | 1         | Kiro (MQ.2) | Four initial delivery articles                                                                                       |
| 2026-11-18 | 2         | Kiro (MQ.5) | Full M1–M5 inventory; the four MQ.2 articles re-reviewed (three corrected, one unchanged apart from its review date) |

## Inventory (knowledge-base version 2)

Audiences: V visitor, R reception, C counter, S supervisor, FA facility admin, A auditor. An
organization administrator receives every staff audience.

| Article ID                  | Title                                                  | Audiences         | Capabilities              | Routes                                               | Since | v   |
| --------------------------- | ------------------------------------------------------ | ----------------- | ------------------------- | ---------------------------------------------------- | ----- | --- |
| `org.signin`                | Signing in and out                                     | V, R, C, S, FA, A | none                      | `public.login`                                       | M1    | 1   |
| `org.signup`                | Creating an organization                               | V                 | none                      | `public.signup`, `admin.home`                        | M1    | 1   |
| `staff.invite.accept`       | Accepting a staff invitation                           | V, R, C, S, FA, A | none                      | `public.accept_invite`                               | M1    | 1   |
| `visitor.accessibility`     | Display and alert settings                             | V, R, C, S, FA, A | `accessibility_prefs`     | none                                                 | M5    | 1   |
| `visitor.alerts`            | Turn alerts on your ticket page                        | V                 | `turn_alert_in_app`       | `visitor.ticket`                                     | M5    | 1   |
| `visitor.alerts.push`       | Push alerts for your ticket                            | V                 | `turn_alert_web_push`     | `visitor.ticket`                                     | M5    | 1   |
| `visitor.alerts.sms`        | Text message alerts                                    | V                 | `sms_turn_alerts`         | `visitor.ticket`                                     | M6    | 1   |
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
| `admin.services`            | Setting up services and the queue order                | FA, S, A          | none                      | `admin.facility`                                     | M1    | 1   |
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
| `staff.sync.states`         | What the sync states mean                              | R, C, S, FA, A    | none                      | `staff.console`, `staff.connectivity`                | M3    | 2   |
| `staff.transfers`           | Transferring a visitor                                 | C, S, FA, A       | none                      | `staff.console`, `staff.audit`                       | M4    | 1   |
| `staff.walkin`              | Issuing a walk-in ticket                               | R, C, S, FA       | none                      | `staff.console`                                      | M2    | 1   |
