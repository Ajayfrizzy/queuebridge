# RumptyCloud managed configuration implementation

**Recommendation: stage for review; hold hosted activation.** The accepted candidate is one managed Web Service/Backend for the PWA and API, an independent single-replica worker deployment, and private PostgreSQL 16+. Both processes accept the platform port. Settings, environment ownership, operator jobs and release order are in the [managed deployment runbook](../deployment/RUMPTYCLOUD-DEPLOYMENT.md).

## Managed adaptation inventory

- Added infra/rumptycloud/web.mjs to serve the built site, SPA routes and existing API from one Fastify listener.
- Updated apps/api/src/app.ts with an opt-out for the DB diagnostics route used only by the managed entry.
- Updated apps/worker/src/env.ts and apps/worker/src/worker.ts for optional managed PORT, loop progress, minimal probes and interruptible idle shutdown.
- Updated infra/scripts/demo.js to print the current join path alongside its facility ID. The seed, credential checks and rotation transaction remain as previously verified.
- Updated docs/deployment/RUMPTYCLOUD-DEPLOYMENT.md and this report. Retained infra/rumptycloud/backup.sh.
- Removed the three uncommitted VM artifacts infra/rumptycloud/Caddyfile, infra/rumptycloud/queuebridge-api.service and infra/rumptycloud/queuebridge-worker.service.

## Local managed verification

Built and launched both managed entrypoints separately on loopback-accessible ports with NODE_ENV=production and a disposable TLS-enabled PostgreSQL 16 server. A self-signed certificate without a trusted CA was rejected. With the correct NODE_EXTRA_CA_CERTS and sslmode=verify-full, migrations and both services succeeded.

| Check              | Result                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, API and PWA   | 200 on /, join, ticket, recovery, staff, admin, manifest, sw.js and /health. Missing asset, missing API and /health/ready returned 404. Checked CSP, immutable entry asset and sw.js no-cache. Real organization login issued Secure, HttpOnly, SameSite=Strict and the cookie retrieved /api/v1/auth/me. Public facility stream delivered ready and heartbeat during a bounded 23-second connection. |
| Worker             | Started without user traffic. Healthy pass produced 200 readiness. Temporarily making the outbox table unavailable in the disposable DB gave 503 on readiness while liveness stayed 200. Restoring the table recovered readiness. SIGTERM exited cleanly and a fresh worker returned ready.                                                                                                           |
| Outbox invariants  | Existing worker PostgreSQL suites src/sms-alerts.db.test.ts and src/turn-alerts.db.test.ts passed all 63 tests in 3.88 seconds, including interrupted attempts, lease reclaim and duplicate prevention. The process restart probe and populated-outbox logic tests were separate exercises.                                                                                                           |
| Demo               | Created synthetic accounts, repeated seed returned the same facility, authorized reset printed the new generation-two join path and facility ID. Old ID was rejected.                                                                                                                                                                                                                                 |
| Encrypted recovery | Matching PostgreSQL 16 tools, CMS encryption and authenticated decryption, single-transaction restore into a separate DB. Complete ordered row digests matched across 44 tables. Both accounts authenticated and application audit verification checked the queue chains on source and restore.                                                                                                       |
| Static gates       | Repository formatting, lint, typecheck and production build passed.                                                                                                                                                                                                                                                                                                                                   |

Hosted acceptance remains open for origin TLS, forwarded client attribution, proxy buffering, real browser offline upgrades and old chunk retention, runtime CA injection, rollout ordering, worker grace/overlap, no-traffic scheduling, private operator connectivity, off-host backup custody and physical-device push. Rehearse a two-version release and rollback before production. The strict visitor budget remains open.

## Historical preflight evidence

The following records the earlier VM candidate and disposable exercises. The managed runbook above supersedes its release disposition and inventory.

Prepared on feature/m7-rumptycloud-deployment against 0ebda6a. The selected candidate uses a directly reachable Caddy HTTPS proxy, static React PWA, separate systemd-managed API and worker on the same Linux VM, and workspace-private managed PostgreSQL. Public documentation establishes the VM transfer interface and proxy support. The target workspace has yet to demonstrate private database routing, verified TLS and probe access. The release procedure, environment matrix, hosted acceptance worksheet and rollback gates are in the [deployment runbook](../deployment/RUMPTYCLOUD-DEPLOYMENT.md).

