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

## Milestone status (reconciled 2026-11-12)

M0–M4 are implemented and **merged into `staging`** (PRs #1–#6). Order from here: **M5 → MQ → M6 → M7**
(MQ = Ask Que, between M5 and M6; no renumbering). Do not implement a later milestone's scope early.

## F14 — Smart Turn Alerts (planned; milestone M5, with F4/F7/F9 unchanged)

Tell a visitor they have been called, through layers that fail safely. Spec: REQ-F14, design §12, ADR-013.

- In-app notification when the visitor is called: persistent, accessible visual alert plus live-region announcement. Needs no permission or provider.
- Optional sound (off by default) and supported foreground vibration (page open, device support only).
- Opt-in Web Push where supported, requested only by an explicit visitor action; best effort.
- Accessible visual fallbacks for every non-visual cue; keyboard and screen-reader usable; reduced-motion safe.
- **Never assume or promise background vibration or push delivery.** The public board and staff calling are the reliable fallback.
- **A failed, slow or unavailable notification never blocks queue progression and never automatically marks a visitor missed.** Missed-turn handling follows the F4 policy only.
- Alerts follow server-committed events only; offline-applied actions alert nobody until committed.
- Report delivery honestly: `sent` is not `delivered`.
- No paid service. Do not implement before M5.

## M5 detail for F4, F7 and F9 (design §15–§17; requirements unchanged, additive detail)

- **F4 recovery:** never from the public ticket code alone. A private ≥128-bit recovery key (QR/link or readable text) or a restricted, audited staff procedure (presence and the public code are not proof); status tokens capped at 3 and revocable ("sign out other devices"); throttles that the guess cannot evade and that never lock out the rightful holder; recovery never changes queue state. Grace stays the existing per-service `grace_window_seconds`; `rejoin_policy` defaults to `staff_resume`; automatic no-show is off by default and executes only through the authoritative command path.
- **F7 accessibility:** device-local display preferences (contrast, text size, motion, quiet alerts), keyboard and focus rules, an announcement policy, offline accessibility, 320/375 px, unlocked orientation. Verified, not claimed as conformant.
- **F9 device health:** stale detection, automatic in-product alerts to supervisors/admins, privacy-minimal device data, lost-device guidance. Observes only; the single-coordinator model is unchanged and failover stays an explicit supervisor action.

## F11 extension — SMS Turn Alerts (planned; milestone M6)

"You are called" SMS through the existing `ChannelAdapter` architecture and the M5 outbox pipeline, with consent, opt-out, hard caps and idempotency. Real provider support is preserved but live traffic only with approved sponsored/free credits (no personal spending); sandbox is the labelled default. USSD (F12) stays in M6.

## F15 — Final UI/UX, Branding and Public Landing (planned; milestone M7)

Spec: REQ-F15, design §14, ADR-014.

- Complete responsive redesign of all role interfaces on one design-token system; consistent original branding.
- Animated public landing page at `/` with clear product messaging and an organizational onboarding path (sign up, get-started checklist, how visitors join).
- Truthful content: no "conflict-free", no guaranteed delivery, SMS/USSD shown as live only when the capability manifest says so, no invented metrics or testimonials.
- Reduced-motion safe, pausable, never flashing; separate lazy-loaded chunk so visitor flows stay light; no third-party requests.
- Verified for accessibility, performance (measured budgets), security and cross-browser (Chromium, Firefox, WebKit + real-device checklist). State verification limits honestly.
- Do not implement before M7.

## Non-goals (do not implement)

- Hospital EMR/EHR, banking core, government identity, or enterprise connectors.
- Medical triage or clinical decisions.
- Paid AI model or generative AI for core operations.
- Personal-funds-dependent infrastructure, kiosks, phones, SMS packages, or subscriptions.

## Definition of done (hackathon submission)

All ten core features present in integrated reproducible workflows; offline consistency and audit claims pass adversarial tests; visitor and staff journeys run on real persisted state; accessible and polished UI; SMS/USSD adapters complete with sandbox; documentation and Kiro artifacts published; public demo within time limit.
