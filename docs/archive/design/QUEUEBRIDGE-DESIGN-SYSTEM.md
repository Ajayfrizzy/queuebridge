# QueueBridge — Visual Design System Specification

**Status:** APPROVED — M7.1 design baseline  
**Document type:** Internal implementation specification, not final/submission documentation  
**Repository location:** `docs/design/QUEUEBRIDGE-DESIGN-SYSTEM.md`  
**Governing specifications:** `.kiro/specs/queuebridge/requirements.md`, `design.md` §14, `tasks.md` M7.1, ADR-014; MQ.5 U1–U5 and MQ.6 consistency rules.

## 1. Approved design direction

QueueBridge should have a polished contemporary SaaS appearance while remaining practical for public services, visitors, reception and counter staff, supervisors, administrators, auditors and operators of public display boards. The identity must communicate **trust, clarity, reliability, continuity and accessibility**.

**Decisions already approved by the product owner:**

- Palette: **navy + blue + teal**, with restrained neutrals and independent semantic status colors.
- Logo: **original connected bridge symbol incorporating a subtle queue-ticket/pathway motif**.
- Themes: **light, dark and high contrast**, compatible with large text and reduced motion.
- Typography: **Inter**, locally hosted under a checked open license; system fallback, no decorative secondary font.
- Components: softly rounded, subtle borders/shadows, large enough touch targets, clear status and focus.
- Layouts: role-specific but visually unified; spacious visitor/overview interfaces and efficient, relatively compact operational screens.
- Motion: restrained feedback animation; M7.2 (not M7.1) owns expressive public landing-page animation.

M7.1 is **not permission to change** routes, authorization, queue semantics, offline rules, API contracts, database behavior, provider activation, or the approved architecture. The previously specified MQ.5 UI findings U1–U5 are included in M7.1.

## 2. Color palette and semantic tokens

| Role            | Anchor    | Intended use                                                |
| --------------- | --------- | ----------------------------------------------------------- |
| Brand navy      | `#102A43` | Wordmark/mark, identity, navigation, display-board backdrop |
| Primary blue    | `#2563EB` | Main actions, links and active selection                    |
| Supporting teal | `#0D9488` | Connection/continuity accent, supporting highlights         |
| Light canvas    | `#F8FAFC` | Light-theme app background                                  |
| Primary ink     | `#172033` | Readable text in light theme                                |
| Success         | `#15803D` | Confirmed positive operation                                |
| Warning         | `#B45309` | Attention and review required                               |
| Danger          | `#B91C1C` | Failure, missed state, destructive action                   |
| Information     | `#0369A1` | Informational states                                        |

These are **anchor colors**, not guaranteed safe foreground/background pairs. Kiro must verify actual contrast and derive appropriate `on-*`, hover, active, disabled and subtle variants. Preserve status meaning: a blue/teal brand accent must never make a warning, error or unverified operation look successful.

### Token architecture

Maintain a **typed source of tokens in `packages/ui`**, with CSS custom properties for all application screens. Use semantic names, for example:

- `--qb-color-bg`, `--qb-color-surface`, `--qb-color-surface-raised`, `--qb-color-surface-muted`
- `--qb-color-text`, `--qb-color-text-muted`, `--qb-color-border`, `--qb-color-divider`
- `--qb-color-brand-navy`, `--qb-color-primary`, `--qb-color-primary-hover`, `--qb-color-on-primary`, `--qb-color-accent`
- `--qb-color-success`, `--qb-color-warning`, `--qb-color-danger`, `--qb-color-info`, and suitable text/background variants
- `--qb-color-focus`, `--qb-space-*`, `--qb-radius-*`, `--qb-shadow-*`, `--qb-duration-*`, `--qb-font-*`

Do not repeat hard-coded colors in individual page components. Keep the token source authoritative and test generated CSS consistency.

### Themes

- **Light:** off-white canvas, white/light surfaces, navy/ink text, blue primary button, restrained teal accents.
- **Dark:** deep navy/charcoal backgrounds, layered surfaces, light text, calibrated blue and teal, distinct borders without excessive glow.
- **High contrast:** deliberate high-contrast role pairs, strong borders and focus rings, readable text, no essential shadow-only differences; honor forced-color browser mode.
- Existing accessibility preferences (including larger text) must combine correctly with all three modes. Follow system preferences appropriately. Avoid flashes of incorrect theme and avoid creating redundant settings stores.
- WCAG 2.2 AA targets: **4.5:1** for normal text, **3:1** for large text and key UI indicators/components; measure in rendered components, not by visual judgment.

## 3. Typography

**Primary UI family:** Inter, self-hosted (open-license validation required), with `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` fallback. No third-party font requests or paid fonts.

| Element               |                   Desktop |            Mobile |
| --------------------- | ------------------------: | ----------------: |
| Page title            |                      30px |              26px |
| Section heading       |                      22px |              20px |
| Card heading          |                      18px |              18px |
| Body                  |                      16px |              16px |
| Labels/metadata       |                      14px |              14px |
| Ticket identifier     |                   48–72px |           40–56px |
| Public display ticket | 96px+ where space permits | Fluid to viewport |

