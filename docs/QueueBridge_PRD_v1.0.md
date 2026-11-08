# QueueBridge — Product Requirements Document (PRD)

**Version:** 1.0  
**Date:** 30 October 2026  
**Status:** Approved scope / requirements baseline; architecture and provider selection pending  
**Hackathon:** Kiroween 2026  
**Proposed category:** Frankenstein (verify final submission category selection)  
**Product statement:** QueueBridge is a resilient, accessible, accountable queue-coordination platform that keeps service moving through unreliable connectivity across web, staff-assisted, SMS, and USSD channels.

## 1. Executive summary

Physical queues at clinics, student service offices, government counters, and other service facilities cause avoidable uncertainty, repeated visits, crowding, unfair skips, and disruptions when internet access fails. QueueBridge provides a shared queue operating system with durable offline capture, controlled queue advancement, recoverable tickets, auditable prioritization, transparent wait estimates, accessible visitor experiences, and configurable counter routing.

QueueBridge is **not** merely a QR ticket generator or an AI chatbot. Its key product advantage is a **Continuity Engine** that preserves operational integrity through outages while supporting people who have no smartphone or stable connection. The project must show real workflows rather than simulated backend behavior.

## 2. Goals, outcomes, and non-goals

### Goals

1. Let facilities configure and operate multiple services and counters without special hardware.
2. Allow visitors to enter and track queues through accessible channels, including staff assistance and eventually live SMS/USSD.
3. Keep designated queue operations functioning offline with explicit authority and safe reconciliation.
4. Preserve fairness through published queue rules, logged overrides, and traceable decisions.
5. Provide useful routing, estimates, monitoring, and operational records.
6. Deliver a polished, secure, testable, publicly demonstrable implementation with substantial Kiro usage.

### Outcome metrics (initial targets to validate)

- 100% of committed, acknowledged queue events durably retained in outage/recovery test runs.
- 0 duplicate final ticket IDs or double-advancement events in adversarial synchronization tests.
- A visitor can obtain and recover a ticket without an account.
- Staff can operate designated offline workflows and visibly identify provisional versus committed actions.
- Every priority override has an authorized actor, reason, timestamp, and immutable history entry.
- All 10 core feature groups are demonstrated end-to-end; SMS and USSD are live only if affordable provider arrangements are secured.

### Non-goals for the hackathon

- Hospital EMR/EHR interoperability, banking core integration, government identity registry integration, or broad enterprise connectors.
- Medical triage or clinical decisions; urgency categories are configured by authorized facility staff, not inferred by AI.
- A paid AI model or generative AI dependency for core operations.
- Dependence on purchasing kiosks, phones, SMS packages, USSD codes, subscriptions, or infrastructure with personal funds.

## 3. Target users

- **Visitor:** joins a queue, checks status, returns, receives notifications, recovers a ticket, and understands service policy.
- **Reception/registration staff:** creates tickets for walk-ins, verifies details, assists visitors, and handles exceptions.
- **Counter operator:** calls, serves, transfers, pauses, skips, and completes eligible tickets.
- **Supervisor:** authorizes and reviews exceptions, configures routing, monitors fairness and connectivity.
- **Facility administrator/owner:** provisions facilities, services, counters, staff roles, policies, operating hours, and channel configuration.
- **Auditor/read-only reviewer:** inspects queue events and integrity indicators without editing operations.

## 4. Scope and functional requirements

### F1 — Offline-first queue operations (required)

- Cache app shell and essential authorized facility data for offline use.
- Persist local queued operations in durable browser storage (e.g., IndexedDB) before acknowledging local completion.
- Maintain an authoritative event sequence for committed queue advancement.
- Use a **single authority** for offline queue advancement: designated local coordinator for a facility/queue, with a defined failover or pause policy; non-authoritative devices may capture provisional registrations but may not independently commit shared call/advance decisions.
- On reconnection, deduplicate with stable operation IDs, reconcile provisional operations, display conflicts to staff, and never silently overwrite another committed event.
- Mark statuses visibly as **Local / Pending Sync / Synced / Needs Review**.
- Do not claim globally up-to-date position or messages during disconnection.

