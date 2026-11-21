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