Use sensible line heights (~1.4–1.6 for body copy), scalable sizes and proper semantic heading order. Queue numbers, ticket codes, wait ranges and counters must use **tabular numerals**, ensuring stable alignment. Support user large-text setting, browser zoom and 320px screens without clipping or forced horizontal scrolling. Avoid tiny explanatory text.

## 4. Original logo and asset locations — mandatory

Approved concept: a simple geometric **connected bridge** with a subtle **ticket edge / queue path**. Communicate movement and continuity rather than a government crest or people standing in line. Distinctive enough as a small app icon. Do not trace or reuse another company's logo. Use original SVG designs; build compatible raster icons from the approved symbol.

### Application assets — logo stays here

```text
apps/web/src/assets/brand/
  queuebridge-logo.svg          # primary mark plus wordmark
  queuebridge-mark.svg          # compact icon-only brand mark
  queuebridge-logo-light.svg    # logo variant on dark surfaces
  queuebridge-logo-mono.svg     # monochrome/high-contrast variant
```

### Public assets — favicon stays here

```text
apps/web/public/
  favicon.svg
  favicon.ico                   # compatibility fallback where needed
  apple-touch-icon.png         # where appropriate
  icons/
    icon-192.png
    icon-512.png
    icon-maskable-512.png
```

The repo currently has `apps/web/index.html` pointing to `/favicon.ico`, but the public directory initially contains only `push-handler.js`. During M7.1, create real brand and favicon assets and update `index.html` and the **existing** PWA/manifest wiring. Do **not** create competing manifests. Verify every referenced file resolves in the built app, including nested routes. Keep icon shapes clear at 16px, 32px and app-icon sizes. Document icon clearspace and monochrome rules. Do not claim trademark registration.

The product owner approved the **logo direction**, not a specific final drawing: Kiro should create an original candidate within this direction and present a preview for visual acceptance if the exact design is materially different. It may not change the brand concept without approval.

## 5. Shared components

Use the token system and shared components in `packages/ui` rather than independently inventing page styles. Preserve existing accessible component APIs where possible.

| Component           | Approved styling/behavior                                                         |
| ------------------- | --------------------------------------------------------------------------------- |
| Primary button      | Blue, strong on-color contrast, prominent and descriptive                         |
| Secondary button    | Border or subtle fill; clearly subordinate                                        |
| Tertiary button     | Minimal treatment but visible focus and hover                                     |
| Destructive button  | Danger semantic treatment and safeguards                                          |
| Touch targets       | At least 44 × 44px for core visitor/operational controls                          |
| Cards               | Radius 12–16px, gentle border, restrained shadow                                  |
| Inputs/selects      | Usually 44–48px high, persistent labels, hints/errors                             |
| Dialogs             | Appropriate keyboard behavior, focus management/return, visible purpose           |
| Tables              | Compact desktop rows; accessible horizontal region or mobile cards                |
| Badges/status pills | Icon + explicit text + semantic color; never color alone                          |
| Alerts              | Persistent for action-required states; accessible live regions, no focus stealing |
| Loading/empty/error | Honest state, no fabricated numbers or misleading success                         |
| Navigation          | Explicit active location, understandable icon/text labels                         |
| Sync status         | Visible offline, pending, syncing, confirmed, conflict/review and failure         |
| Ticket cards        | Prominent identifier, current status, next step and relevant actions              |

Use a 4px spacing base and tokenized radius scale (suggested 6/10/12/16px). Avoid glassmorphism, heavy drop shadows, constantly looping effects, tiny controls and icon-only high-stakes actions. Distinguish **called**, **waiting**, **missed**, **needs review**, **synced** and **local-only** exactly as the application semantics require.

## 6. Role-specific layouts

### Administration and supervision — dashboard shell

- Desktop collapsible **navy sidebar**, top bar for facility context, connectivity and account; spacious content area.
- Dashboards use legible metric cards with adequate whitespace; dense lists and tables remain efficient.
- Facilities, services, counters, staff, channels, fairness, audit and connectivity appear according to actual role permissions.
- On mobile/tablet, navigation compresses without hiding critical operations or bypassing access checks.

### Visitor — mobile-first interface

- Minimal chrome, prominent ticket code/status, facility/service, position and honest wait range.
- Recovery, accessibility and alert controls discoverable without dominating the main ticket view.
- Persistent called-state banner and accessible announcements; no guaranteed push/SMS delivery claims.
- Joining, recovery and ticket view usable at 320px and with zoom/assistive technology.

### Reception and counter staff — task-first workspace

- Place **now serving**, **call next** and essential workflow controls first.
- Clear access to assisted registration, routing, recovery and review when authorized.
- Maintain obvious separation of irreversible actions from routine actions.
- Persistent connectivity/synchronization state; never present locally queued actions as committed.

### Public display board — distance-readable