**Acceptance:** disconnected designated coordinator can continue permitted work; repeated sync requests cause no duplicate commits; concurrent-device tests maintain event ordering; failures produce actionable recovery states.

### F2 — Inclusive registration (required)

- Visitor web and QR registration with no mandatory account.
- Staff-assisted walk-in registration and printed/written short-ticket-code fallback (no printer required).
- Accessible service choice, consent and minimal data collection; optional phone contact.
- Entry-point adapters for SMS and USSD; capability and rollout state shown by facility.
- Prevent duplicate registration according to configurable policy without excluding shared-phone households.

**Acceptance:** web and staff entry create interoperable tickets visible in the same queue; non-smartphone visitor can receive and use a ticket code.

### F3 — Queue fairness and transparency (required)

- Publish explicit ordering policy per service (default FIFO, with configured classes of priority).
- Show visitor status, joining time, visible queue rules, and understandable reasons for status changes.
- Enforce permission-gated priority overrides with reason codes and free-text explanation; do not expose private reasons on public displays.
- Handle pauses, skips, no-shows, and late arrivals consistently with configured policy.

**Acceptance:** attempts at unauthorized overrides are rejected and logged; authorized overrides are visible in audit reports with reasons and policy context.

### F4 — Ticket recovery and missed-turn handling (required)

- Recover using a scoped ticket code plus additional verification where needed to avoid disclosure.
- Persist visitor ticket state across browser refresh, device restart, and temporary connectivity loss.
- Configure grace windows, rejoin policies, and no-show outcomes; surface clear next steps.
- Prevent stolen codes from exposing personal data or performing sensitive actions.

**Acceptance:** visitors can resume tracking a legitimate ticket after losing browser state; expired/invalid recovery is handled safely.

### F5 — Adaptive service routing (required)

- Facility defines services, service eligibility, counter capabilities, queue policies, and opening status.
- Route tickets to appropriate open counters using explicit deterministic rules (service match, priority class, waiting age, counter availability).
- Transfer between counters/services while preserving original audit trail and service history.
- Support staff supervisor override with required rationale.

**Acceptance:** routing respects counter skills/availability; a transfer cannot silently duplicate a visitor or erase previous waits.

### F6 — Explainable wait-time estimates (required)

- Estimate using observed service duration, ahead-count by class/service, active compatible counters, and configured operating schedule.
- Show an interval or confidence indicator and a short explanation; state when insufficient data makes an estimate unreliable.
- Recalculate after service completion, pauses, routing changes, and reconnection.
- Never promise an exact serving time.

**Acceptance:** test fixtures show explainable changes when counters close/open or service speed changes; no false exact ETA.

### F7 — Accessibility-first visitor experience (required)

- Mobile-first low-bandwidth pages, semantic controls, keyboard navigation, readable focus states, screen reader announcements, and adjustable or large text.
- High contrast, reduced-motion support, non-color-only statuses, public display mode with visual and optional audio calling.
- Design localization framework; ship at least English and a second language if translations can be validated for accuracy, otherwise do not present machine-generated translations as verified.
- Maintain private visitor data out of public screens.

**Acceptance:** core joining, tracking, and recovery flows usable by keyboard and screen reader; tested at typical mobile widths and slow network profiles.

### F8 — Tamper-evident operational history (required)

- Append-only server event log recording facility/queue/ticket IDs, actor, action, timestamp, reason, request ID, and resulting version.
- Chain integrity digests or equivalent verifiable append-only checkpointing; explain threat model and avoid calling this tamper-proof.
- Audit all permissions, routing overrides, ticket state transitions, and sync conflicts; provide searchable, scoped read-only view and export.
- Redact sensitive visitor details from public logs and minimize retained PII.

**Acceptance:** modifying/deleting a previously finalized event in a controlled integrity test is detectable; normal staff cannot edit historical entries.

