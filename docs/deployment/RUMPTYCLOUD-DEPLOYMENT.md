# QueueBridge managed deployment on RumptyCloud

Two independent **Web Service/Backend** deployments share one private persistent PostgreSQL 16+ database. The public deployment serves the production PWA and the existing Fastify routes on one HTTPS origin. The worker runs its existing polling loop continuously and serves only status probes. Configure the port in each deployment's Settings. RumptyCloud injects PORT and terminates HTTPS at its edge. [Managed ports and probes](https://docs.rumptycloud.com/deployments/ports/)

## Dockerfile deployment

Select the reviewed staging revision, **Web Service/Backend**, repository root (`.`) and build method **Dockerfile**. Inspect the preselected method after connecting GitHub. The documented location is `Dockerfile` in the selected root. The guide specifies no additional path field. If the dashboard offers one, enter `Dockerfile`. Clear custom build and start commands on the Web + API deployment so the image supplies its own CMD. Select port 8080 and readiness path `/health`; the listener uses the platform-injected PORT. Keep service secrets in runtime environment settings. [Build methods](https://docs.rumptycloud.com/deployments/create-a-deployment/) · [GitHub deployment settings](https://docs.rumptycloud.com/deployments/github-deploy/)

Railpack returned `no start command was set` despite receiving the launcher argument. This build uses a Node 24 Linux image, installs pnpm 9.15.9, builds the frozen workspace and checks the PWA bundle. The runtime runs as the node user, starts the TLS launcher as PID 1 and retains the compiled workspace, production dependencies and public CA at /app/apps/certs/queuebridge-ca.crt. Release and migration jobs continue to use the reviewed workspace independently.

Local commands from the repository root (supply runtime variables through a protected file outside the build context):

```sh
docker build -t queuebridge:managed-local .
docker run -d --name qb-web -p 127.0.0.1:8080:8080 --env-file "$QB_RUNTIME_ENV" -e PORT=8080 queuebridge:managed-local
curl -fsS http://127.0.0.1:8080/health
docker stop qb-web
docker inspect -f '{{.State.ExitCode}}' qb-web
```

An independently deployed worker may use this image if the platform supports overriding its command with `sh infra/rumptycloud/node-with-db-ca.sh apps/worker/dist/worker.js`. Give it its own environment, one continuously scheduled replica, and probe /health/ready. Verify the override before activating a worker. The default image command starts only Web + API. Retain prior hashed assets across updates and verify an old tab and installed service worker before release.

## PostgreSQL certificate delivery

Include the tracked public PEM file `apps/certs/queuebridge-ca.crt` and `infra/rumptycloud/node-with-db-ca.sh` in both workspace artifacts and in the controlled migration runner. The start commands above resolve the physical release root and export `NODE_EXTRA_CA_CERTS=<absolute release root>/apps/certs/queuebridge-ca.crt` before Node starts. A literal dashboard path or shell expression in the dashboard is unnecessary. On certificate rotation, verify the replacement against the Database Connection download, rebuild both artifacts and restart both processes.

Set each role's secret DATABASE_URL to the provider-supplied DNS endpoint with exactly one `sslmode=verify-full`. The API, worker and migrator use postgres.js, which sends the DNS hostname to Node TLS. To check the runtime path and fingerprint inside an authorized release runner, run:

```sh
sh infra/rumptycloud/node-with-db-ca.sh --input-type=module -e 'import {readFileSync} from "node:fs"; import {X509Certificate} from "node:crypto"; const p=process.env.NODE_EXTRA_CA_CERTS; console.log(p,new X509Certificate(readFileSync(p)).fingerprint256)'
```

Use `sh infra/rumptycloud/node-with-db-ca.sh infra/scripts/migrate.js --check` for a read-only database identity check. Applying migrations remains a separate, explicitly authorized release step. For libpq backup and restore tools, set sslrootcert to the same absolute PEM path in the service profile and require sslmode=verify-full.

## Service environment and ingress

| Owner             | Variables and placement                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each runtime      | NODE_ENV=production, platform PORT, separate scoped DATABASE_URL credentials, NODE_EXTRA_CA_CERTS pointing at the approved DB CA file, LOG_LEVEL. Use internal DB hostname and sslmode=verify-full. Confirm hostname and CA acceptance and rejection with a wrong CA.                                                                                                                                               |
| Both              | Match AUDIT_SIGNING_KEY_ID, AUDIT_SIGNING_KEY, CONTACT_ENCRYPTION_KEY, TURN_ALERT_TTL_SECONDS, push endpoint allowlist, VAPID_PUBLIC_KEY and device-health thresholds. Keep recoverable secrets outside build logs and artifacts.                                                                                                                                                                                   |
| Web + API         | SESSION_SECRET, coordinator signing configuration, WEB_BASE_URL and CORS_ORIGIN equal the public HTTPS origin. Empty VITE_API_BASE_URL at build. Preserve CSRF header, secure cookies and application rate limits. Keep TRUST_PROXY=false until the workspace proves direct-origin isolation and sanitization of client-supplied forwarded headers. Shared-edge IP quotas and spoofable headers both block release. |
| Worker only       | VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_TRANSPORT=web for configured push. WORKER_POLL_INTERVAL_MS controls idle delay. A pass with a job error clears readiness. A stalled loop expires its previous successful timestamp after poll interval plus WORKER_ONCE_TIMEOUT_MS. Allow enough shutdown grace for a full active pass. Keep alerts for outbox lag, failed/unknown results, leases and checkpoint age.       |
| Channels and help | Production SMS_PROVIDER=off, USSD_PROVIDER=off, QUE_AI_ADAPTER=disabled. Test sandbox behavior only in an isolated test environment. Keep deployment capabilities and visual/in-app alerts truthful when optional providers are unavailable.                                                                                                                                                                        |
| Operator jobs     | DDL, backup, restore and demo credentials scoped to each explicitly invoked operation. Revoke access when finished.                                                                                                                                                                                                                                                                                                 |

The public entry streams only registered build files with the repository security headers. It serves current client routes with index.html, returns 404 for missing assets and routes /api to the existing handlers. Hashed assets are immutable. HTML, sw.js, registerSW.js, manifests and push handlers revalidate. Browser HTTP traffic and ordinary probes do not schedule worker jobs. Treat provider receipts and actual delivery as separate signals. [Environment template](../../.env.example) · [Web header contract](web-security-headers.md)

## Release, monitoring and rollback

1. Record a release manifest containing both component SHAs, build identities, expected schema migrations and outbox compatibility. Disable independent automatic activation on push or establish an equivalent manual promotion gate. Stop if the workspace cannot enforce the required ordering and worker shutdown grace.
2. After explicit provisioning approval, create the private DB in the same workspace. Confirm durable storage, version, pgcrypto, least-privilege roles, pool capacity, LISTEN/NOTIFY, internal DNS and verified TLS. Restrict public connectivity. [Database connection controls](https://docs.rumptycloud.com/databases/connecting/)
3. Use a controlled release runner with authorized private connectivity to the DB (for example an approved CI runner on the private network). Supply the reviewed workspace and the migration role only. Run `sh infra/rumptycloud/node-with-db-ca.sh infra/scripts/migrate.js --check`, inspect identity and pending SQL, take the encrypted backup, run `sh infra/rumptycloud/node-with-db-ca.sh infra/scripts/migrate.js` once and recheck for zero pending. Use the same private-runner model for scheduled backups and isolated restores. Confirm connectivity before selecting that runner.
4. Quiesce writes and allow existing worker work to finish for an incompatible change. Verify the old worker stopped. Activate web/API at the approved SHA, verify /health, public /health/ready returning 404, cookie login, CSRF and DB-backed functionality. Activate the exact compatible worker SHA, verify /health/ready and actual outbox progress. Allow writes after compatibility checks. A rolling mixed-version release requires explicit evidence of forward/backward schema and message compatibility.
5. Verify real HTTPS headers, sanitized forwarded IPs from two clients, public and authenticated SSE heartbeats, prompt updates, reconnect, offline coordinator cold restart and duplicate replay. Verify push fallback and Ask Que offline. Check logs for sensitive headers, credentials, bodies and query strings before export. Exercise worker restart with pending work and no incoming user traffic. Record shutdown duration, pending/leased rows and processing results.
6. On failure stop promotion and quiesce writers. Stop the new worker and select the prior compatible pair by recorded SHA. Restore web/API then worker and repeat the checks. Retain old static chunks for open clients. For an incompatible schema use a reviewed forward fix or separately approved restore to a fresh DB. Reconcile the loss interval, external receipts, idempotency records and offline coordinator fencing before resuming writes.

## Encrypted backups and recovery

RumptyCloud's dedicated database guide assigns recovery to the operator. Obtain approval for RPO, RTO, retention, backup cadence, destination in an independent failure domain, key custody and restore ownership. Monitor archive freshness and successful off-host transfer. Keep historic audit/contact keys and grants separately recoverable. [Database backups](https://docs.rumptycloud.com/databases/backups/)

Use matching PostgreSQL major-version clients and OpenSSL 3 CMS. With a restricted source libpq service, public RSA encryption certificate and private spool directory, schedule `PGSERVICE=qb_backup BACKUP_CERT=/etc/queuebridge/backup-public.pem bash infra/rumptycloud/backup.sh /private-spool/<unique-release-and-time>.cms`. The script streams a consistent custom dump through AES-256-GCM encryption and publishes only a complete new file. Copy ciphertext and its checksum to approved private storage, verify the remote checksum, and alert on any failure. Retain the prior known-good archive. Protect the archive store against replacement or deletion by the writer.

To rehearse or recover, provision a **new empty isolated database**, disable outbound notification delivery and isolate all application writers. Verify destination identity, source checksum and key custody. Use an encrypted scratch volume with umask 077. Decrypt fully before giving pg_restore access to the plaintext. Only proceed on successful OpenSSL authentication.

```sh
set -eu
umask 077
openssl cms -decrypt -binary -inform DER -in "$ARCHIVE" -recip "$CERT" -inkey "$PRIVATE_KEY" -out "$PRIVATE_SCRATCH/restore.dump"
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname="service=qb_fresh_restore" "$PRIVATE_SCRATCH/restore.dump"
```

Reapply approved ownership and role grants separately. With DATABASE_URL pointing at this fresh DB, check migration identity and count, compare table counts and checkpoint hashes to the source snapshot, verify the audit chain, tenant isolation and sample decryption. Destroy the private scratch volume after verification. Record snapshot time and elapsed recovery time against the approved objectives. A failed drill stays isolated.

## Preparing a demonstration tenant

After explicit authorization for the named environment, build the release and run the standalone operator command from its root. Supply DATABASE_URL and the validated API environment through the release operator's protected environment. Set DEMO_DATABASE_NAME to the independently confirmed database name. Inject distinct DEMO_ADMIN_PASSWORD and DEMO_STAFF_PASSWORD through a private credential manager or silent terminal prompts. Avoid command-line password arguments and shell tracing. The startup units never invoke this command.

```sh
node infra/scripts/demo.js seed
```

The organization slug is `willow-crossing-demo`. Use normal sign-in with `admin@example.invalid` (organization administrator) or `counter@example.invalid` (facility counter staff). The first facility is Willow Reception at `/join/willow-crossing-demo/reception-1`. Consultation and Registration each have a service, counter and current-day queue. Fixtures include waiting and called tickets and an offline intake command replayed through reconciliation. Returning to the seed reports the current facility ID without issuing new credentials or changing queues. On later days, open today's queues through the normal console or use an explicitly authorized fresh scenario.

**Reset means a fresh facility in the same demonstration organization.** Confirm there is no active demo session or outstanding offline work before rotating. Obtain the current marked facility ID from the seed, authenticate with the same operator-supplied demo credentials and run `node infra/scripts/demo.js reset "$CURRENT_DEMO_FACILITY_ID"`. The command retires the prior facility and creates the next reception address. Distribute the new join link. Old journal entries, ticket history and facility roles remain available for audit. The new generation, account checks and previous facility status commit together. The operator lock serializes concurrent invocations. A stale ID, unmarked slug collision or failed account verification prevents the reset.
