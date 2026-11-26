# M1 Completion Report — Tenancy, Roles and Facility Setup

**Branch:** `feature/m1-facility-identity` (not pushed, no PR, nothing merged or deployed)
**Evidence:** `docs/testing/M1-evidence.md`

## What was built

**Database (migration `0003_tenancy_roles_invitations.sql`, additive + idempotent)**

- `role_assignments`: organization-wide `org_admin` (facility NULL) with scope CHECK; explicit `organization_id`; composite FKs so tenant columns cannot disagree with facility/user.
- Composite tenant FKs on `services` and `counters`; unique names per facility; trigger forcing a counter and service in a capability to share a facility.
- `staff_invitations` (hash-only token, single-open-invite uniqueness) and append-only `admin_events` (trigger-enforced).
- Seed updated: demo admin now has a real argon2id hash and an `org_admin` role (login: `demo-health-centre` / `admin@demo.local` / `dev-only-not-for-production`).

**API (`apps/api`, `/api/v1`)**

- `POST /organizations` (signup + org_admin + session), `POST /auth/login|logout`, `GET /auth/me`.
- `POST|GET /facilities`, `GET /facilities/:id`, `GET /facilities/:id/join-link`.
- Services and counters: `POST|GET|PATCH /facilities/:id/services|counters`.
- `POST /counter_service_capabilities` (idempotent), `DELETE /counter_service_capabilities/:counterId/:serviceId`.
- Staff: list, grant/revoke facility roles, invitations (create/list/revoke), `POST /invitations/preview|accept`, `PATCH /staff/:id` (org_admin deactivate).
- Security: argon2id; 256-bit random session tokens stored as SHA-256; HttpOnly/Secure/SameSite=Strict cookie; CSRF header + Origin allow-list; per-IP rate limits on unauthenticated auth routes; strict Zod input; server-derived tenant/actor; 404-not-403 for cross-tenant and no-role access; RFC 9457 errors; security headers; `/health/ready` now does a real DB check (503 when down).
- RBAC: `org_admin` (all in org) · `facility_admin` (configure + staff) · `supervisor`, `staff_counter`, `staff_reception`, `auditor` (read facility config).

**Web (`apps/web`)**: org signup, login, invitation acceptance (secret in URL fragment, scrubbed after use), admin dashboard, facility create, services (ordering policy), counters + capability checkboxes, staff/invitations/role management, join link + QR (copy, download SVG, print). Accessible, mobile-first.

## Validation

All local gates pass (see evidence file): 226 DB tests, 22 browser tests, plus unit tests; format, lint, typecheck, build, fresh-DB migration and seed.

## Unresolved issues / honest limits

1. **Invitation email is not sent.** No email provider exists (paid services prohibited). The link is shown once to the admin to share manually; the API returns `delivery: "manual"`.
2. CI for this branch has not run (no push). I added a Playwright step to `ci.yml` that is untested on GitHub runners.
3. Rate limiting is in-memory per process (not shared across instances) and per IP only; no per-account lockout, password reset, or MFA.
4. `admin_events` is append-only but not hash-chained, and has no read/export endpoint yet (belongs with F8/M6).
5. Facility rename/suspend (PATCH) and a UI for staff deactivation are not implemented (API exists for deactivation).
6. New UI strings are plain English, not yet routed through i18n.
7. Join links point at `/join/:orgSlug/:facilitySlug`, which is still a placeholder page (visitor flow is M2). The M0 stub route `/join/:facilitySlug` was replaced.
8. `.env.example` changed: `VITE_API_BASE_URL` is now empty (same-origin via proxy) and the Vite proxy target moved to `API_PROXY_TARGET`.
9. The `Secure` cookie flag is omitted only when `NODE_ENV=development`; Safari over plain-http localhost may need HTTPS in non-development modes.
10. Local DB used a separate Docker container (`queuebridge-pg`, port 55433); I did not touch another project's container that was running.

## Manual testing

```bash
docker start queuebridge-pg            # or any PostgreSQL 16+
export DATABASE_URL=postgres://postgres:password@localhost:55433/queuebridge
pnpm install && pnpm build && pnpm db:migrate
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
NODE_ENV=development pnpm dev:api      # (needs `pnpm build` first; API on :3002)
pnpm dev:web                           # http://localhost:5173
```

