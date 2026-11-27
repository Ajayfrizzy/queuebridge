# ADR-002: React + TypeScript Mobile-First PWA

**Date:** 2026-10-30  
**Status:** Accepted

## Context

QueueBridge needs a frontend that:

- Works on Android devices with constrained connections (target users in clinic/government settings)
- Operates offline for the Continuity Engine (F1)
- Supports multiple views: visitor (public), staff console, supervisor dashboard, public display board
- Does not require native app installation

## Decision

**React 19 + TypeScript + Vite** as a **Progressive Web App**.

- Vite for fast development builds and PWA plugin (`vite-plugin-pwa`)
- Service worker for offline shell caching and background sync setup
- React Router for SPA routing across visitor/staff/supervisor/board views
- `react-i18next` for localization framework

## Consequences

**Positive:**

- No app store required — visitors scan a QR code and get the app
- Service worker enables offline caching and controlled sync
- Vite builds are fast and produce optimized bundles
- TypeScript strict mode shared with backend via `packages/contracts`

**Negative:**

- PWA capabilities vary by browser — iOS Safari has limited service worker support
- Offline behavior requires careful coordination with the Continuity Engine (packages/continuity)
- Bundle size must be managed for low-bandwidth scenarios (target: < 100KB initial JS for visitor flow)

## Accessibility commitment

React does not provide accessibility automatically — we must implement it explicitly per F7 requirements (WCAG 2.2 AA target for critical visitor flows).
