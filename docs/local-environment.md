# Local environment (development only)

How to configure, load and verify the QueueBridge environment on a developer machine, and how to
run database changes safely. Secrets are generated locally, live only in the gitignored `.env`
(mode 600) and are never printed, logged, pasted into chat or written into documentation.

## 1. Database container

QueueBridge uses its own disposable PostgreSQL container, `queuebridge-pg`, published on
**`localhost:55433`** (databases `queuebridge` for development and `queuebridge_test` for tests).
Other projects on the same machine have their own containers and ports (for example
`localhost:55432`) — never point QueueBridge at them. `docker start queuebridge-pg` if it stopped.

The migration, seed and reset scripts refuse any database they cannot positively identify as
QueueBridge (section 5), so a mistyped port cannot change another project's schema — but the
correct URLs are still required:

```
DATABASE_URL=postgres://<user>:<password>@localhost:55433/queuebridge
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:55433/queuebridge_test
```

## 2. Secrets

```bash
cp -n .env.example .env          # only if .env does not exist yet
pnpm env:generate                # fills SESSION_SECRET, CONTACT_ENCRYPTION_KEY, AUDIT_SIGNING_KEY
```

`env:generate` (`infra/scripts/local-env.js generate`):

- replaces a value only when it is missing, a placeholder or invalid — valid values are kept
  (`--rotate` replaces them all **except** `CONTACT_ENCRYPTION_KEY`, which needs its own
  `--rotate-contact-key` flag because rotating it makes stored encrypted contacts unreadable);
- uses 32 random bytes (64 hex characters) from `crypto.randomBytes` for each secret;
- **always sets a new `AUDIT_SIGNING_KEY_ID` (`local-dev-YYYYMMDD-xxxx`) when it sets a new audit
  key**, so checkpoints signed with an old key are reported `incomplete`, never as tampering;
- rewrites `.env` atomically with mode 600 and prints only variable names and actions.

To set a value by hand instead, generate it straight into your editor's clipboard
(`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | pbcopy`)
and paste it into `.env`; do not echo it in a terminal you share or record.

| Variable                             | Rule                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `SESSION_SECRET`                     | ≥ 32 characters, random                                                    |
| `CONTACT_ENCRYPTION_KEY`             | exactly 64 hex characters (32 bytes)                                       |
| `AUDIT_SIGNING_KEY`                  | ≥ 32 characters, random; placeholders refused by API and worker            |
| `RECOVERY_RATE_LIMIT_MAX`            | optional, 1–1000 (default 10): recovery attempts per minute per source     |
| `AUTO_MISS_SWEEP_SECONDS`            | optional, 0–3600 (default 15; 0 disables the sweep in this process)        |
| `DEVICE_STALE_AFTER_SECONDS`         | optional, 121–86400 (default 900); API **and** worker, same value          |
| `COORDINATOR_EXPIRY_WARN_SECONDS`    | optional, 30–7200 (default 300); API **and** worker                        |
| `CONFLICT_REVIEW_WARN_SECONDS`       | optional, 60–86400 (default 900); API **and** worker                       |
| `HEALTH_EVALUATION_INTERVAL_SECONDS` | optional, 5–3600 (default 30); API **and** worker                          |
| `AUDIT_SIGNING_KEY_ID`               | required whenever the key is set (and vice versa); letters, digits, `._:-` |
| `VAPID_PUBLIC_KEY`                   | optional (M5.4 push); P-256 public key, base64url; API **and** worker      |
| `VAPID_PRIVATE_KEY`                  | optional; matching private key, base64url; **worker only** in production   |
| `VAPID_SUBJECT`                      | worker; `mailto:` or `https:` contact of whoever runs the server           |
| `PUSH_TRANSPORT`                     | worker; `web` (default when VAPID is set), `sandbox` (test only), `off`    |
| `TURN_ALERT_TTL_SECONDS`             | optional, 30–3600 (default 120); API **and** worker                        |
| `PUSH_MAX_SUBSCRIPTIONS_PER_TICKET`  | optional, 1–10 (default 3); API                                            |
| `PUSH_ENDPOINT_HOSTS`                | optional; extra push-service hosts (comma-separated); API **and** worker   |
| `WORKER_ONCE_TIMEOUT_MS`             | optional, 1000–3600000 (default 120000): bound of a `worker --once` run    |

Since M5.1, `CONTACT_ENCRYPTION_KEY` also seeds the ticket-recovery secrets (HKDF-derived, one per
purpose: recovery key, staff grant, throttle). Without it self-service recovery is disabled rather
than weakened. **Rotating it invalidates every outstanding recovery key and grant** (visitors can
make a new key from their ticket page; staff can use the assisted procedure).

The API and the worker must use the SAME id and key: the worker signs checkpoints, the API
verifies them. Using one `.env` for both guarantees it; section 4 proves it.

### Web Push turn alerts (M5.4, optional)

The in-app turn alert needs no configuration. Web Push is an optional extra layer:

```bash
pnpm env:generate --vapid        # creates VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if missing
# then add a contact yourself, e.g. VAPID_SUBJECT=mailto:you@your-organization.example
pnpm build && pnpm env:check     # validates that the pair matches and the subject is a URL
```

- The API needs only `VAPID_PUBLIC_KEY` (it gives it to browsers) and `CONTACT_ENCRYPTION_KEY`
  (subscriptions are stored encrypted under a key derived from it). The private key belongs to
  the worker; in production give it to the worker process only.
- Missing or invalid keys never stop a process: the API reports push as `disabled` (the page
  offers no push button) and the worker logs one error and runs its other jobs.
