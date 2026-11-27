# ADR-011: Ask Que — Deterministic-First, Read-Only Navigation Assistant

**Date:** 2026-11-07  
**Status:** Accepted (2026-11-16). Specification only; implementation is milestone MQ, starting with task MQ.1.  
**Acceptance:** direction approved by the product owner on 2026-11-07 (recorded below); formally
accepted on 2026-11-16 in the MQ specification reconciliation after M5 was merged into `staging`
(PR #8, `cebbe06`). Evidence: `docs/reports/MQ-design-readiness.md`.  
**Feature:** F13 — Ask Que Anything (planned, milestone MQ)

## Context

Visitors, reception staff, counter operators, supervisors, administrators and auditors need quick,
in-context guidance: how to join or recover a ticket, what a sync state means, how to configure a
counter, what to do during an outage. Much of this guidance must work **offline** and on
low-bandwidth Android devices (REQ-NFR.5, F1, F7).

Constraints that shape the decision:

- QueueBridge is **not** an AI chatbot, and a paid AI model or generative-AI dependency for core
  operations is a non-goal (PRD §1, §2). Core queue operations must never depend on inference.
- Zero personal spending: no subscription and no paid inference (PRD §2, §13 decision rule).
- Strict RBAC and tenant isolation are core invariants (REQ-SEC.6, REQ-SEC.7, REQ-F10.3).
- QueueBridge must not claim capabilities that are not live (REQ-F11.7, REQ-F12.4, M1 join-link
  rule `VISITOR_JOIN_OPERATIONAL`).
- External content (including user questions and model output) is untrusted.

## Decision

1. **Deterministic first.** Que's primary behaviour is deterministic: a versioned, role-partitioned
   knowledge base (KB) of short articles, a route/screen registry mapping each screen to relevant
   articles and permitted next steps, and an in-browser keyword search. This path has no
   inference, no network dependency once cached, and is the fallback for every failure.
2. **Optional AI explanation layer.** A natural-language layer may rephrase and combine
   **already-authorized KB articles** only. It sits behind a provider-neutral `InferenceAdapter`
   (same pattern as ADR-009), is **disabled by default**, and may be enabled only for an approved
   free-tier or sponsored provider (`QUE_AI_COST_MODE` ∈ `free_tier | sponsored`). There is no paid
   mode. Any error, timeout, quota limit or failed output validation falls back to deterministic
   help.
3. **Read-only.** Que exposes no mutation tools and calls no state-changing endpoints. It may
   offer navigation links to screens the user is already permitted to open; the user performs
   every action through the normal, RBAC-enforced UI.
4. **Server-side authorization of content.** Visitor (public) articles ship in the PWA precache.
   Staff/supervisor/admin/auditor articles are served by an authenticated endpoint filtered by the
   session's roles, cached per user, and cleared on sign-out. Client-side filtering is UX only.
5. **Capability manifest.** A single machine-readable manifest records whether each platform
   capability is `live`, `preview`, `sandbox` or `planned`. KB articles declare required
   capabilities; Que never presents a non-live capability as available.
6. **New package `packages/assist`** (imports `contracts` only; no I/O): KB schema, search, route
   registry, capability gating, answer-validation guard. The inference adapter lives in
   `apps/api` (server-only, credentials never reach the browser).

## Consequences

**Positive**

- Help works offline and on low bandwidth, independent of any provider.
- Zero cost by default; AI can be removed without functional loss.
- Authorization and "no fabricated capability" rules are testable deterministically.
- KB grows incrementally as each milestone ships (articles gated by capability status).

**Negative / risks**

- KB content must be maintained alongside features (enforced by a KB freshness test and a
  per-milestone content gate).
- Free-tier providers impose quotas and may change terms; the feature must tolerate their absence.
- Model output can still be wrong while passing validation; mitigated by retrieval-only grounding,
  citations, AI disclosure, and conservative fallback.
- Sending question text to a third party is a privacy decision; requires facility opt-in,
  disclosure and PII redaction (see security steering, Que section).

## Alternatives considered

- **AI-first chatbot:** rejected — conflicts with product positioning, cost rule and offline needs.
- **In-browser local model:** zero cost but large downloads conflict with low-bandwidth targets;
  kept as a possible future adapter, not selected.
- **No assistant (static docs only):** loses screen- and role-aware navigation; rejected.

## Decisions recorded on 2026-11-07 (direction approved by the product owner)

- **No provider selected.** Free-tier or sponsored options are researched during MQ; selection or
  integration needs a separate explicit decision. Eligible only with no personal spending, no
  payment card and no automatic paid overage.
- **Anonymous visitors:** no AI inference initially; public deterministic help stays available.
- **AI independence:** all essential navigation and explanations work without AI or network.
- **Offline staff help:** generic procedures only, never tenant-sensitive content; bound to user
  and role digest, expires no later than the session, purged on sign-out, 401 or role change
  (design §11.5).

## Acceptance and M5 reconciliation (2026-11-16)

The decision above is accepted unchanged. Every principle is retained:

- deterministic first, and fully functional with the AI layer disabled;
- offline and low-bandwidth operation from cached, text-only bundles;
- role awareness and tenant isolation, with restricted content authorized server-side;
- read-only: no mutation path, no tool calling, outside the authoritative sequence (ADR-004);
- an optional AI layer behind a provider-neutral `InferenceAdapter`, disabled by default;
- no personal spending, no payment card, no paid inference and no automatic paid overage;
- truthful capability status from a manifest generated from server flags.
  **No inference provider is selected.** Acceptance of this ADR does not select, approve or
  integrate a provider; that still needs a separate explicit decision (REQ-F13.4.8).
  M5 added behaviour that Que must explain (ticket recovery and the restricted staff procedure,
  recovery activity audit, grace, self-resume and automatic no-show, device health, turn alerts and
  accessibility preferences). Reconciling it needed no change to this decision. The specification
  clarifications made at the same time are in design §11.2, §11.3, §11.10a and §11.11 and are listed
  in `docs/reports/MQ-design-readiness.md` §3. They are:
- `org_admin` receives every staff audience, because the API lets an organization administrator
  satisfy every permission (`apps/api/src/auth/rbac.ts`);
- route-registry entries need the domain transition roles as well as API permissions, because
  counter actions are gated by the ticket state machine, not by a named permission;
- a capability that is built but switched off in a deployment (Web Push without VAPID keys) must
  never be shown as available (decided as D1 below);
- the M5 knowledge-base inventory and capability entries are listed in design §11.10a.

## Reconciliation decisions D1–D4 (approved by the product owner, 2026-11-16)

All four are within this decision; none changes the architecture.

- **D1 Capability availability.** The four statuses (`live`, `preview`, `sandbox`, `planned`)
  stay as they are. A separate server-computed `availability` (`available` | `unavailable`, with
  reason `not_implemented`, `not_configured` or `switched_off`) says whether a built capability
  can be used in this deployment now. Que presents a capability as usable only when it is `live`
  and `available`; REQ-F13.9.1 is unchanged (design §11.2).
- **D2 Role fingerprint.** One server-side function computes the fingerprint of the user's
  effective, facility-scoped role grants; the server issues it with the authenticated restricted
  KB response. The browser compares opaque server values only and never decides authorization.
  Offline expiry, role-change, sign-out and 401 handling are unchanged; `/auth/me` gains no field
  unless a documented compatibility need is approved (design §11.5.4).
- **D3 Permission synchronization.** The API permission map is shared with Que unchanged.
  Consistency checks cover API permissions, Que route access, frontend role assumptions,
  state-machine operation roles and cross-facility authorization. No RBAC redesign (design §11.3).
- **D4 Recovery verification privacy.** Public help may describe the staff-assisted recovery
  procedure but never the verification questions or expected answers, which stay in
  role-restricted staff articles. The recovery procedure is unchanged (design §11.5.1).

The AI layer remains disabled by default, no inference provider is selected, and the
zero-out-of-pocket rule (no personal spending, payment card, paid inference or automatic overage)
remains mandatory.

## Open decisions (do not block MQ.1)

- Whether any researched provider qualifies (criteria in design §11.8); otherwise AI stays off.
- Whether anonymous visitors may ever use AI in a later milestone (requires a new decision).
- Second language for KB content (only with validated translations, per F7).