### F9 — Connectivity and recovery dashboard (required)

- Show each authorized device's last contact, approximate pending-action count, sync health, coordinator status, and failure reason where available.
- Provide retry and conflict-resolution UI for privileged staff, with safe, idempotent operations.
- Monitor server API health and client connectivity separately; distinguish unconfirmed client actions from server-confirmed state.

**Acceptance:** simulated outages appear in dashboards; recovery reconciles and updates state without falsely marking unsent actions as synced.

### F10 — Portable facility setup (required)

- Facility signup/onboarding, service types, counters, employee invitations, staff permissions, operating hours, fairness policies, grace periods, and QR/link generation.
- Multi-tenant isolation between facilities and staff organizations.
- Public self-service onboarding without physical equipment; optional public display URL with privacy safeguards.

**Acceptance:** a new facility can configure a service, create a counter, issue a QR code, invite staff, and serve the first visitor without manual database changes.

### F11 — Real SMS (required capability; live provider contingent on approved cost)

- Send ticket confirmation, nearing-turn notification, called-to-counter notice, significant delay, and missed-turn outcome with consent and opt-out controls.
- Optional inbound status and recovery commands, where supported by provider.
- Adapter interface for provider credentials, templates, delivery callbacks, sender configurations, retries, idempotency, rate limits, and billing caps.
- Record delivered/failed/unknown states; never claim delivery without provider confirmation.

**Acceptance:** full integration tests with provider sandbox; live delivery tests and production status only after a provider is selected, affordable, and supported by credits or existing resources. No fabricated delivery evidence.

### F12 — Real USSD (required capability; live provider contingent on approval/code/access)

- Stateful server-side flow for join, queue status, service discovery, and ticket recovery using a provider-neutral webhook interface.
- Session expiration, invalid input recovery, short menus, provider request validation, replay defense, and minimal data disclosure.
- Do not invent a USSD short code or promise access without an authorized network/aggregator relationship.

**Acceptance:** end-to-end sandbox session tests for menu logic; live operator sessions only when a valid provider, approval, and affordable tariff exist.

### Later phase — Enterprise integrations

- Hospital/EMR, banking, campus information systems, government platforms, payment integrations, and custom identity providers are explicitly deferred.
- Publish secure API and event/webhook contracts so integrations can be added without redesigning the core queue model.

## 5. Essential end-to-end journeys

**Journey A — Walk-in without a smartphone:** visitor approaches desk → staff selects service → issues short ticket code → visitor sees ticket on public display or asks staff for status → authorized counter calls → service completes → event is audited.

**Journey B — Smartphone visitor:** scan facility QR → choose service → join without account → receive ticket and estimated interval → temporarily leave → return, recover status → get called → service completes.

**Journey C — Connectivity outage:** operating staff sees degraded status → designated coordinator records permitted calls and completions locally → secondary staff devices capture provisional registrations (but do not independently advance) → network returns → events reconcile, duplicates are suppressed, conflicts surfaced → authoritative queue and visitor screens converge.

**Journey D — Priority exception:** supervisor selects priority reason and policy → action authorized → ordering recalculated → impacted visitor-facing status updated appropriately → reviewable audit event emitted.

**Journey E — Counter unavailable:** service counter closes → routing engine reassigns eligible waiting tickets to other compatible active counters → wait estimates recompute → transfer history preserved.

**Journey F — SMS/USSD:** basic-phone visitor follows live USSD menus or staff enrollment → ticket created centrally → SMS confirmation/status/call notices sent with observable delivery state. If live carrier access is not yet available, the app must visibly distinguish test mode from live mode.

## 6. Data and state model (conceptual)

Core entities: Organization, Facility, StaffUser, RoleAssignment, Service, Counter, QueuePolicy, QueueSession, Ticket, VisitorContact, TicketRecoveryCredential, RoutingDecision, PriorityOverride, DeviceRegistration, DeviceSyncCursor, ClientOperation, QueueEvent, AuditCheckpoint, Notification, NotificationDelivery, ProviderConfiguration, USSDSession.

