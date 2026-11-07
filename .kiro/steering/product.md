---
inclusion: always
---

# QueueBridge — Product Steering

> Always-on context for Kiro. Every response and implementation decision must be consistent with this product scope.

## Product statement

QueueBridge is a resilient, accessible, accountable queue-coordination platform that keeps service moving through unreliable connectivity across web, staff-assisted, SMS, and USSD channels.

This is NOT a QR ticket generator, NOT an AI chatbot, and NOT a kiosk system. The key differentiator is the **Continuity Engine** — offline-safe queue operations with safe reconciliation, auditable prioritization, and inclusive access for visitors without smartphones.

## Target users

| Role                         | Core need                                                                  |
| ---------------------------- | -------------------------------------------------------------------------- |
| Visitor                      | Join, track, recover, and understand their queue position across channels  |
| Reception/registration staff | Create walk-in tickets, assist visitors, handle exceptions                 |
| Counter operator             | Call, serve, transfer, pause, skip, and complete eligible tickets          |
| Supervisor                   | Authorize exceptions, configure routing, monitor fairness and connectivity |
| Facility admin/owner         | Provision facilities, services, counters, staff, policies, QR codes        |
| Auditor                      | Inspect queue events and integrity indicators, read-only                   |

## Ten committed feature groups (F1–F10) — all required

### F1 — Offline-first queue operations

- Cache app shell and authorized facility data for offline use.
- Persist local queued operations in IndexedDB before acknowledging locally.
- Single designated offline coordinator per queue session with defined failover policy.
- Non-authoritative devices may capture provisional registrations only — cannot independently commit call/advance.
- Reconnection: deduplicate with stable operation IDs, reconcile provisional ops, surface conflicts, never silently overwrite committed events.
- Required UI states: `Local / Pending Sync / Synced / Needs Review`.

### F2 — Inclusive registration

- Web and QR registration with no mandatory account.
- Staff-assisted walk-in registration and short ticket code fallback (no printer needed).
- Entry-point adapters for SMS and USSD; rollout state shown per facility.
- Duplicate-prevention policy without excluding shared-phone households.

### F3 — Queue fairness and transparency

- Explicit published ordering policy per service (default FIFO, configurable priority classes).
- Permission-gated priority overrides with reason codes and free-text; private reasons not on public displays.
- Consistent handling of pauses, skips, no-shows, late arrivals.

### F4 — Ticket recovery and missed-turn handling

- Recovery using scoped ticket code plus additional verification.
- Persist visitor ticket state across refresh, device restart, connectivity loss.
- Configurable grace windows, rejoin policies, no-show outcomes.
- Stolen codes must not expose personal data or perform sensitive actions.

### F5 — Adaptive service routing

- Facility defines services, counter capabilities, queue policies, opening status.
- Route tickets using explicit deterministic rules: service match, priority class, waiting age, counter availability.
- Transfer between counters/services preserving original audit trail and service history.
- Supervisor override requires rationale.

### F6 — Explainable wait-time estimates

- Estimate from active counter count, eligible tickets ahead, observed service duration, schedule.
- Show interval/confidence indicator and short explanation; state when data is insufficient.
- Recalculate after completions, pauses, routing changes, reconnection.
- Never promise an exact serving time.

### F7 — Accessibility-first visitor experience

- Mobile-first, low-bandwidth, semantic HTML, keyboard navigation, screen reader announcements.
- High contrast, reduced-motion, non-color-only statuses, large text option.
- Public display mode with visual and optional audio ticket calling.
- Localization framework; English baseline; add second language only if translations can be validated.
- Private visitor data never on public screens.

### F8 — Tamper-evident operational history

- Append-only server event log with hash chain integrity.
- Audit all permissions, routing overrides, ticket transitions, sync conflicts.
- Searchable, scoped, read-only audit view and export.
- Redact sensitive PII from public logs.

### F9 — Connectivity and recovery dashboard

- Show each device's last contact, pending-action count, sync health, coordinator status.
- Retry and conflict-resolution UI for privileged staff with safe idempotent operations.
- Distinguish unconfirmed client actions from server-confirmed state.

### F10 — Portable facility setup

- Self-service onboarding: facility, services, counters, staff invitations, permissions, policies, QR codes.
- Multi-tenant isolation between facilities.
- No manual database changes required for a new facility's first visitor.

## F11 — Real SMS (required; live provider contingent on approved cost)

- Ticket confirmation, nearing-turn, called-to-counter, significant delay, missed-turn — with consent and opt-out.
- Provider-neutral adapter with credentials, templates, delivery callbacks, idempotency, rate limits, billing caps.
- Record delivered/failed/unknown; never claim delivery without provider confirmation.
- Sandbox tests required regardless; live delivery only with approved affordable provider.

## F12 — Real USSD (required; live provider contingent on approval/code)

- Stateful server-side flow for join, status, service discovery, recovery via provider-neutral webhook.
- Session expiration, invalid input recovery, short menus, replay defense.
- Do not invent a USSD code or claim live access without an authorized network relationship.

## F13 — Ask Que Anything (planned; milestone MQ, after M5 and before M6)

Context-aware, role-aware, offline-capable self-service **navigation assistant** — not a
general-purpose chatbot and not part of core queue operations. Spec: REQ-F13, design §11, ADR-011.

- Deterministic first: versioned knowledge base, screen/route registry, offline search via the PWA.
- Optional AI explanation layer: disabled by default; approved free-tier or sponsored provider only;
  never paid; always falls back to deterministic help.
- Read-only: never changes tickets, priorities, staff, permissions or facility settings.
- Role- and tenant-scoped: never discloses unauthorized content, data or navigation targets.
- Truthful: describes only `live` capabilities; labels `preview`/`sandbox`/`planned` honestly.
- Accessible: keyboard, screen reader, mobile-first; AI answers are labelled and cite sources.
- Essential navigation and explanations work without AI and without network; no workflow depends on AI.
- AI inference is not offered to anonymous visitors; they keep public deterministic help.
- No inference provider is selected; research only during MQ (no payment card, no spending).
- Do not implement before milestone MQ.

## Non-goals (do not implement)

- Hospital EMR/EHR, banking core, government identity, or enterprise connectors.
- Medical triage or clinical decisions.
- Paid AI model or generative AI for core operations.
- Personal-funds-dependent infrastructure, kiosks, phones, SMS packages, or subscriptions.

## Definition of done (hackathon submission)

All ten core features present in integrated reproducible workflows; offline consistency and audit claims pass adversarial tests; visitor and staff journeys run on real persisted state; accessible and polished UI; SMS/USSD adapters complete with sandbox; documentation and Kiro artifacts published; public demo within time limit.
