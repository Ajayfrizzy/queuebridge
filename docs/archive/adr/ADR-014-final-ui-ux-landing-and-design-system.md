# ADR-014: Final UI/UX — Design System, Branding and a Code-Split Public Landing Page

**Date:** 2026-11-12  
**Status:** Accepted for specification (implementation is milestone M7, task group M7.1)  
**Feature:** F15 — Final UI/UX, Branding and Public Landing  
**Builds on:** ADR-002 (React PWA), F7 accessibility requirements

## Context

M1–M6 deliver working screens built for correctness, with a minimal shared style. M7 must present
QueueBridge as a coherent product: consistent branding, a responsive redesign, and a public landing
page that explains the product and lets an organization start onboarding. Constraints:

- REQ-F7.7: visitor flows target under 100 KB of initial JavaScript. A marketing page with animation
  must not make a visitor's join or ticket screen heavier.
- Accessibility (F7, WCAG 2.2 AA target): motion must respect `prefers-reduced-motion`; no flashing;
  animations that run longer than five seconds need a pause control.
- Privacy and cost: no third-party scripts, analytics, fonts or trackers; no paid assets
  (PRD §2). PRD §16 lists brand assets as a pending decision.
- Truthfulness: the landing page must not claim conflict-free operation, guaranteed delivery, live
  SMS/USSD without a live provider, or invented metrics, logos or testimonials (AGENTS §9).

## Decision

1. **Design tokens in `packages/ui`.** One token set (colour, type scale, spacing, radii, elevation,
   motion durations) with light, high-contrast and large-text variants, consumed by every role's
   screens. Components keep their existing accessible semantics; the redesign changes presentation,
   not behaviour.
2. **Original, self-hosted brand assets.** Wordmark, logo, favicon and PWA icons are created for the
   project as SVG/PNG (no stock or paid assets). Fonts are the system stack or self-hosted
   open-licence files served from the app origin.
3. **Landing page as a separately loaded route chunk at `/`.** It is lazy-loaded so visitor and
   staff routes never download it, and bundle-size budgets for the visitor flows are enforced in CI.
4. **Animation is CSS/SVG, progressive and optional.** A short illustrated "queue continuity" story
   (join, wait through an outage, reconnect, called) uses transforms and opacity only. With reduced
   motion it renders as a static, equivalent illustration. Anything that loops can be paused.
5. **Honest content.** Capability statuses on the page (for example SMS and USSD sandbox versus live)
   are read from the capability manifest where available, so the page cannot overstate what is live.
   Offline behaviour is described as safe reconciliation with visible review, never "conflict-free".
6. **Onboarding from the landing page** is a clear path into the existing F10 flow (sign up, create
   facility, service, counter, invite staff, share QR, serve the first visitor), shown as a checklist
   with the facility readiness states already implemented. No new backend is required.
7. **Cross-browser verification is part of the milestone.** Automated Playwright runs add Firefox and
   WebKit engines to the existing Chromium and responsive projects, plus a documented real-device
   checklist (Android Chrome, iOS Safari including installed-app push caveats). Results are recorded
   as measured, with known gaps listed.

## Consequences

**Positive**

- Visitors keep the lightweight flows; marketing weight is isolated.
- One token set makes redesign and high-contrast/large-text modes consistent and testable.
- No external requests from the landing page, so no privacy or availability dependency.

**Negative / risks**

- A redesign touches every screen, so existing Playwright and axe suites are the safety net and must
  keep passing without weakened assertions.
- WebKit and Firefox in CI add runtime and may expose existing cross-engine differences to fix.
- Performance budgets must come from measured baselines (architecture §15.7), not guesses.

## Alternatives considered

- **Separate marketing site:** rejected for the hackathon; a second deployable adds cost and drift.
- **Animation libraries (Lottie, GSAP):** rejected; weight and licensing for a small illustration.
- **Third-party fonts/analytics:** rejected; privacy, performance and availability.

## Verification (see testing steering, Group 15)

Landing content truthfulness against the manifest, reduced-motion and pause behaviour, axe and
keyboard paths at 320/375/768/1280/1440 px, bundle budgets, no third-party requests, security
headers, and cross-browser smoke journeys.