Ticket states (illustrative): `waiting → called → serving → completed`; branches: `paused`, `missed`, `cancelled`, `transferred`, `needs_review`. Every permitted transition has role and state preconditions; transfers are modeled as linked state transitions/events rather than deleting history.

Every client mutation includes `operation_id`, tenant/facility scope, actor or device identity, base version, action payload, and creation time. Server transactions enforce uniqueness, authorization, state transition rules, and event sequencing.

## 7. Security, privacy, and integrity requirements

- Role-based access with server-side enforcement and tenant isolation on every protected resource.
- Secure sessions, CSRF defenses where relevant, rate limits, input validation, secret isolation, and audit-friendly error messages.
- Minimize visitor PII; phone numbers optional and stored/retained only with a defined operational purpose. Never show phone numbers on public boards.
- Recovery code protection (high-entropy or rate-limited secret), expiry, and revalidation for sensitive actions.
- Signed/verified provider callbacks where supported, webhook replay defenses, and credential rotation.
- Offline storage threat model: device loss, cached data exposure, and action replay. Require device sign-out/clear controls and limit offline-sensitive data.
- Define retention periods and export/deletion policies before production onboarding. Comply with applicable local privacy obligations.
- Audit integrity is tamper-evident, not tamper-proof against administrators controlling all storage and cryptographic keys.

## 8. Nonfunctional requirements

- **Reliability:** retry-safe, idempotent synchronization; recoverable error UI; immutable event ordering where required.
- **Performance:** responsive on modest Android devices and constrained links; explicit monitoring of response times and sync backlog.
- **Accessibility:** aim for WCAG 2.2 AA for critical visitor flows, subject to verification.
- **Observability:** health checks, structured logs, trace IDs, event failure counters, sync metrics, notification delivery metrics.
- **Scalability:** multi-facility tenant boundaries and horizontally scalable online APIs, with offline coordinator authority strictly scoped.
- **Localization:** configurable time zone, language, human-readable times, facility-local schedules.
- **Correctness:** tests for ordering, fairness, concurrency, retry, clock skew, queue-session boundaries, and offline recovery.

## 9. Recommended implementation architecture (to refine in technical design)

- **Frontend:** mobile-first React + TypeScript web/PWA, with visitor app, staff console, supervisor dashboard, and public display.
- **Service layer:** TypeScript API with explicit policy/auth boundaries; relational database (PostgreSQL) with transactional event sequencing, structured role checks, and durable outbox for notifications.
- **Offline:** service worker for asset caching, IndexedDB local command log, deterministic reconciliation protocol, designated coordinator/failover rules.
- **Realtime:** WebSockets or server-sent events for online views; HTTP reconciliation and polling fallbacks.
- **Notifications:** SMS adapter, USSD adapter, templates, consent/cost-limit controls and delivery logs; credentials injected via environment secrets.
- **Operations:** self-contained test fixtures, migrations, seed data, structured logs and dashboards. Infrastructure resource selection is not a project blocker.

**Critical design gate:** Define authority behavior during a multi-device network partition, coordinator loss, concurrent operations, and stale session expiry before implementing queue advancement. If safe advancement cannot be assured, fail visibly and pause rather than inventing consistency.

## 10. Validation and test matrix

1. Multiple registration channels create tickets in one queue without duplicates.
2. 1,000+ scripted sequential/mixed event replay operations reconcile idempotently in test fixtures (target, not an existing benchmark).
3. Two disconnected devices cannot both commit conflicting authoritative `call-next` events.
4. Coordinator lost during a call; recover from durable log and verify exact-once committed transition.
5. Local provisional registrations reconcile after reboot and network recovery.
6. Permission checks reject unauthorized priority changes, counter controls, and cross-tenant access.
7. Ticket recovery is rate-limited, scoped, and does not leak private data.
8. Adaptive routing obeys counter capabilities and leaves a preserved transfer chain.
9. Wait-time explanation responds to counter closures and insufficient history.
10. Event tampering is detected in a controlled integrity-check test.
11. Full keyboard/screen-reader path on visitor join, status, recovery; mobile low-bandwidth pass.
12. Provider sandbox validates SMS delivery callbacks, failure handling, duplicate notifications, USSD session navigation and expiration.
13. Demo outage and reconnect scenarios run deterministically, using recorded evidence rather than mock success banners.