1. Open `/signup`, create an organization → you land on Administration.
2. Create a facility → open it → Services: add a service (try "urgent" class) → Counters: add a counter, tick the service → Overview: see counts, join link and QR (scan it with a phone).
3. Staff: invite an email as "Counter operator" → copy the link → open it in a private window → accept → confirm read-only UI (no Staff tab, no add forms).
4. Back as admin: add/remove a role for that member; revoke a pending invitation (the link then shows "Invitation unavailable").
5. Try `/admin/facilities/<id>` of another organization (sign up a second org in a private window) → "Facility not found".
6. Automated: `TEST_DATABASE_URL=... pnpm test:db` and `TEST_DATABASE_URL=... pnpm --filter @queuebridge/web test:e2e` (first run: `pnpm --filter @queuebridge/web exec playwright install chromium`).

---

# Refinement round after manual acceptance (all 10 workflows passed)

Full evidence: `docs/testing/M1-evidence.md` (second section). `tasks.md` has a new **M1.4** checklist.

## What changed

- **Wording:** slug fields are "Organization/Facility URL identifier (slug)" with hints.
- **Notifications:** dismissible visible toast (button, Escape, 8 s auto-dismiss) plus a separate hidden polite live region, so dismissal never removes the announcement.
- **Readiness (new API + UI):** `GET /api/v1/facilities/:id/readiness`; ready only when an active counter serves an active service in an active facility. Overview explains per service/counter. Join link/QR carry a "Not live yet — do not share" notice and the API reports `operational: false` until M2.
- **Policy display:** shows only enabled classes (or "Single queue").
- **Eligibility:** inactive services/counters never eligible; assignments on inactive counters remain editable and preserved.
- **Staff screen:** active vs deactivated vs pending vs history; read-only org-admin list; org-admin-only deactivate/reactivate with confirmation. RBAC unchanged (facility_admin cannot deactivate; tenant scoping unchanged).
- **Live sessions:** role and status changes proven immediate (API and browser); UI shows a "session ended" notice on 401.
- **Ports:** API default 3002; Vite proxy default 3002; docs/CI updated; E2E API on 3101.
- **Layout:** 80rem container with two-column workspace on desktop, single column on mobile.
- **Fix:** broken "finish setup" links (found by tests); stray command text removed from `.env.example`.

## Verified

format, strict lint, typecheck (8), build, unit (api 25, web 11, others unchanged), real-PostgreSQL 241, browser 42 at 1280/1440/375/320, audit (no high/critical), API reachable on :3002 beside Avroqen.

## Explicit deferrals

- M2: routing-engine eligibility tests and use of `computeReadiness` rules by the router; visitor registration; flipping `VISITOR_JOIN_OPERATIONAL`.
- Staff deactivation remains org-admin only by design; a delegated facility-level suspension is not implemented.
- Organization administrators are listed read-only; there is no UI to grant/revoke org_admin.
- Still open from the first M1 report: no invitation email delivery, in-memory per-IP rate limiting, no password reset/MFA, `admin_events` not hash-chained or exposed, no facility rename/suspend, new strings not yet in i18n, CI not run on GitHub.

## Unresolved risks

- Readiness is derived on request (no caching); fine at M1 scale, to be revisited if M2 polls it.
- The toast auto-dismisses at 8 s; users needing longer reading time rely on the live region and on page state (messages are not the only record of actions).
- `Secure` cookie and Safari-on-http caveat from the first report still applies.
- Working tree contains intent-to-add entries from an earlier `git add -N`; nothing is committed or staged for commit.

## Pre-PR review addendum

Full diff reviewed (no secrets/debug code/unrelated files). A race in the last-org-admin safeguard (two admins deactivating each other concurrently) was found and fixed with row locking, covered by 3 new real-PostgreSQL tests (244 total).

## PR #2 review fixes (Codex P2 ×3)

- Expired invitations are retired transactionally (audited) when a replacement is issued; pending ones still dedupe.
- Logout only completes after server confirmation; accessible failure notice with retry/dismiss.
- `useLoad` ignores stale, out-of-order and old-key responses.
- Tests: +7 DB, +9 unit, +7 browser. Totals: 251 DB, 49 Playwright. Evidence in `docs/testing/M1-evidence.md`.
