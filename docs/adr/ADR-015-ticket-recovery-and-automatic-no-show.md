# ADR-015: Ticket Recovery Credentials, Abuse Controls, Staff-Assisted Procedure and Automatic No-Show Execution

**Date:** 2026-11-12  
**Status:** Accepted for specification (implementation is milestone M5, task group M5.1)  
**Feature:** F4 — Ticket recovery and missed-turn handling (M5.1)  
**Builds on:** ADR-004 (server-authoritative sequence), ADR-006 (single coordinator), ADR-012 (versioned policy), ADR-013 (turn alerts)

## Context

Today a visitor's only way to read a ticket is a 256-bit status token held in the browser. Losing the
browser state loses the ticket view. M5.1 must offer recovery without creating a new way to take over
someone's ticket. Constraints:

- The public ticket code is shown on boards and spoken aloud. It cannot authorize anything.
- Recovery credentials need at least 128 bits of cryptographically secure entropy (REQ-F4.4,
  security steering) yet must be usable by people on phones.
- Online guessing defences must not be bypassable by changing the guess, and must not let an attacker
  deny the rightful holder access (no irreversible lockouts).
- Physical presence at a desk plus the public code does not prove identity.
- Recovery must not touch the authoritative queue or the coordinator (ADR-004, ADR-006).
- Automatic no-show, if offered, must use the authoritative transition and audit path, work with
  several API instances, restarts and late timers, and never bypass offline-coordinator fencing.
- Notification delivery or failure must never decide that a visitor is missed (ADR-013).

## Decision

1. **Recovery key.** A 160-bit CSPRNG secret (Crockford base32, 32 characters) issued privately at
   join, stored only as HMAC-SHA-256 with an HKDF-derived pepper, shown once, regenerable. It
   authorizes only a new status token for its ticket. A 128-bit minimum is preserved; 160 bits is the
   design value.
2. **Presentation.** QR and link carrying the key in the URL fragment only (not sent to servers, logs
   or `Referer`; stripped from the address bar; sent in a POST body), plus readable grouped text with
   tolerant input, and Copy/Share/Save/Print. Security is not reduced for readability.
3. **Throttles keyed on public identifiers and the source, never on the guess.** Per source 10 attempts
   per minute (all attempts); 5 failed attempts per 15 minutes per ticket code **per source**
   (REQ-F4.4 applied per client); aggregate per-ticket and per-facility limits that affect only sources
   that already failed and raise an abuse alert. All state self-expires within 15 minutes. There is no
   lifetime counter, lock state or unlock action, and a correct key from a clean source always
   succeeds, so the rightful holder cannot be locked out by an attacker.
4. **Staff-assisted recovery is a restricted procedure.** Presence and the public code are not proof.
   No verified factor means restricted assistance and no credential. The basic factor (service and
   approximate join time, confirmed against the console) requires a second `QUEUE_MANAGE` approver.
   A server-checked contact factor is added in M6 when consented contact data exists. Grants are
   single-use, expire in 10 minutes, are redeemed on the visitor's own device from a QR, and staff
   never see a credential. Roles, mandatory reasons, rate limits and audit without values are kept; the
   rightful holder's other devices are notified; a facility can disable the path.
5. **Identity plane only.** Recovery touches credential tables, takes no session lock and appends no
   `queue_events`.
6. **Automatic no-show executes only through the authoritative path.** Off by default; explicit
   seconds when enabled. An API sweep calls the standard command executor with a `system` role for
   `called → missed` only. Per candidate: session then ticket lock, re-check with database time and the
   current policy version, a deterministic version-7-layout `operation_id` (HMAC of ticket id and call
   sequence) so concurrent instances produce one miss and one `duplicate`. It is refused while any
   coordinator is assigned and restarts its clock after the latest coordinator event, so it never
   bypasses M3 fencing. It is stateless across restarts, is a "not before" deadline that may run late,
   and restarts its clock after a detected outage. It has no dependency on notification state.

## Consequences

**Positive**

- A leaked database or log yields nothing verifiable; guessing is infeasible at any request rate.
- Attackers cannot dodge limits by varying guesses and cannot lock out visitors.
- Staff cannot be talked into handing out a ticket by someone who merely read the board.
- Recovery and automatic no-show cannot weaken the authoritative sequence or coordinator authority.

**Negative / risks**

- A 32-character typed key is long; the QR/link path is the intended primary route, and typing is the
  fallback.
- Until M6 there is no server-checked staff factor, so every staff-assisted grant is low assurance
  and needs a second person. This is deliberate and documented.
- A skilled impersonator who knows the service and join time can pass the basic factor; the second
  person, single-use 10-minute grants, notifications to the rightful holder and the audit trail are
  the compensating controls.
- Per-source limits mean an attacker with many addresses can raise failure counts (and alerts) but not
  block clean sources; shared facility Wi-Fi shares the per-minute limit briefly.
- Automatic no-show can run later than its deadline (sweep interval, outages); the UI states the rule
  as a floor, not a promise.

## Alternatives considered

- **Short (50-bit) human-typed code as a second factor:** rejected; below the 128-bit requirement and
  it forces lifetime lockouts that enable denial of service.
- **Throttle by submitted code string:** rejected; varying the guess evades it.
- **Lifetime lockout after N failures:** rejected; attacker can lock out the rightful holder.
- **Recovery on the public code plus presence:** rejected; neither is proof of identity.
- **SMS one-time code for recovery:** deferred to M6 (needs consented contact data and a live or
  sandbox channel).
- **Auto-miss in the worker or with a leader-elected timer:** rejected; it needs the same locks and
  event append as every command, and correctness must not depend on a single instance.

## Verification (see testing steering, Group 8: items 8.R1–8.R12)
