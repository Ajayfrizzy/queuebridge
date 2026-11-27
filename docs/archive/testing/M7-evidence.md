# M7 Test Evidence — Final UI/UX, Branding, Landing Page, Hardening

## M7.1 — Design system, branding and responsive redesign (2026-11-20)

Branch `feature/m7-1-design-system`, baseline `d2cc0f5` (M6.3 merge into `staging`). Visual
baseline: `docs/design/QUEUEBRIDGE-DESIGN-SYSTEM.md` (approved). Presentation milestone: no
route, authorization, queue rule, offline rule, API contract, database or provider change. GitHub
Actions was unavailable (account limits); every result below is **local** only.

### Tokens and themes (`packages/ui/src/tokens.ts`)

- Brand anchors navy `#102A43`, blue `#2563EB`, teal `#0D9488`; semantic roles for canvas,
  surfaces, text, borders (decorative and control), brand navy, primary and hover, links, accent,
  success, warning, danger, information, focus and the called-state banner.
- Four palettes: light, dark (follows `prefers-color-scheme`), high contrast (the existing
  device preference `data-contrast='high'`, or `prefers-contrast: more` while the preference is
  "system"), and high contrast on a dark system. Forced-colours mode is left to the browser (the
  select arrow falls back to native, as before).
- Spacing (4 px base), radii (6/10/12/16 px and pill), type scale (page 26/30 px, section 20/22
  px, card 18 px, body 16 px, meta 14 px, ticket 40–72 px, board up to 112 px), elevation, motion
  (140 ms feedback, 200 ms panels, 0 ms under either reduced-motion setting), layout sizes
  (44 px controls, sidebar 15rem / 4.5rem).
- Rendered by `tokensToCss()` into `apps/web/src/tokens.css` (generated; `pnpm --filter
@queuebridge/ui tokens:css`), loaded before `styles.css`. `apps/web/src/tokens.test.ts` fails on
  drift and on any raw colour in `styles.css` (documented exceptions: `#fff` for the QR code and
  the logo tile; translucent black/white scrims).
- Contrast: every pair a screen draws is listed in `CONTRAST_PAIRS` and measured in every theme
  (4.5:1 text, 3:1 UI parts and focus); high contrast reaches 7:1 for text, muted text and links.
  Rendered screens are additionally checked by axe.
- Existing preferences are unchanged (`qb.a11y.v1`: contrast, text size, motion, quiet); no new
  settings store. There is no explicit light/dark switch: dark follows the system.

### Typography

Inter is named first in the stack and used only when installed on the device. No licensed font
file was available in the repository or dependency tree without adding one, so no font is
self-hosted and no font request is made; the approved system stack is the fallback. Tabular
numerals on ticket codes, stats, tables and board identifiers.

### Brand assets (supplied by the product owner, reused)

| File                                                                | Use                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web/public/favicon.ico` (16, 32)                              | `<link rel="icon">`                                                                               |
| `apps/web/public/favicon.png` (64)                                  | `<link rel="icon" type="image/png">`; the header mark (32 px, white tile)                         |
| `apps/web/public/apple-touch-icon.png` (180)                        | `<link rel="apple-touch-icon">`                                                                   |
| `apps/web/public/icons/icon-192.png`, `icon-512.png`                | manifest icons (existing wiring)                                                                  |
| `apps/web/public/icons/icon-maskable-512.png`                       | manifest icon, `purpose: maskable` (added)                                                        |
| `apps/web/src/assets/brand/queuebridge-logo.png` (2172×724, 439 KB) | source; a downscaled copy `queuebridge-logo-720.png` (720×240, 71 KB) is shown on the home screen |
| `apps/web/src/assets/brand/queuebridge-mark.png` (1254², 523 KB)    | source only (too heavy for the header; the 64 px favicon is the same mark)                        |

No logo was drawn, traced, regenerated or converted to SVG. The single manifest (vite-plugin-pwa)
gains `theme_color #102a43`, `background_color #f8fafc` and the maskable icon; `index.html` gains
the PNG icon, the apple-touch icon and `color-scheme`. **Asset limitations:** the supplied
artwork has a light ground and no dark or monochrome variant, so on navy, dark and high-contrast
surfaces the mark and logo sit on a white tile (container contrast) instead of a second drawing;
the approved spec's SVG variants and monochrome rule do not exist yet.

### Screens

- **Shell:** one "Primary" navigation at every width. Signed-in staff on desktop (64rem+): a
  navy sidebar with icons and labels, collapsible to an icon rail ("Collapse navigation" /
  "Expand navigation", `aria-expanded`, not stored); names remain accessible when collapsed.
  Phones and visitors: the header as before, with the brand mark.
- **Shared components** (on the tokens): buttons (primary, secondary, tertiary, danger; 44 px),
  fields (44 px, persistent labels, invalid state with a ⚠ error prefix), cards (12 px radius,
  soft border and shadow), alerts (left rule + tint + words), badges and sync indicators (text +
  symbol), ticket rows, tables (header row, compact cells, labelled scroll region), dialogs,
  Ask Que panel and sheet, toasts. New: `Icon` (decorative, `aria-hidden`).