| File                                                     | Purpose                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| infra/rumptycloud/Caddyfile                              | Same-origin HTTPS, public liveness, private readiness policy, streaming and static cache rules |
| infra/rumptycloud/queuebridge-api.service                | Independent supervised Fastify service with API-only environment                               |
| infra/rumptycloud/queuebridge-worker.service             | Independent supervised portless notification worker with separate service identity             |
| infra/rumptycloud/backup.sh                              | Custom-format logical backup encrypted to the recovery custodian's public certificate          |
| docs/deployment/RUMPTYCLOUD-DEPLOYMENT.md                | Release, migration, recovery, environment and hosted verification instructions                 |
| docs/reports/RumptyCloud-configuration-implementation.md | Local evidence and limits                                                                      |

## Local results

- Repository lint, typecheck, formatting and production build passed. The existing bundle check passed at 137,511/7,251 gzip bytes for entry JS/CSS and 24,739/3,044 for landing JS/CSS. The strict visitor budget remains open.
- `pnpm --filter @queuebridge/web exec vitest run src/pwa` passed 20 tests. `pnpm --filter @queuebridge/worker exec vitest run src/env.test.ts` passed 11.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities with registry access. The initial sandbox attempt could not resolve the registry. `node infra/scripts/audit-gate.js` passed.
- Caddy 2.10.2 Alpine validated the checked-in Caddyfile with a synthetic hostname. It warned that two explicit forwarding headers duplicate defaults. Using the built PWA with QB_HOST=localhost and a trusted disposable local CA, an HTTPS HTML navigation to /join/demo/clinic returned 200 HTML, /sw.js returned 200 JavaScript, and /assets/missing.js and /health/ready both returned 404. This test exercised the static and readiness-denial paths. Upstream API/SSE streaming and client IP identity still need an end-to-end ingress test.
- A disposable PostgreSQL 16 source received 13 migrations. A logical dump from the source went through the backup script, OpenSSL CMS AES-256-GCM encryption and decryption, and a single-transaction restore to a different newly created database. An initial restore with newer host client tools attempted to set transaction_timeout, unsupported by PostgreSQL 16. Using PostgreSQL 16 clients for both operations succeeded. The restored DB reported 44 public tables and all 13 migrations applied with none pending. The drill covered schema and migration records. Representative business data, audit chains, receipt reconciliation and timed recovery objectives still require a populated staging drill.

## Release disposition

Configuration is ready for owner review. The new service units require validation on the selected Linux VM image. The private DB CA, extension privileges, grants and connection limits, DNS/TLS termination, firewall and probe identities, retention and encrypted off-host backup destination require workspace confirmation. Rollback and live smoke verification require a separately approved staging exercise. The existing hosted CI, physical-device acceptance and strict visitor payload gates retain their prior status. All commands in this assessment used local tools or disposable local containers.

## Populated preflight and demonstration accounts

Reviewed the Caddyfile, both independent service units, backup script, runbook and earlier evidence. The configuration contains service paths and environment variable names. The demonstration seeder embeds fictional identities only. The example credentials in the legacy development fixture are unsuitable for this use. The new explicitly invoked `infra/scripts/demo.js` uses the built Fastify application's real signup, invitation, login, queue command and sync handlers against PostgreSQL. Each nested route transaction is a savepoint in one tenant-specific operator transaction. The new runbook explains fresh-scenario reset and CLI release/rollback.

On a disposable PostgreSQL 16 instance, first seed succeeded, repeat seed returned the same facility, an unrelated facility ID was refused, and invalid staff credentials caused rollback with exactly one original facility remaining. Authorized reset created generation two and marked generation one inactive. Replaying the old reset ID was refused. A separate sentinel organization received no facility. Both generations included a committed offline intake and duplicate replay.

An encrypted custom-format dump was restored into a second newly created DB using matching PostgreSQL 16 tools. All 44 public tables matched by row count and SHA-256 of ordered complete JSON rows before either verification login. This included 2 organizations (demo plus sentinel), 2 users, 3 role assignments, 2 facilities, 4 services, 4 counters, 4 queue sessions, 6 tickets, 8 ticket transitions, 12 queue events, 8 client operation records, 23 administrative events and 13 migrations. The application's audit verifier validated the chains of all four queues in both databases. Real password login succeeded for both accounts with the expected roles in both databases. No signed checkpoints or external delivery receipts were present in this dataset.

Local HTTPS against the built PWA and real Fastify API returned 200 on demo join, public catalog and /health, and 404 on /health/ready. Caddy forwarded the public SSE ready event and heartbeat during a deliberately time-limited 23-second connection. The test substituted the Docker-to-host upstream socket address for the VM loopback address. Independent restarts, hosted client attribution, private TLS and off-host retrieval remain provisioned-environment checks. Repository format, lint, typecheck and build were run for this preflight.
