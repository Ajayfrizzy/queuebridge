# M1 Test Evidence — Tenancy, Roles and Facility Setup

**Branch:** feature/m1-facility-identity · **Node:** v24 · **pnpm:** 9.15.9 · **PostgreSQL:** 17.10 (Docker, disposable)
**Scope:** M1.1, M1.2, M1.3 (F10 foundation). CI has **not** been run for this branch (nothing was pushed).

## Gate results (local)

| Gate                                      | Result                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm format:check`                       | PASS                                                                                      |
| `pnpm lint` (`--max-warnings 0`)          | PASS                                                                                      |
| `pnpm typecheck`                          | PASS (all 8 workspaces)                                                                   |
| `pnpm build`                              | PASS                                                                                      |
| `pnpm test` (no DB)                       | PASS — contracts 49, ui 6, domain 40, channels 18, worker 6, continuity 11, api 15, web 7 |
| `pnpm test:db` (real PostgreSQL)          | PASS — 7 files, 226 tests; run twice back-to-back on the same DB (re-runnable)            |
| `pnpm --filter @queuebridge/web test:e2e` | PASS — 22 browser tests (desktop Chromium, plus 320px and 375px projects)                 |
| `pnpm db:migrate` on a fresh database     | PASS — 0001–0003 applied; second run SKIPs all                                            |
| `pnpm db:seed` twice                      | PASS (idempotent)                                                                         |
| Migration 0003 re-executed twice          | PASS (asserted in `schema-m1.db.test.ts`)                                                 |
| `pnpm audit --audit-level high`           | No high/critical findings (5 low/moderate reported)                                       |

## Coverage by testing-steering group

- **Group 2 (contracts):** `packages/contracts/src/admin.test.ts` — accept/reject for every M1 schema, strict-mode mass-assignment rejection, role enums.
- **Group 4 (PostgreSQL):** concurrent org-slug creation yields exactly one org and no orphans; concurrent redemption of one invitation token yields exactly one account; composite-FK tenant integrity; capability same-facility trigger.
- **Group 8 (security/access, M1 scope):**
  - `rbac.db.test.ts` — 16 endpoints × 6 roles permission matrix (allow and deny sides), cross-facility 404, escalation attempts, immediate effect of role revocation, last-admin guard, deactivation kills sessions.
  - `tenant-isolation.db.test.ts` — 16 probes × (org_admin, facility_admin) against another org's real IDs return 404 identical to made-up IDs; target data verified unchanged; DB-level cross-org inserts rejected.
  - `auth.db.test.ts` — cookie flags (HttpOnly, Secure, SameSite=Strict), 256-bit token, only SHA-256 stored, argon2id password hashes, uniform login failure, expired/garbage/oversized cookies, CSRF header + Origin check (incl. login CSRF), CORS allow-list, RFC 9457 problem format, rate limit → 429.
  - `invitations.db.test.ts` — single use, expiry, revoke, duplicate prevention, existing-member password proof, and a log-capture test proving tokens, passwords, emails and cookies are never logged.
- **Group 9 (partial, admin events):** `admin_events` append-only trigger verified (UPDATE/DELETE rejected); events carry actor and contain no emails/tokens.
- **Group 11 (accessibility, M1 screens):** axe-core WCAG 2.1 A/AA on every M1 screen incl. error states and at 320/375px; keyboard-only signup + facility creation; skip link and focus management; live-region announcements; text (not colour-only) statuses; reduced motion; 44px touch targets; no horizontal overflow at 320/375px.
- **M1 exit journey (browser):** signup → facility → service → counter → capability → join link/QR → invite → accept in a separate browser → least-privilege UI → sign out/in → role changes, all without DB access.
- QR correctness: unit test rasterizes the QR matrix and decodes it with an independent decoder (jsQR) back to the exact join URL.

## Not covered / known limits

See `M1-completion.md` → Unresolved issues.

---

# Post-review refinement round (items 1–10)

**Verified locally after the refinements** (PostgreSQL 17 in Docker, disposable DB; CI not run — nothing pushed).

| Gate                             | Result                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm format:check`              | PASS                                                                                               |
| `pnpm lint` (`--max-warnings 0`) | PASS                                                                                               |
| `pnpm typecheck`                 | PASS (8 workspaces)                                                                                |
| `pnpm build`                     | PASS                                                                                               |
| `pnpm test` (no DB)              | PASS — contracts 49, ui 6, channels 18, domain 40, worker 6, continuity 11, **api 25**, **web 11** |
| `pnpm test:db` (real PostgreSQL) | PASS — 9 files, **241** tests (was 226)                                                            |
| Playwright browser tests         | PASS — **42** (desktop 1280, desktop-1440, mobile 320, mobile 375); was 22                         |
| `pnpm audit --audit-level high`  | No high/critical findings (5 low/moderate, unchanged)                                              |
| API on port 3002 beside Avroqen  | PASS — `GET :3002/health/ready` 200 while Avroqen kept :3001; containers untouched                 |
| Migrations                       | No new migration in this round (0003 unchanged; fresh-DB/idempotency evidence above stands)        |

## Findings and verification per item