- High-contrast fullscreen design, very large ticket identifiers and counter destinations.
- Minimal distractions; adapt to landscape signage and smaller layouts.
- Preserve opt-in speech behavior and never expose visitor secrets.

### Ask Que — integrated help

- Desktop contextual help panel; mobile accessible fullscreen help view.
- Same colors, cards, typography, buttons, focus treatments and status semantics as the rest of QueueBridge.
- Preserve Ask Que role permissions, route registry, capability truthfulness and article consistency.

## 7. Responsive layout

| Width       | Guideline                                              |
| ----------- | ------------------------------------------------------ |
| Below 640px | Single column; compact nav; stacked forms              |
| 640–1023px  | Flexible tablet layout; two-column cards when feasible |
| 1024–1439px | Desktop sidebar, multi-column dashboard                |
| 1440px+     | Wider dashboards with bounded reading/form widths      |

These are **implementation breakpoints**, not fixed device assumptions. Verify no horizontal **page** overflow and usable controls at **320, 375, 768, 1280 and 1440px**. Any horizontally scrollable table must remain keyboard accessible and signposted. Consider browser zoom, large-text mode, orientation and safe areas.

## 8. Motion, usability and accessibility

- Short feedback: roughly **120–180ms** for press/hover, **180–240ms** for menus/dialogs; design tokens control timing.
- Favor opacity and transforms; avoid layout thrash, scroll-jacking, parallax, flashing or autoplay audio.
- Honor `prefers-reduced-motion` and existing accessibility settings; animation never holds unique information.
- Operational interfaces are calm. Save expressive landing-page transitions for **M7.2** and follow its pause/static requirements.
- Maintain keyboard access, focus indicator, field errors, accessible names and descriptive status messages.
- Make offline/capability/notification messages **truthful** and distinguish attempts from successful delivery.

## 9. M7.1-specific scope and exclusions

Redesign existing screens for: visitor join, ticket, recovery and alerts; reception; counter console; supervisor fairness, audit and connectivity; administration including facility and channel management; public board; Ask Que. **Do not implement the M7.2 landing page as part of M7.1**. Keep existing routes including `/` intact until M7.2.

The approved M7.1 tasks explicitly include MQ.5 UI issues; consult `docs/testing/MQ-evidence.md` for exact behavior:

1. **U1:** Grace-window hint counts from the missed time.
2. **U2:** “Call out of order” shown only to supervisors and organization admins.
3. **U3:** Transfer note states actual queue placement.
4. **U4:** Audit trail correctly labels automatic no-show actor and reason.
5. **U5:** “Put on hold” for waiting tickets, **or** a documented decision not to offer it.

Update Ask Que article text, screen registry, route names and knowledge locks with the UI change, following MQ.6. Do not weaken existing assertions or quietly change authorization/queue rules.

## 10. M7.1 acceptance checklist

- [ ] Typed tokens in `packages/ui` are used by the redesigned interfaces.
- [ ] Light/dark/high-contrast and large-text modes work; forced-color/focus/contrast are verified.
- [ ] Original logo/wordmark/source SVG files exist in `apps/web/src/assets/brand/`.
- [ ] Favicon and browser/PWA icons exist in `apps/web/public/` and resolve through existing manifest wiring.
- [ ] Inter is properly licensed and self-hosted, or the system fallback is documented; no external font requests.
- [ ] All existing role screens are visually consistent; layout density matches each role's needs.
- [ ] Status uses words/icons and reliable semantics, never color alone.
- [ ] Keyboard/axe/responsive checks pass; page overflow absent at 320/375/768/1280/1440.
- [ ] Existing Playwright/behavior assertions remain equivalent; no weakened checks.
- [ ] MQ.5 U1–U5 handled as approved and evidence updated.
- [ ] Ask Que articles, route registry and locks remain synchronized.
- [ ] No unrelated backend change, live SMS/USSD activation, spending or M7.2 landing-page implementation.

## 11. Kiro handoff and change control

**This document is the approved visual baseline.** Kiro implements it; Kiro does not independently select a different palette, logo category, typography system, component language or layout direction. The product owner must approve material deviations in advance. Contrast fixes and small adjustments within the same brand intent may be made with documented justification.

Implementation order: inspect existing UI and PWA wiring; implement tokens/themes/fonts/brand assets; refine shared components; adopt role layout shells; redesign screens; complete MQ.5 U1–U5; synchronize Ask Que; run scoped accessibility, responsive and regression tests; report changes and limitations.

Use existing free resources and properly licensed assets. Do not spend personal money, activate a real SMS/USSD provider, commit/push/merge/deploy via Kiro, or expand M7.1 into M7.2.

**Approval record:** The product owner explicitly approved the navy/blue/teal palette, connected bridge with subtle ticket logo, light/dark/high-contrast themes, Inter and tabular numerals, softly rounded accessible components, role-based page layouts, balanced spacious/compact density, responsive behavior, and restrained motion. Logo files belong in the application assets folder; favicon files belong in the public folder; this internal specification belongs under `docs/`.
