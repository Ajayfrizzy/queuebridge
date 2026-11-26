# QueueBridge — Codex Transition and M7.3 Operating Brief

**Status:** Working handover for the M7.3–M7.6 implementation phase  
**Repository:** `Ajayfrizzy/queuebridge`  
**Baseline:** `staging` merge `5d2e5ea578fd380ebf9c9d72652a6f8e0b73d790` (M7.2 PR #22)  
**Initial work branch:** `feature/m7-3-hardening`  
**Primary existing agent instructions:** repository-root `AGENTS.md`  
**Purpose:** Prevent scope drift during transition from Kiro to Codex. This document supplements, but does not supersede, existing product and engineering decisions.

## 1. Source-of-truth hierarchy

Read `AGENTS.md`, the current repository's `.kiro/steering/`, `.kiro/specs/queuebridge/{requirements,design,tasks}.md`, relevant `docs/adr/`, `docs/QueueBridge_PRD_v1.0.md`, `docs/QueueBridge_Technical_Architecture_v1.0.md`, `docs/design/QUEUEBRIDGE-DESIGN-SYSTEM.md`, `docs/testing/M7-evidence.md`, and specific milestone evidence before planning or changing code.

Use **current Git history and tasks/evidence** for milestone status when `AGENTS.md` contains older status prose; do not silently rewrite settled architecture because historical documentation is stale. If source documents conflict on a substantive design or safety requirement, identify the conflict and request product-owner approval before implementing a departure.

## 2. Implemented baseline and demonstrated testing

M0–M6, Ask Que MQ, M7.1 (PR #21) and M7.2 (PR #22) have been merged to `staging`. M7.2 delivered the lazy-loaded public landing page, six-stage continuity demonstration, channel truthfulness, onboarding, i18next English baseline, security-header preview configuration, light/dark/system preference, responsive refinements, and the bottom-right floating Ask Que control.

A development-only React StrictMode dialog lifecycle defect was corrected in M7.2: effects opening native dialogs and cleaning up with `.close()` caused stale `close` events; the controls now ignore a `close` event while the dialog has reopened. Development-server regression coverage (`dev-strict`) must be retained.

Latest reported **local** M7.2 results: 367 passing Playwright journeys, 7 environment-dependent skips; unit tests, format, lint, typecheck, build and bundle gate passed. These are reported results, not a new verification by Codex. GitHub Actions was restricted by account limits; do not call remote CI green without checking.

Two intermittent DB test problems were previously corrected by better fixtures and request-scoped assertions, not by production changes. Preserve their regression coverage.

## 3. Immutable product and system constraints

- Preserve the existing React/Vite PWA, Fastify API, PostgreSQL, background worker, shared contracts, domain state machine, offline coordinator and reconciliation architecture.
- **One authorized offline coordinator per queue** can record permitted local advancement. Other devices cannot claim globally confirmed advancement. On reconnection, conflicting actions require explicit authorized review.
- Preserve idempotency, queue event audit integrity, fair ordering, auth/tenant isolation, ticket recovery, push and SMS/USSD channel gates.
- SMS turn alerts and USSD are **sandbox** unless a verified runtime capability manifest demonstrates approved live provider enablement. Never advertise a sandbox adapter as live.
- Visitor tickets and recovery credentials remain private; the public ticket code is not a credential.
- Maintain the approved navy/blue/teal design system, shared tokens, theme/accessibility preferences, existing logo/favicon/PWA assets and truthful landing copy.
- No unapproved architecture changes or commercial dependencies. **Zero personal out-of-pocket spending.** RumptyCloud credits are available; verify actual supported services before choosing a deployment topology.
- No hidden fallbacks, fabricated results or weakening assertions to clear checks.

## 4. Git and review protocol

- Work on a dedicated feature branch from freshly synced `staging`; M7.3 branch suggested: `feature/m7-3-hardening`.
- First task is a **read-only M7.3 audit**. Do not edit files, run destructive commands, commit, push, open a PR, merge or deploy during audit.
- For subsequent implementation, propose milestone slices and evidence before changes; seek explicit approval for substantive architecture/security/product change.
- Keep tests and documentary evidence alongside a justified implementation change. Report tests run and unrun, failures, environmental limitations and affected files accurately.
- User handles Git publication and pull request process unless specifically authorized otherwise.

## 5. Approved remaining milestones

**M7.3 — Hardening and independent verification** (`tasks.md` M7.3):

- Dependency audit, zero high/critical findings or document blockers (do not silently waive).
- Load/stress testing: 1,000+ scripted operations, with authoritative idempotent reconciliation evidence.
- Rate limits on all public endpoints and adversarial webhook signature verification.
- Measured Lighthouse and route bundle baselines, including no landing-page regression to visitor-flow initial payload. Ground budgets in measured values and enforce via appropriate CI paths where possible.
- Firefox and WebKit smoke journeys at mobile and desktop sizes, preserving Chromium coverage.
- Manual Android Chrome and iOS Safari (including installed PWA/push where available), with versions and evidence; unavailable hardware is **not tested**, never pass.
- Axe, keyboard and recorded manual screen-reader review; no unsupported full WCAG-conformance claims.

**Deployment checkpoint after M7.3:** Validate RumptyCloud's supported web/API/worker services, PostgreSQL availability, environment/secret handling, HTTPS/TLS, domains, health checks, logging and migration process before selecting or applying deployment configuration. Production CSP/HSTS/referrer/permissions headers are verified on the deployed host, not assumed from Vite preview. Deployment is a distinct approved step, not permission to change the architecture.

**M7.4:** Reproducible demo seed and six representative end-to-end scenarios A–F, with deterministic outage/reconnect and turn alert.

**M7.5:** README/diagrams/screenshots, evidence, feature traceability, truthful Kiro contribution documentation and public demo video within three minutes.

**M7.6:** M5 manual acceptance Set 2 checks 15–41, device and accessibility evidence, final critical-finding closure and submission readiness.

## 6. Known open risks at handover

- Firefox browser could not run in the prior development environment; investigate installation/browser dependencies rather than marking verified.
- iOS safe-area behavior and installed-app push need compatible physical-device evidence.
- Floating Ask Que can cover mid-scroll content, although page-end clearance was tested; assess obstruction in M7.3 accessibility review.
- A manual 200% zoom pass and screen-reader walkthrough remain outstanding.
- Service-worker precaching may download the lazy landing bundle in the background; measure the behavior, distinguishing route-initial payload from install/precache bandwidth.
- New security-header source is tested under local preview; real RumptyCloud response headers and TLS remain unverified.
- GitHub Actions account restrictions prevent assuming remote CI verification.

## 7. Read-only M7.3 audit deliverable

Output `docs/reports/M7.3-audit-and-execution-plan.md` **as a proposed file or response**, not written to the repository before approval. The audit should include:

1. Git branch/HEAD and clean-tree observation.
2. Requirement-to-evidence matrix for every M7.3 task, with file paths and verified/not-verified labels.
3. Existing test commands and browser project configuration, including dev-server and production-preview differences.
4. Current security controls and a public-endpoint inventory, grounded in routes and tests.
5. Existing bundle measurements and Lighthouse readiness; identify unknowns rather than inventing metrics.
6. Load test plan for 1,000+ operations, safe fixtures and non-production isolation.
7. Cross-browser and accessible/manual test matrix; distinguish what can run in the environment from real-device checks.
8. CI account-limit mitigation options that preserve standard security gates.
9. A sequenced M7.3 implementation plan with measurable acceptance criteria, blocked dependencies, risks and any decisions requiring approval.
10. Explicit **NO CODE CHANGES MADE** statement.

Do not treat an audit as an implementation pass.
