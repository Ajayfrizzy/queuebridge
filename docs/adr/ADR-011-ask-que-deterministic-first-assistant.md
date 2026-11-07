# ADR-011: Ask Que — Deterministic-First, Read-Only Navigation Assistant

**Date:** 2026-11-07  
**Status:** Proposed (specification only; not implemented). Formal acceptance is task MQ.1.  
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

## Decisions recorded on 2026-11-07 (direction approved; ADR remains Proposed)

- **No provider selected.** Free-tier or sponsored options are researched during MQ; selection or
  integration needs a separate explicit decision. Eligible only with no personal spending, no
  payment card and no automatic paid overage.
- **Anonymous visitors:** no AI inference initially; public deterministic help stays available.
- **AI independence:** all essential navigation and explanations work without AI or network.
- **Offline staff help:** generic procedures only, never tenant-sensitive content; bound to user
  and role digest, expires no later than the session, purged on sign-out, 401 or role change
  (design §11.5).

## Open decisions (do not block MQ.1)

- Whether any researched provider qualifies (criteria in design §11.8); otherwise AI stays off.
- Whether anonymous visitors may ever use AI in a later milestone (requires a new decision).
- Second language for KB content (only with validated translations, per F7).