## 11. Project execution workstreams

1. **Foundation and policies:** tenant model, permissions, service/counter configuration, state machine, event schema, automated CI.
2. **Queue core and visitor UX:** registration, staff calling, public display, status and recovery.
3. **Continuity Engine:** IndexedDB command capture, coordinator authority, reconciliation, conflict UI, device monitor.
4. **Fairness and operational intelligence:** priority rules, audit/checkpoints, routing, wait-time calculations.
5. **Accessibility and product polish:** public views, keyboard/mobile/assistive tests, low-data and localization readiness.
6. **Channels:** SMS/USSD provider-neutral contracts, sandbox flows, costed provider selection, live activation if viable.
7. **Hardening and submission:** performance, security, incident simulation, documentation, public repo, demo video and judge-ready walkthrough.

All feature groups are in scope; workstreams are sequencing, **not feature cuts**. Milestones should expose explicit acceptance gates and automated validation evidence.

## 12. Kiro hackathon delivery requirements

- Use Kiro substantially for spec-driven planning, implementation, review, and verification rather than ceremonial use.
- Maintain root `.kiro` content, including steering files/specifications and relevant agent workflow documentation.
- Keep public open-source repository, setup instructions, test evidence, architecture diagrams, and feature-to-requirement mapping.
- Produce a publicly reachable working app and a public demo video under three minutes.
- Document what Kiro concretely contributed, with demonstrable artifacts.
- Verify final submission rules and precise eligibility at submission time.

## 13. Provider selection: SMS and USSD (open decision)

Before integrating live telecom traffic, compare candidate Nigerian and regional aggregators by: setup and short-code fees, per-SMS tariffs, inbound SMS availability, USSD session fees, required approvals/KYC, sender-ID registration, sandbox access, supported networks, webhooks, delivery receipts, support, reliability, and prepaid spending limits.

**Decision rule:** use only available sponsored/free credits or other already-authorized non-personal resources; do not incur new out-of-pocket expense by default. Select live SMS and USSD providers separately if economically or technically preferable. Until live network tests pass, expose these channels as sandbox/not-yet-live rather than falsely claiming production operation.

## 14. Risks and mitigations

| Risk                                                   | Mitigation                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Network partitions create incompatible queue decisions | Designated authority and fenced leadership; provisional capture on secondary devices; conflict review    |
| Local data loss                                        | Durable local operation log, status indicators, backup/recovery tests                                    |
| Unfair priority handling                               | Explicit policies, role-checked override, append-only audit events                                       |
| False ETA confidence                                   | Explain intervals, stale badges and uncertainty                                                          |
| SMS/USSD access costs or carrier delays                | Provider-neutral adapters, sandbox verification, choose based on real tariff and credits                 |
| Shared or stolen ticket code                           | Scoped recovery secret, throttling, minimal disclosed data                                               |
| Feature sprawl obscures demo                           | Center narrative on continuity + fairness + accessibility; retain all requirements in delivery plan      |
| Product overlaps competitors                           | Show verifiable outage behavior, governance, and low-friction access rather than claiming QR/SMS novelty |

## 15. Definition of done

QueueBridge is ready for hackathon submission when all ten core features are present in integrated, reproducible workflows; offline consistency and audit claims pass adversarial tests; visitor and staff journeys run on real persisted state; the UI is accessible and polished; SMS/USSD adapters and end-to-end sandboxes are complete with live network functionality labeled accurately; documentation and Kiro artifacts are published; and the public demo demonstrates the actual product within the allowed time. Real network activation depends on approved provider access, not engineering claims.