1. **Slug wording** — labels are now "Organization URL identifier (slug)" and "Facility URL identifier (slug)" with hints. Browser test asserts the new labels and absence of "address" labels.
2. **Persistent toast** — root cause: the visible toast was the live region itself and never cleared. Now a visually hidden polite live region carries the announcement (cleared after ~10 s) and a separate visible toast is dismissible by button or Escape and auto-dismisses at 8 s. Browser tests: dismiss keeps the announcement, Escape, auto-dismiss (fake clock), no `aria-live` on the visible copy (no double announcement), axe with toast visible.
3. **Readiness** — new `GET /facilities/:id/readiness` (any facility role). Ready only if the facility is active AND an active counter is assigned to an active service. Overview shows per-service/per-counter reasons and actionable issues. Visitor join is reported `operational: false` (constant `VISITOR_JOIN_OPERATIONAL`) and the UI shows a "Not live yet / Do not share" notice and a "preview only" QR label in every state. Unit tests (9) + DB tests (7) + browser tests.
4. **Policy display** — shared `describePolicy` lists only enabled classes in stored rank order or "Single queue". Unit tests (4) + browser test over 4 policies (no "Urgent" on priority-only, etc.). Form copy clarified ("normal" is always on).
5. **Eligibility regression tests** — inactive counter, inactive service, inactive facility, unknown/foreign capability ids, reactivation restoring eligibility, cross-tenant isolation of the computation. M2 routing-engine tests are deferred.
6. **Staff screen** — separated Active / Deactivated / Org administrators (read-only, new `org_admins` in the staff response) / Pending invitations / Invitation history. Org-admin-only deactivate/reactivate with two-step confirmation; no control for self or for facility_admins (API still 403s them). Accepted invitations leave "Pending".
7. **Live-session effects** — `session-effects.db.test.ts` (7 tests): downgrade, last-role revocation (404), grant, deactivation killing two concurrent sessions, reactivation not resurrecting old cookies, deactivated users cannot be re-roled or redeem invitations, facility_admin/foreign org_admin cannot deactivate. Browser: deactivated user is returned to sign-in with a "session ended" notice (global 401 handler); revoked admin gets 404/"Facility not found".
8. **Inactive counter configuration** — assignments can be added/removed on inactive counters via API and UI (checkboxes enabled, explanatory hint); readiness never counts them. DB + browser tests.
9. **Ports** — API default 3002 (`env.ts`, `.env.example`, README, design.md, Vite proxy default, CI). Test asserts the default. Dedicated E2E API port remains 3101. I also repaired a stray shell command that had been pasted into `.env.example` as the value of `API_PROXY_TARGET` (now `http://localhost:3002`). Avroqen files/containers were not touched.
10. **Desktop layout** — container widened to 80rem; two-column workspace (list left, form/side panel right, sticky) from 64rem; single column below. Browser tests at 1280, 1440, 375 and 320 px assert side-by-side vs stacked placement, top alignment, no horizontal overflow, and axe on all screens.

## Defect found by this round's tests

- The "To finish setup" links used router-relative paths and resolved to `/services` (404). Fixed to absolute facility paths; link text made distinct from the nav links.

---

# Pre-PR review (final M1 review)

- Branch verified: `feature/m1-facility-identity`; full diff (87 files incl. earlier intent-to-add entries) reviewed. No secrets, `console.log`/`debugger`, `.only`/`skip`, TODO/FIXME or unrelated files. `.env` is gitignored and untracked; only `.env.example` is committed. Seed hash is the documented dev-only credential.
- **Last-active-org-admin safeguard — gap found and fixed.** Before: self-deactivation was blocked and only org admins could deactivate, but two org admins could deactivate each other concurrently and leave zero active admins. Now `PATCH /staff/:id` locks the organization's org-admin rows, re-checks the actor is still active, and refuses (409) any deactivation that would leave no other active org admin. Org admins can only be created at signup (not through the API), so multi-admin orgs are modelled in tests via direct inserts.
- New DB tests (3): sole admin cannot be deactivated by self/others; survivor protected after deactivating a peer; concurrent mutual deactivation (5 rounds) always leaves exactly one active admin. `pnpm test:db`: **244 passed**.

---

# PR #2 review round — three Codex P2 findings

All local gates re-run after the fixes: format PASS, strict lint PASS, typecheck PASS (8), build PASS, unit PASS (api 25, **web 20**, others unchanged), real PostgreSQL **251** passed (was 244), Playwright **49** passed (was 42) at 1280/1440/375/320, audit: no high/critical.

1. **Expired invitations blocked replacements** (`staff_invitations_open_idx`). Fix in `POST /facilities/:id/invitations`: inside the same transaction as the insert, matching invitations (same org, facility, lower(email), role) that are unaccepted, unrevoked and `expires_at <= NOW()` are marked `revoked_at = NOW()` and each is audited as `invitation.expired_retired` (no email/token in details). Pending unexpired invitations are untouched, so dedupe still returns 409. Concurrency: the unique index remains the arbiter; parallel replacements yield exactly one 201 and 409s, never 500. No migration change (rows are retired, never deleted). DB tests (7): replacement succeeds and old token stays 410; audit without PII/tokens; pending still 409; other roles untouched; other facility/org untouched; 5-way concurrent replacement; history shows the old invitation as revoked. Browser test: dedupe → expiry → re-invite from the UI.
2. **Failed logout looked successful.** `logout()` now clears local auth state only after the server confirms (204) or reports no session (401); network failures, 5xx and 403 reject and the user stays signed in. Layout shows a focused `role="alert"` "You are still signed in" notice with **Retry sign out** and **Dismiss**; the Sign out button shows "Signing out…" and is disabled while in flight. `/auth/logout` is excluded from the global "session ended" 401 handler. Browser tests (5): network abort (also axe-checked, and reload proves the session is still valid), 500 then successful retry (server session verified gone), dismiss, 401 treated as signed out, normal sign-out still destroys the session.
3. **`useLoad` stale responses.** Request generations + current-key tracking: only the latest load for the current key may set data, error or loading; key changes clear old data immediately; reloads captured under an old key are ignored; late responses after unmount are dropped. Unit tests (9, jsdom + React act) — 6 of them fail against the previous implementation. Browser test: a stale counters snapshot delayed until after a newer capability change can no longer uncheck the newer state; it fails against the old hook and passes with the fix (3 repeats).
