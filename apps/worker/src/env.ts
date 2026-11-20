import { z } from 'zod';
import {
  AuditSigningKeyIdSchema,
  AuditSigningKeySchema,
  checkAuditSigningPair,
} from '@queuebridge/contracts';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// URL'),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
    /**
     * M6.1 SMS adapter: `off` (default: explicit safe disabled mode, the same default as the API)
     * or `sandbox` (TEST-ONLY, no network, refused in production). Any other value, and the
     * sandbox in production, disables SMS sending at startup with one error line; the worker and
     * every other job keep running (the same fail-safe rule as push). No live provider exists.
     */
    SMS_PROVIDER: z.string().trim().default('off'),
    /**
     * M6.1 hard cap on SMS handed to the provider per UTC day, deployment-wide, in the adapter's
     * mode (sandbox counted apart from live). 0 (the default) sends nothing. Use the API's value.
     */
    SMS_DAILY_CAP: z.coerce.number().int().min(0).max(1_000_000).default(0),
    SMS_API_KEY: z.string().optional(),
    /**
     * Not read by the worker: USSD is answered by the API (M6.2). Kept for configuration parity;
     * `off` like the API's default (the sandbox is never a default anywhere).
     */
    USSD_PROVIDER: z.string().trim().default('off'),
    USSD_WEBHOOK_SECRET: z.string().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Audit checkpoint signing (HMAC-SHA256). Without both, checkpointing is disabled — never unsigned. */
    AUDIT_SIGNING_KEY_ID: AuditSigningKeyIdSchema.optional(),
    /** Same rules as the API (shared schema): placeholders refused, paired with the id. */
    AUDIT_SIGNING_KEY: AuditSigningKeySchema.optional(),
    /** Checkpoint a session once this many events are unanchored... */
    AUDIT_CHECKPOINT_MIN_EVENTS: z.coerce.number().int().min(1).max(100_000).default(25),
    /** ...or once its oldest unanchored event is this old (or the session is closed). */
    AUDIT_CHECKPOINT_MAX_AGE_MS: z.coerce.number().int().min(1000).default(600_000),
    /**
     * M5.3 device health (same variables and ranges as the API; keep the values identical).
     * Evaluation runs at most every HEALTH_EVALUATION_INTERVAL_SECONDS.
     */
    DEVICE_STALE_AFTER_SECONDS: z.coerce.number().int().min(121).max(86_400).default(900),
    COORDINATOR_EXPIRY_WARN_SECONDS: z.coerce.number().int().min(30).max(7200).default(300),
    CONFLICT_REVIEW_WARN_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    HEALTH_EVALUATION_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /**
     * M5.4 Web Push (REQ-F14.10.3). All four are needed to SEND: the VAPID key pair and subject,
     * and CONTACT_ENCRYPTION_KEY to open the encrypted subscriptions. Missing or invalid values
     * never stop the worker: push sending is disabled (logged once) and every other job runs.
     * The private key lives in the worker environment only.
     */
    VAPID_PUBLIC_KEY: z.string().trim().optional(),
    VAPID_PRIVATE_KEY: z.string().trim().optional(),
    VAPID_SUBJECT: z.string().trim().optional(),
    CONTACT_ENCRYPTION_KEY: z.string().trim().optional(),
    TURN_ALERT_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    /**
     * `web` (default when VAPID is configured) or `sandbox` (TEST-ONLY, no network; refused in
     * production). `off` disables sending.
     */
    PUSH_TRANSPORT: z.enum(['web', 'sandbox', 'off']).optional(),
    /** Upper bound for a `--once` run before it exits with status 1 (default 120 s). */
    WORKER_ONCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(120_000),
    /**
     * The same extra push-service hosts as the API (comma-separated). The worker re-checks every
     * endpoint against the allow-list before each send (SSRF defence in depth).
     */
    PUSH_ENDPOINT_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => /^[a-z0-9.-]+$/.test(h)),
      ),
  })
  .superRefine(checkAuditSigningPair);

export type WorkerEnv = z.infer<typeof EnvSchema>;

export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const errors = result.error.issues.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Worker environment variable validation failed:\n${errors}`);
  }
  return result.data;
}