- **Visitor:** join, ticket (40–72 px code), recovery, alerts and preferences restyled; turn
  banner unchanged in behaviour and still has no animation or transition.
- **Reception and counter:** console focal "current ticket" card, waiting rows; actions wrap
  inside the row under large text instead of widening the page (found by the new 320 px /
  150 % check).
- **Supervisor and administration:** facility overview, services, counters, staff, channels,
  audit, fairness and connectivity on the shared components, sidebar shell.
- **Public board:** navy ground, white text, identifiers up to 112 px, counter names up to 56
  px; codes only, spoken announcements unchanged.
- **Ask Que:** same tokens, raised surface, divider under the title; behaviour unchanged.

Not redesigned structurally: page markup and copy outside the MQ.5 fixes stayed as they were,
so existing selectors, names and tests apply; the redesign is the shared visual system plus the
shell. The M7.2 landing page was not started; `/` is unchanged apart from the logo.

### MQ.5 U1–U5

| Finding | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1      | Service form hint: "Counted from when the ticket is marked missed: how long it can still return to the queue."                                                                                                                                                                                                                                                                                                                                                          | `FacilityServices.tsx`                                                                                                                                                                                                                                                |
| U2      | The "Call out of order" form renders only for supervisors and organization administrators; facility administrators keep "Change priority". API unchanged (it already refuses).                                                                                                                                                                                                                                                                                          | `design-system.spec.ts` U2                                                                                                                                                                                                                                            |
| U3      | The visitor status gains `transfer_placement`, read from the committed `ticket.transfer` event's `destination_placement` (the source ticket's transition into `transferred`, same organization, same destination ticket); the note renders that value. Unknown (an older saved copy) → "moved to this service" with no placement claim. Never inferred from the current policy. Corrected after the independent review (the first version searched the policy summary). | `fairness.db.test.ts` "M7.1 U3" (both placements; a later destination policy change leaves the reported placement unchanged; a non-transferred ticket reports null; no token → 404); `policy.test.ts`; mutation: deriving it from the current policy fails both cases |
| U4      | Audit actor from the hash-chained `actor_kind`: `System (automatic)` / `Visitor`; old events without it keep "Visitor / system"; `ticket.miss` shows "reason: call window elapsed (automatic no-show)".                                                                                                                                                                                                                                                                 | `AuditTrail.test.ts`                                                                                                                                                                                                                                                  |
| U5      | "Put on hold" on waiting rows for counter operators and supervisors (state machine `waiting → paused`), through the normal command path, disabled offline/via outbox like Cancel.                                                                                                                                                                                                                                                                                       | `design-system.spec.ts` U5 (reception sees none)                                                                                                                                                                                                                      |

### Ask Que (MQ.6)

kbVersion 6 → 7: `visitor.ticket.states` v2, `staff.counter.calling` v2, `staff.auto_miss` v2;
no route, screen or capability added; lock regenerated; `kb-base-check` against `staging` passes;
review row in `packages/assist/knowledge/README.md`.

### Tests changed or added

- New: `packages/ui/src/tokens.test.ts` (11), `apps/web/src/tokens.test.ts` (3),
  `apps/web/src/pages/AuditTrail.test.ts`, U3 cases in `policy.test.ts` and
  `apps/api/src/fairness.db.test.ts`,
  `apps/web/e2e/design-system.spec.ts` (10: 4 themes × 12 screens × 5 widths with axe and
  overflow, large text, assets and manifest, sidebar, board, U2, U5).
- Adapted (intent kept): `ui-layout.spec.ts` keyboard order includes the sidebar toggle at
  desktop widths (a new control); `m1-refinements.spec.ts` "content fills the viewport" measures
  against the width beside the sidebar and requires the sidebar to stay ≤ 260 px and the content
  > 80 % of a 1400 px+ viewport.

### Gate results (local, 2026-11-20)

| Gate                                                             | Result                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                        |
| `pnpm test`                                                      | contracts 205, ui 17, channels 66, domain 109, assist 262, continuity 64, api 196, worker 13, web 186: pass |
| `pnpm test:db`                                                   | api 758, worker 114: pass                                                                                   |
| Playwright (full, 5 projects)                                    | 318 passed, 7 skipped (existing environment-dependent skips), 0 failed                                      |
| `pnpm audit --prod --audit-level high`, `audit-gate.js`          | no known vulnerabilities; PASS                                                                              |
| Knowledge base                                                   | kbVersion 6 → 7 accepted against `staging`, 47 articles                                                     |

### Outstanding

- Manual: screen-reader passes, 200 % zoom, real-device high contrast and reduced motion
  (M5 Set 2 / final acceptance); visual sign-off by the product owner.