## 16. Pending decisions (do not block core implementation)

- Exact service domain for primary demo: clinic, student service center, or government service desk. Initial default: clinic/community service center, without handling sensitive clinical records.
- Offline coordinator discovery, fencing, and leadership transfer mechanism.
- Hosting resource layout and service limits (operational choice only; not a budget concern).
- Validated translations and specific second language.
- SMS and USSD providers, actual tariffs, registration/approval timelines, and available credits.
- Final repository name, brand assets, and public demo dataset.

---

## Addendum A — F13 Ask Que Anything (planned; added 2026-11-07)

> This addendum adds a planned feature. It does **not** modify §1–§16: the ten core feature groups,
> F11/F12, the non-goals, the definition of done and all earlier decisions stand as written.
> Specification: `.kiro/specs/queuebridge/requirements.md` (REQ-F13), `design.md` §11, ADR-011.

### A.1 Statement

**Ask Que** is QueueBridge's context-aware, role-aware, offline-capable self-service navigation
assistant. It helps people find the right screen and the right instructions for what they are
doing now. It is **not** a general-purpose chatbot and it does not run queue operations.

### A.2 Consistency with existing scope

- §1 / §2 non-goals: Que's primary behaviour is deterministic help that needs no AI. The optional
  AI explanation layer is non-core, disabled by default, limited to approved free-tier or
  sponsored inference, and never required by any queue operation. No paid AI model is introduced.
- §13 decision rule applies to inference exactly as to telecom: no new out-of-pocket expense.
- F7 accessibility and private-data rules apply to Que in full.

### A.3 Capabilities

1. Guided navigation from the current screen, role and permitted features.
2. Searchable help for visitor registration, ticket status, recovery, staff operations, facility
   configuration and connectivity.
3. Offline knowledge base of essential instructions through the PWA.
4. Optional AI explanations of natural-language questions (approved free-tier/sponsored provider only).
5. Strict RBAC and tenant isolation; never discloses unauthorized information.
6. Read-only: cannot change tickets, priorities, staff permissions or facility settings.
7. Deterministic fallback whenever AI or connectivity is unavailable.
8. Accessible, mobile-first UI with keyboard and screen-reader support and clear AI disclosure.
9. No fabricated capabilities or operational promises (gated by a capability manifest).
10. Dedicated automated tests (testing steering Group 13).

### A.4 Acceptance

- Visitor, reception, counter, supervisor, administrator and auditor each receive only their
  permitted help and navigation, verified by automated role-matrix tests.
- With the network disconnected, built-in help remains searchable and navigable.
- With AI disabled, failing, slow, out of quota or returning invalid output, Que returns
  deterministic help and states why.
- Que cannot change any state; there is no path from Que to a mutation.
- Que describes a non-live capability only as `preview`, `sandbox` or `planned`.
- Keyboard-only and screen-reader use pass; AI answers are labelled and cite sources.
- Prompt-injection corpus cannot make Que leak restricted content, other tenants' data or system
  configuration, or present unauthorized links.

### A.5 Schedule

Milestone **MQ**, after M5 and before M6 (no renumbering of M0–M7). KB content grows with each
later milestone.

### A.6 Pending decisions

- Inference provider: none selected. Research during MQ only; eligible only with no personal
  spending, no payment card and no automatic paid overage. Otherwise the AI layer stays off.
- Anonymous visitors: AI disabled initially (decided 2026-11-07); public deterministic help remains.
- Second-language KB content only with validated translations.

### A.7 Decided constraints (2026-11-07)

- All essential Que navigation and explanations work without AI and without network access; AI is
  never a dependency for completing a QueueBridge workflow.
- Offline staff help caches only generic procedures, never tenant-sensitive content, and expires
  with the session; role changes and sign-out invalidate it.
- Group 13 (Ask Que) is part of the M7 final regression and acceptance checklist.