- `--rotate-vapid` replaces an existing pair. Every browser subscription is bound to the old
  public key, so every visitor would have to turn push on again; open tickets keep the in-app
  alert.
- `PUSH_TRANSPORT=sandbox` is a TEST-ONLY transport that sends nothing (refused in production).
- Endpoints are accepted only for the browsers' push services (Google FCM, Mozilla, Apple, Microsoft
  WNS). `PUSH_ENDPOINT_HOSTS` adds hosts; the browser tests use the fictional `push.sandbox.test`.
- The dashboard warns when the worker and the API disagree on a shared setting (the M5.3
  thresholds, the VAPID public key), naming the settings only.

## 3. Loading the environment into each terminal

The apps read **only the process environment** — nothing loads `.env` automatically (there is no
dotenv). In every terminal, before starting anything:

```bash
cd /path/to/queuebridge
set -a; source .env; set +a
```

| Terminal | Command                                                                  | Reads                                            |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| API      | `pnpm dev:api` (runs `apps/api/dist`, so `pnpm build` first)             | `DATABASE_URL`, secrets, `AUDIT_*`, `PORT`, CORS |
| Frontend | `pnpm dev:web`                                                           | `API_PROXY_TARGET`, `VITE_*` from the shell      |
| Worker   | `pnpm dev:worker`, or one pass: `node apps/worker/dist/worker.js --once` | `DATABASE_URL`, `AUDIT_*`, checkpoint thresholds |
| Scripts  | `pnpm db:check`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm env:check`     | `DATABASE_URL`                                   |

A running process keeps the environment it was started with: after changing `.env`, **restart**
the API and the worker (and re-run `source`) — otherwise they keep old keys or URLs.

## 4. Verify before testing

```bash
pnpm build
pnpm env:check        # never prints values
```

It validates `.env` with the API's and the worker's own parsers, confirms both load the same audit
key (same id, same fingerprint computed by each app's code), shows each database target as
`host:port/name` only, and inspects both databases read-only. It ends with `READY` or
`NOT READY` (exit code 1) and the reason. At runtime both processes log `audit_key_id` and
`audit_key_fingerprint` at startup — they must match each other and `env:check`.

## 5. Database changes: identity guard

`pnpm db:migrate`, `pnpm db:seed` and `pnpm db:reset` inspect the target BEFORE any change
(`infra/scripts/db-identity.js`); identity never depends on host, port or database name:

| Database state                                                                                                                               | Result                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| empty (no objects at all)                                                                                                                    | migrate initializes it and records the marker |
| `_queuebridge_identity` marker + consistent history                                                                                          | migrated                                      |
| no marker (created before the guard) but history is a consistent prefix of this checkout and every recorded migration's tables/columns exist | migrated; marker recorded (`adopted`)         |
| objects but no QueueBridge marker/history (another project)                                                                                  | **refused, unchanged**                        |
| marker naming another project                                                                                                                | **refused, unchanged**                        |
| gaps, unknown (newer) migrations, missing objects, marker without history                                                                    | **refused, unchanged — never repaired**       |

`pnpm db:check` reports the state without changing anything. Seed additionally requires a fully
migrated database; reset refuses anything but an empty or identified QueueBridge database. Each
migration commits atomically with its history row, under an advisory lock (concurrent runners
wait instead of racing). Test setup uses the same guard.

### Applying a new migration to the existing development database (e.g. 0006)

```bash
set -a; source .env; set +a
pnpm db:check                               # expect: queuebridge or legacy, pending: 0006_…
# stop dev:api / dev:worker that use this database, then back it up outside the repository:
mkdir -p ~/queuebridge-backups && chmod 700 ~/queuebridge-backups
docker exec queuebridge-pg pg_dump -U postgres -Fc queuebridge \
  > ~/queuebridge-backups/queuebridge-$(date +%Y%m%d-%H%M%S).dump
chmod 600 ~/queuebridge-backups/*.dump
pnpm db:migrate
pnpm db:check                               # expect: queuebridge, applied 6, pending none
```

If `db:check` reports `foreign` or `inconsistent`, stop: check `DATABASE_URL`; do not edit
`_migrations` by hand. To roll back, restore the dump into a NEW database and compare
(`docker exec queuebridge-pg createdb -U postgres queuebridge_restore` then
`docker exec -i queuebridge-pg pg_restore -U postgres -d queuebridge_restore < <dump>`).
Backups contain development data (including password hashes): keep them outside the repository.

## 6. Accounts for manual acceptance

Refusal checks need accounts with ONE role each; the seeded `admin@demo.local` holds every role.
Create them through the application, never by inserting rows:

1. Sign up an organization at `/signup` (or reuse one whose admin password you know).
2. Administration → facility → Services / Counters: add a service and two counters serving it.
3. Administration → facility → Staff → invite `staff_counter`, `supervisor` and `auditor`. Each
   invitation link is shown once; open it in a private window, set a display name and password.

Credentials you create belong in a private file outside the repository (e.g.
`~/.config/queuebridge/`, mode 600), never in documentation or commits.

## 7. Audit checkpoints

```bash
AUDIT_CHECKPOINT_MIN_EVENTS=1 node apps/worker/dist/worker.js --once
```

Expect `Audit checkpoints enabled` (id + fingerprint, matching the API), `Worker started`
(`database`, `latest_migration: 0006_fairness_routing_audit.sql`), `Audit checkpoints written`,
`Worker run complete`. The worker exits 1 and writes nothing on a placeholder key, an incomplete
id/key pair, or a database that is not a migrated QueueBridge database.