- No dark/monochrome logo artwork (white tile used); no self-hosted Inter file.
- Dark theme follows the system only (no in-app switch).
- Remote CI not run.

## M7.2 — Animated public landing page and onboarding (2026-11-21)

Branch `feature/m7-2-landing-onboarding`, baseline `08aae0b` (M7.1, PR #21). Uses the M7.1
tokens, components and supplied logo only. No API, database, authorization, queue or provider
change. GitHub Actions remains unavailable: every result below is **local**.

### Route architecture

- `/` renders `apps/web/src/landing/LandingPage.tsx` through `React.lazy` + `Suspense`
  (`App.tsx`); `pages/Home.tsx` is removed (its saved-tickets list moved into the landing page
  unchanged: `data-testid="my-tickets"`, same link text and `ticketPath`). Every other route path is
  unchanged.
- Nothing outside `src/landing/` imports it. i18next/react-i18next, the landing CSS, the story,
  the hero art and the logo PNG are in the landing chunk only. `publicKb` (the capability loader)
  became a 344-byte shared chunk between Ask Que and the landing page.
- PWA: the service worker still precaches every built asset (existing behaviour), so a device
  that installed the worker may fetch the landing chunk in the background; no visitor or staff
  page requests it (tested with the worker blocked).

### Sections

Hero (headline, supporting line, logo, "Set up your facility" → `/signup`, "Sign in" → `/login`,
"How visitors join" → `#how-visitors-join`; signed in: "Continue to administration" or "Open the
staff console"); continuity story; who it serves (six roles); what it does (nine capabilities);
channels from the manifest; how visitors join; get-started checklist; footer (privacy,
accessibility statement and feedback path, repository link, MIT licence, footer navigation).
No metric, customer, logo or testimonial.

### Continuity story

Six stages (join, wait with range, connection drops, one authorized coordinator continues with
"Local only" actions while other devices only capture tickets, reconnect with "Synced" and "Needs
review", committed "It's your turn" with best-effort push/SMS). All titles and captions are
always in the page; the SVG illustrates the current stage only. 5 s per stage (30 s loop) with a
visible Pause/Play button plus Previous, Next and the stage list (which pause it). Automatic
changes are never announced; a person's change is announced once in a polite status region.
Stops while the tab is hidden. Reduced motion (system or the device setting, followed live):
no autoplay, no transitions, all six stages with their pictures shown together. Motion is
opacity/transform only; the hero has one sub-second entrance and no loop. No data, request or
sound is involved.

### Channel status

Rendered from `GET /api/v1/que/capabilities` (`loadCapabilities`, schema-validated, fail closed)
by `channelView()`: only `live` + `available` is "Live"; `sandbox` is always labelled test-only
("Not a production service"), or "not set up" when unavailable; `planned`, `not_configured`,
`switched_off` have their own wording; a missing, failed or malformed manifest shows "Status
unavailable" for every channel. Baseline deployment: web/QR live, SMS sandbox, USSD sandbox.

### Onboarding

Signed out: seven steps, step 1 links `/signup`, "Already set up? Sign in"; no other link and no
data request. Signed-in administrator (org admin or any facility admin): `listFacilities` and
`readiness` (existing authorized endpoints); facility chooser when there are several; states
Done / To do from readiness (service active; configuration ready), "Check on the screen" where
readiness has no data (staff, sharing, first visitor); links `/admin`,
`/admin/facilities/:id/{services,counters,staff}`, `/admin/facilities/:id`,
`/staff/facilities/:id` (all existing). Other staff: a pointer to the staff console. The list
enforces nothing.

### Localization

All landing copy, accessible names and story captions are in `src/landing/locales/en.ts`, read
through an i18next instance created in the landing chunk (`src/landing/i18n.ts`; bundled
resources, synchronous init, English fallback). This is the first use of the i18next
dependency; other screens are not yet migrated (out of M7.2 scope). Tests: every key resolves
(no raw keys or unfilled placeholders), a substituted bundle changes the rendered text and falls
back to English per key, and the Playwright spec reads its expectations from the bundle.

### Security and privacy

- Single header source `apps/web/src/pwa/securityHeaders.ts`: CSP (`default-src 'self'`, no
  other origin, no `unsafe-inline`/`unsafe-eval`, `frame-ancestors 'none'`), HSTS, `X-Frame-Options`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, `nosniff`. `vite preview` sends it, so the
  **whole Playwright suite runs under the production CSP**. Deployment requirement:
  `docs/deployment/web-security-headers.md` (unit test keeps it equal to the source).
- Found under the CSP: Zod's JIT probe (`new Function`) reported a `script-src` violation; the app
  now sets `z.config({ jitless: true })` first (`src/zodConfig.ts`; same validation results).
- Not verifiable before deployment: the production edge sending the headers, HSTS over real
  HTTPS, TLS. Recorded for M7.3/M7.5.
- The landing page makes only same-origin requests (tested: no foreign request, no CSP violation);
  no analytics, fonts, CDNs or scripts were added; no new dependency.

### Bundle measurements (`gzip -9`, bytes; `pnpm --filter @queuebridge/web bundle:check`)

| Asset                  | Before M7.2 (`08aae0b`) | After M7.2 | Threshold                 |
| ---------------------- | ----------------------: | ---------: | ------------------------- |
| Entry JS (every route) |                 195,289 |    195,277 | ≤ 197,241 (baseline + 1%) |
| Entry CSS              |                   6,919 |      6,926 | ≤ 6,988 (baseline + 1%)   |
| Landing JS (lazy)      |                       — |     24,225 | ≤ 26,647 (first + 10%)    |
| Landing CSS (lazy)     |                       — |      2,257 | ≤ 2,482 (first + 10%)     |

The check also fails if the entry contains landing-only code (the headline, i18next) or
`index.html` preloads the landing chunk. Baseline and tolerances: `apps/web/bundle-baseline.json`.
CI wiring and Lighthouse are M7.3.

### Accessibility and responsive

`landing.spec.ts`: axe clean and no page overflow at 320, 375, 768, 1280 and 1440 px in light,
dark, high contrast, high contrast on a dark system and 150 % text; one `h1`, no skipped heading
level; keyboard reaches every hero action and story control with a visible focus; reduced motion
static equivalent with no animation or transition anywhere (system and device settings).
Fixed during M7.2: sidebar link colour transitions passed through low contrast when the shell
switched after sign-in (an axe race seen once in `design-system.spec.ts`); link colours no longer
transition (4 repeated passes afterwards).

### Tests

- New: `src/landing/landing.test.tsx` (13: channels, localization, onboarding, story timing,
  pause, reduced motion), `src/pwa/securityHeaders.test.ts` (4), `e2e/landing.spec.ts` (21),
  raw-colour check extended to `landing.css`.
- Adapted, intent unchanged: `admin-journey.spec.ts` starts sign-up from "Set up your facility";
  `turn-alerts.spec.ts` expects the landing headline as the home `h1` after "Forget this ticket";
  `accessibility-m52.spec.ts` 11.A6 probe adds its test stylesheet through the CSSOM instead of
  an inline `<style>` (forbidden by the CSP), with the same assertions.

### Gate results (local, 2026-11-21)

| Gate                                                             | Result                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                        |
| `pnpm test`                                                      | contracts 205, ui 17, channels 66, domain 109, assist 262, continuity 64, api 196, worker 13, web 205: pass |
| `pnpm test:db`                                                   | api 760, worker 114: pass on the third run; see below                                                       |
| Playwright (full)                                                | 339 passed, 7 skipped (existing environment-dependent skips), 0 failed                                      |
| `bundle:check`                                                   | PASS                                                                                                        |
| Audits                                                           | `pnpm audit --prod --audit-level high`: none; `audit-gate.js`: PASS                                         |
| Knowledge base                                                   | kbVersion 7 → 8 accepted against `staging`, 47 articles                                                     |

**Intermittent DB tests: investigated and fixed (2026-11-21).** Both were test defects, not
application defects; no production code changed. Details in "M7.2 database test stability
investigation" below.

### Limitations

- Manual screen-reader pass of the landing page and real-device checks: final acceptance (Set 2).
- Production headers verified only on the local preview server.
- i18next is used by the landing page only; English only.
- The authenticated checklist shows the first facility by default and cannot report staff
  invitations, sharing or a first visitor as done (no readiness data for them).

### M7.2 database test stability investigation (2026-11-21)

`pnpm test:db` runs the API and worker DB suites at the same time (`pnpm --filter … test:db`),
and vitest runs each suite's files in parallel. The API suites share the `queuebridge_test`
database; the worker SMS suites each create their own throwaway database.

**1. Worker `sms-alerts.db.test.ts` "the facility cap stops one facility…" (observed `sent: 2`,
expected 3).**

- Not a concurrency problem: the file uses its own database, tests in a file run sequentially,
  and `beforeEach` closes every pending outbox row and clears `sms_daily_usage`.
- Cause: the default test phone number was uniformly random
  (`+234803` + 7 digits). The TEST-ONLY sandbox chooses a simulated outcome from the last three
  digits (`SANDBOX_SMS_SCENARIOS`: `001` rejected, `002` unavailable/retry, `003` transport error),
  so 3 in 1,000 random numbers were not ordinary numbers. One run of the file draws 90 random
  numbers (measured), so about 24 % of runs contain at least one scenario number; a run fails when
  it lands on a row whose outcome a test asserts.
- Reproduction: forcing one of that test's numbers to end in `002` gives exactly the observed
  result, three out of three runs: `{"claimed":5,"sent":2,"capped":2,"retrying":1,…}`.
- Fix (test only): `ordinaryPhone()` in `sms-alerts.db.test.ts` and `sms-startup.db.test.ts` (the
  latter's control run "sends" has the same exposure) redraws until the suffix is not a sandbox
  scenario, derived from `SANDBOX_SMS_SCENARIOS`. Tests that exercise a scenario still choose
  that number explicitly. No assertion changed.

**2. API `ussd.db.test.ts` "recovery with code and key… after a transfer" (observed a row count
+1/+2).**

- Cause: to prove that "lost code or key" records no recovery attempt, the test compared
  `SELECT COUNT(*) FROM recovery_throttle` before and after. That table is global (no tenant
  column) and other API suites running at the same time (`recovery*.db.test.ts`, other USSD tests)
  write to it, so the count could change for reasons unrelated to this request.
- Reproduction: the unchanged test failed 1 of 6 runs when run concurrently with the recovery
  suites (`expected 14023 to be 14022`), and **3 of 3** runs with a background process writing
  unrelated `recovery_throttle` rows every 10 ms during the test.
- Fix (test only): the assertion now covers every throttle key the recovery code can derive for
  this request (`targetKeys`: source, target, target-source, facility, facility-source) for this
  phone, this facility and both ticket codes of the test, checked unchanged, plus no `source` row
  at all for the phone that only chose "lost". The derivation is checked against reality (the
  recovering phone's own `source` row is found with ≥ 1 attempt). Mutation: inserting one
  throttle write for the facility-source key on the "lost" path makes the test fail.
- Not an application defect: recovery and its throttles are unchanged and still covered by
  `recovery.db.test.ts` (including the guess-independent keys and atomic counting).

**Verification (exact commands, local):**

| Command                                                                                                                               | Runs | Failures |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---: | -------: |
| `cd apps/worker && npx vitest run --config vitest.db.config.ts src/sms-alerts.db.test.ts` (fixed)                                     |   15 |        0 |
| same, the forced-`002` reproduction on the old generator                                                                              |    3 |        3 |
| `cd apps/api && npx vitest run --config vitest.db.config.ts src/ussd.db.test.ts -t "after a transfer"` (fixed, isolated)              |   10 |        0 |
| `… src/ussd.db.test.ts src/recovery.db.test.ts src/recovery-staff-limit.db.test.ts src/recovery-audit.db.test.ts` (fixed, concurrent) |    8 |        0 |
| target test with concurrent unrelated `recovery_throttle` writes: old / fixed                                                         |  3/3 |    3 / 0 |
| `pnpm test:db` (API 760 and worker 114, concurrently)                                                                                 |    5 |        0 |
| `pnpm --filter @queuebridge/api --filter @queuebridge/worker test`; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                |    1 |        0 |

Not done: no repeated runs of the old worker test beyond 15 (0 failures there is consistent with
the low per-test rate); the cause is established by the deterministic reproduction and the
measured draw count, not by a retry.

### M7.2 final review corrections (2026-11-21)

1. **Story stage 5 caption** (`src/landing/locales/en.ts`): "Most are confirmed" removed (no
   evidence for a success rate). Now: the server verifies each submitted action; valid actions are
   confirmed; an action that conflicts with what the server already recorded is flagged "Needs
   review" for a supervisor and never silently overwrites it. Six stages and the i18n structure
   unchanged.
2. **Onboarding readiness scoped to the selected facility** (`src/landing/Onboarding.tsx`): the
   readiness answer is stored with the facility id it was loaded for and used only while that
   facility is selected. Before, the previous facility's readiness was still rendered for one
   pass after a switch (it was cleared in an effect). The existing cancellation of stale requests
   and the authorized endpoints are unchanged. New `src/landing/onboarding.test.tsx` (3 tests,
   API replaced by controllable promises): no state from the previous facility before the new
   answer; a late answer for a facility no longer selected is ignored; switching back waits for
   that facility's own fresh answer. Mutation: using the stored readiness without the facility
   check fails 2 of the 3.
3. **Logo backing token** (`src/landing/landing.css`): `#fff` replaced by
   `var(--qb-color-on-brand-navy)`, which is `#ffffff` in all four themes; a new assertion in
   `packages/ui/src/tokens.test.ts` keeps it white. `landing.css` now has no raw colour. Logo
   files unchanged.

Verification (local): `apps/web` vitest 208 passed (landing, onboarding, tokens and
copy-truthfulness included); `packages/ui` 18 passed; Playwright `landing.spec.ts`,
`admin-journey.spec.ts`, `design-system.spec.ts` on desktop-chromium 33 passed; `pnpm
format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `bundle:check` (landing JS 24,251 B
gzip, limit 26,647) pass.

### M7.2 visual acceptance refinements (2026-11-21)

**A. Theme selection.** The existing device preference (`qb.a11y.v1`, M5.2) gains `theme`:
`system` (default, follows `prefers-color-scheme`), `light`, `dark`; applied as
`html[data-theme]` before first render like the other preferences; chosen under **Display and
alerts → Theme** (the existing header control). No new store. The generated token CSS
(`packages/ui/src/tokens.ts`) now resolves: explicit light/dark beats the OS in both directions;
high contrast (device or OS) uses the light or dark high-contrast set according to that result;
`color-scheme` follows. Palette unchanged. Tests: preference parsing/attributes
(`a11yPrefs.test.ts`), CSS selector coverage (`tokens.test.ts`); Playwright: Light chosen on a
dark OS stays light after reload and on landing, join, recovery, board and sign-in; Dark chosen on
a light OS on landing, staff console and facility administration (axe clean); System follows the
OS and a live OS change; high contrast combines with both themes (white/black grounds, axe clean).
The M5.2 "stored fields" assertions now list seven fields (`theme` added) in the unit and browser
tests.

**B. Continuity story as a workflow simulation.** One persistent SVG (`StoryScene.tsx`,
`data-stage`) of the visitor's ticket page, the server/connection and the coordinator console;
stages change by 420 ms opacity/transform crossfades; the ticket pops in (stage 1), sync packets
travel console → server while reconnecting (stage 5), the committed call travels server → ticket
page before "It's your turn" (stage 6); a progress bar shows time left on the stage. Drawn
truthfully: offline console rows are dashed "Local only", the ticket page says "Not updating /
Last confirmed", other devices "capture only"; after reconnection G013 is "Synced" while G012 stays
"Needs review" through stage 6; "Called"/"It's your turn" only in stage 6 with the server online.
Pause stops everything that repeats (packets, stage clock); one-shot entrances under a second
finish so a stage chosen by hand is fully drawn. Reduced motion: the six static cards each show
the same drawing at its stage, no motion. All labels are localized (`story.sim.*`). New
Playwright test checks the visible labels at every stage (including the two negative claims) and
that nothing looping runs while paused.

**C. Responsive refinements (`landing.css`).** Hero title `clamp(1.75rem, 3vw + 1rem, 3rem)`
(28 px at 320, 48 px at 1440; was up to 56 px), hero lead 17/18 px with 1.6 line height, smaller
logo on phones, actions stacked full width under 40rem; section headings
`clamp(1.375rem … 1.875rem)` weight 700 with a short teal rule above (landing cue, not admin);
section gap 32 px on phones, 64 px from 48rem; cards with a teal top edge, muted body text,
16/24 px padding; story list lighter weight and captions full width under 24rem. No content
removed. Screenshots reviewed at 375 and 1280 px and for every simulation stage.

**Bundle budgets re-derived (recorded in `apps/web/bundle-baseline.json` history):** entry CSS
6,919 → 7,001 B gzip (+82 B, theme selectors app-wide) and landing CSS 2,257 → 3,044 B (+787 B,
simulation). Entry JS 195,405 B and landing JS 24,723 B stay inside the earlier limits.

**Verification (local):** `pnpm test` all pass (web 208, ui 18); Playwright full suite 342
passed, 7 skipped (existing environment skips), 0 failed, including `landing.spec.ts` 24 (theme,
simulation, stages, Pause/Resume, reduced motion, axe and overflow at 320/375/768/1280/1440 in
light, dark, both high-contrast sets and 150 % text), `design-system.spec.ts`,
`accessibility*.spec.ts`; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
`bundle:check` pass. 200 % browser zoom is covered by the 640-px-equivalent widths (320–768 px
runs) rather than a zoom emulation; a manual 200 % pass remains for final acceptance.

Ask Que (MQ.6): `visitor.accessibility` v2 names the new **Theme** setting; lock regenerated
(kbVersion 8 on this branch), `kb-base-check` against `staging` passes, assist 262, web Que 51
and API KB 42 tests pass.

### M7.2 header interaction defect and floating Ask Que (2026-11-21)

**Observed (manual acceptance):** "Display and alerts" and "Ask Que" appeared to do nothing.

**Reproduction.** Production preview (`vite build && vite preview`, production CSP), Chromium,
WebKit and an iPhone profile, light and dark: both open correctly (dialog `open`, on top, focus
inside). Firefox could not be launched on this machine (Playwright profile error), so it is
untested. Development server (`vite`, React development build): both fail in Chromium and WebKit
with no console error. Instrumenting `HTMLDialogElement` showed, per click:
`showModal()` → `close()` → `showModal()` → `close` event → `close()` → dialog removed.

**Root cause.** `SettingsDialog` (M5.2) and `QuePanel` (MQ.3) open their `<dialog>` in an effect
whose cleanup calls `dialog.close()`, and wire the dialog's `close` event to `onClose`, which
unmounts it. React StrictMode (enabled in `main.tsx`) runs effect setup → cleanup → setup again
in development. The cleanup's `close()` queues a `close` event; it is dispatched after the
second `showModal()`/`show()`, so `onClose` removed the dialog that had just reopened. Production
builds run effects once, which is why the preview-based suite (and every earlier test) never saw
it. Not caused by the CSP, the theme work, z-index or lazy chunks (pointer target checks: the
buttons received the clicks).

**Fix.** Both dialogs ignore a `close` event while the dialog is open again
(`if (!e.currentTarget.open) onClose()`); a real close (Escape, Close, Done, navigation) still
closes exactly once and returns focus. No other behaviour changed.

**Ask Que launcher.** Removed from the header (`Layout.tsx`) and rendered after `<main>` as a
fixed launcher (`.que-launcher`): bottom right with `env(safe-area-inset-*)` margins (at least
16 px), 48 px high pill, primary blue with a teal ring (navy while open), help icon plus the
visible name "Ask Que" (`aria-expanded`, `aria-haspopup`), visible focus ring, hidden in print,
plain border in high contrast. The desktop panel opens directly above it, right-aligned, and the
launcher stays uncovered and toggles it; phones keep the full-screen modal sheet. The chunk
"loading" and "could not be opened" messages also sit above it. `.main` has extra bottom
padding and `scroll-padding-bottom` is 8rem so the last controls and the focused control are
never under the launcher; on phones the toast sits above it. Same component, permissions, lazy
chunk, offline warm-up and AI behaviour.

**Regression tests (`e2e/header-controls.spec.ts`).** The `@dev` checks also run in a new
`dev-strict` Playwright project against the development server (`playwright.config.ts` starts
`vite` on WEB_PORT + 100), where the defect reproduced. With the fix reverted: the 4 `dev-strict`
tests fail and the 6 preview tests pass (the original blind spot); with the fix: 25/25 pass
across desktop, 1440, 320, 375 and dev-strict. They check the element under the pointer is the
control (no overlay intercepts), the dialog is still open after the event loop turns and is on
top, focus enters and returns, Escape/Close/Done, theme/text size/contrast apply and persist
after reload, axe, no page overflow, the launcher's fixed bottom-right position and size, panel
placement above it, three open/close rounds, use on ticket, recovery, board, staff console and
facility admin screens with their last control clear of the launcher, and recovery after an
aborted help chunk. Light and dark both.

**Adapted:** `ui-layout.spec.ts` header checks count six/four header items and expect the
keyboard order without "Ask Que" (it moved out of the header).

**Bundle:** entry CSS 7,001 → 7,221 B gzip (+220 B, launcher and clearance rules), recorded in
`bundle-baseline.json` history; entry JS 195,475 B, landing JS 24,726 B within limits.

**Verification (local):** format, lint, typecheck, build, `bundle:check` pass; `pnpm test` pass
(web 208, ui 18); Playwright full suite **367 passed, 7 skipped** (existing environment skips),
0 failed, including the new `dev-strict` project.

**Remaining risks:** Firefox not exercised locally; the launcher can still cover content a
person scrolls underneath mid-page (only the end of each page is guaranteed clear); real-device
safe-area behaviour on iOS is part of the final device checklist.

### M7.3-A local baseline — 22 November 2026

At `5d2e5ea`, six PostgreSQL suites passed all 99 cases in 12.61 s on a disposable PostgreSQL 16.15 server. The 1,000-operation commit and full duplicate replay passed in 8.440 s. Channel package tests passed all 66 with local fixture sockets available. Registry-backed audits found zero high or critical advisories. The full tree had one low and three moderate findings. Production had no known vulnerabilities. The policy gate passed.

The fresh web build passed its four existing ceilings. Shared JS/CSS measured 195,504/7,221 gzip bytes and landing JS/CSS measured 24,725/3,044. The visitor initial-JS target remains open. [M7.3-A commands, endpoint inventory, limitations and findings](../reports/M7.3-A-baseline-security-evidence.md).

### M7.3-B2 local implementation evidence

On the uncommitted candidate based on 5d2e5ea, cold join and ticket startup each fell from 195,644 to 159,633 gzip bytes. A further 59,634 B reduction is required. Fresh join installation fetched zero landing JS/CSS assets. Controlled warm join used zero transfer bytes for entry JS and registration, and visited join and landing reopened offline. A B1-to-candidate worker update activated successfully. [Route measurements, regression outcomes and remaining limitations](../reports/M7.3-B2-implementation-evidence.md).

**B2 verification closure.** The final full local Playwright run completed in 8.6 minutes with 368 passes, zero failures, seven skips and zero timeouts. The original offline refusal assertions passed. A high-contrast palette transition detected by axe in the preceding run was corrected. Repository-wide formatting, lint, typecheck, build and existing bundle gates passed. Final join/ticket startup assets total 159,635 gzip bytes, 59,636 B above the permitted maximum. The B2 report records the failure trace, skip breakdown and dependency proposals.

### M7.3-B3 local visitor startup evidence

The shared entry measured 137,417 gzip bytes. Cold join measured 142,331 B and cold ticket 149,240 B, saving 17,304 and 10,395 B respectively against B2. The remaining reductions to reach 99,999 B are 42,332 and 49,241 B. A worker-enabled browser generated the recovery QR offline and reopened the saved ticket after reload. The full local Chromium matrix passed 369 cases with seven skips and zero failures. Unit and database suites passed 1,143 and 874 cases. [B3 measurements, changes and remaining dependency analysis](../reports/M7.3-B3-implementation-evidence.md).

### M7.3-B4 local staff schema experiment

Removing unused construction of the facility-readiness response validator saved 102 gzip bytes in the shared entry. Cold join, ticket and recovery measured 142,224, 149,131 and 141,111 gzip bytes. All three exceed the strict target. The full local suites passed 1,143 unit cases, 874 database cases and 369 Playwright cases with seven browser skips. [Experiment, matched measurements and architectural options](../reports/M7.3-B4-schema-isolation-evidence.md).

### M7.3-C browser and accessibility verification

All 12 smoke cases passed across six local engine/viewport cells. Native macOS regression recorded 377 passes, four Firefox launcher failures and seven skips. Both Firefox 159 projects then passed in the matching Linux browser container. Chromium at actual 200% tab zoom reflowed landing, sign-up and recovery without horizontal overflow. Physical-device acceptance and a recorded human screen-reader pass remain outstanding. [Matrix, commands and human checklist](../reports/M7.3-C-browser-accessibility-evidence.md).

### M7.3-D local integration verification

The candidate passed 1,143 unit tests, 874 PostgreSQL tests and six focused Chromium journeys. Registry audits found zero high/critical findings. An unfiltered Lighthouse join reproduced the load-timeout warning in 52.33 s; a browser-only stream-filter diagnostic completed in 5.82 s without the warning. Both observed LCP near 2.3 s. Keep M7.3 open for the strict visitor budget, public ingress and rate-limit evidence, physical-device and screen-reader acceptance, and hosted CI. [Final hardening evidence and RumptyCloud prerequisites](../reports/M7.3-D-final-hardening-evidence.md).

### Targeted landing and Ask Que corrections

Local Chromium verification measured 8 CSS px between the scrollable content and Ask Que on landing, join, staff and administration at 320, 375, 768, 1280 and 1440 px. Native 200% zoom was checked on landing, sign-up and recovery. The SVG label bounds regression passed. Four focused browser specifications completed with 119 passed, 4 existing capture-only skips and 0 failures in 3.0 minutes. Lint, typecheck, build and formatting passed. Physical-device safe areas remain a manual check. [Changes, paired screenshots and execution details](../reports/M7-landing-ui-acceptance-review.md#owner-approved-corrections)

### M7.3 pre-commit regression corrections

The facility Print button previously called the browser before asynchronous QR generation finished. It now requires a matrix. The join link stays readable, failures show the existing QR error, and a successful matrix enables keyboard printing and SVG download.

The overflow helper previously returned as soon as the document fit. It now compares actual scroll width with client width on both the document and the shell. A deliberately oversized child produced a 1,380 px shell scroll width inside 1,280 available px while the document still fit.

A controlled Chromium abort of the recovery module on the original production build reproduced the continuity risk. The address was scrubbed, the root had no text and refreshing yielded an empty key field. The visitor route now catches module-load failure, focuses an explanatory heading and offers an in-tab retry with a fresh lazy loader. Chromium recovered the synthetic key on keyboard retry with the address still clean. Refresh clears the transient handoff and requires the original link or manual entry. A permanently unavailable asset still requires a working copy to become available. The three visitor routes share this loader. Failure injection specifically exercised recovery in Chromium.

Files changed in this correction were `apps/web/src/pages/FacilityOverview.tsx`, `apps/web/e2e/helpers.ts`, `apps/web/src/App.tsx`, new `apps/web/e2e/precommit-regressions.spec.ts` and this evidence file.

Local verification used a disposable PostgreSQL database, E2E_WEB_PORT=4192 and one stable preview per Playwright run. Execute the following from the repository root with TEST_DATABASE_URL set to a disposable database.

| Command                                                                                                                                                                                      | Result                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @queuebridge/web test:e2e precommit-regressions.spec.ts`                                                                                                                      | 4 passed in 10.9 s. Delayed, successful and failed QR encoding, shell overflow and in-tab recovery retry.                                                                  |
| `pnpm --filter @queuebridge/web test:e2e landing.spec.ts ui-layout.spec.ts header-controls.spec.ts accessibility-m52.spec.ts precache.spec.ts recovery.spec.ts recovery-url-secrecy.spec.ts` | 140 passed, 4 existing capture-only skips, 0 failed in 3.9 min. Includes offline ticket restoration, staff-assisted recovery, URL secrecy, reflow and StrictMode controls. |
| `pnpm --filter @queuebridge/web test:e2e turn-alerts.spec.ts --project=desktop-chromium -g 'contradicting k\|ticket this device forgot'`                                                     | 2 passed in 13.8 s. Contradictory and missing ticket references retained their original precedence.                                                                        |

Repository lint, typecheck, formatting, build and the web bundle gate passed. The measured shared entry alone was 137,511 gzip bytes. The strict visitor initial-JavaScript requirement remains open. These runs provide local Chromium evidence.
