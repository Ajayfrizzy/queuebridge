import { z } from 'zod';
import {
  AuditSigningKeyIdSchema,
  AuditSigningKeySchema,
  checkAuditSigningPair,
} from '@queuebridge/contracts';

/**
 * Environment variable schema for apps/api.
 * Validated at startup — missing required variables prevent the server from starting.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// URL'),
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters (use a random hex string)'),
    CONTACT_ENCRYPTION_KEY: z
      .string()
      .length(64, 'CONTACT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
      .optional(),
    AUDIT_SIGNING_KEY_ID: AuditSigningKeyIdSchema.optional(),
    /**
     * HMAC key the worker signs checkpoints with; the API needs the SAME key to verify them.
     * Placeholders are refused; id and key come as a pair; required in production.
     */
    AUDIT_SIGNING_KEY: AuditSigningKeySchema.optional(),
    /**
     * HMAC key for signing offline coordinator authority. Optional: when unset, a key is derived
     * from SESSION_SECRET with a fixed domain separator. Set it to rotate coordinator signing
     * independently of sessions (existing tokens then stop verifying and are re-issued on next
     * snapshot).
     */
    COORDINATOR_SIGNING_KEY: z.string().min(32).optional(),
    /** Largest session a single redacted audit export may hold (larger ones are refused, never cut). */
    AUDIT_EXPORT_MAX_EVENTS: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
    /** Comma-separated list of allowed browser origins (CORS + CSRF origin check). */
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    /** Public origin of the web app; used to build join links. */
    WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
    /** Max requests per minute per client IP on unauthenticated auth endpoints. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    /** Max visitor joins per minute per client IP (clinic Wi-Fi is shared: keep this generous). */
    JOIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
    /** Max public reads (catalog, board, ticket status) per minute per client IP. */
    PUBLIC_READ_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(240),
    /** Max staff queue commands / walk-ins per minute per client IP. */
    COMMAND_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(240),
    /**
     * M5.1 (REQ-F4.10, L1): ticket-recovery attempts per request source per minute. Every
     * attempt counts, including malformed ones. Shared by all API instances (stored in the DB).
     */
    RECOVERY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(10),
    /**
     * M5.1 (REQ-F4.14): interval of the automatic no-show sweep. The feature itself is off for
     * every service unless enabled in its policy. 0 disables the sweep in this process.
     */
    AUTO_MISS_SWEEP_SECONDS: z.coerce.number().int().min(0).max(3600).default(15),
    /**
     * M5.3 (REQ-F9.6, F9.7): device-health thresholds, by server time. The worker reads the same
     * variables; keep the values identical for both (see .env.example).
     */
    DEVICE_STALE_AFTER_SECONDS: z.coerce.number().int().min(121).max(86_400).default(900),
    COORDINATOR_EXPIRY_WARN_SECONDS: z.coerce.number().int().min(30).max(7200).default(300),
    CONFLICT_REVIEW_WARN_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    /** Interval of the worker's health evaluation; 3 missed intervals = "alerts are paused" */
    HEALTH_EVALUATION_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /**
     * M5.4 Web Push (REQ-F14.10.3). The capability is `live` only with a valid VAPID public key
     * AND CONTACT_ENCRYPTION_KEY (subscriptions are stored encrypted). The PRIVATE key belongs to
     * the worker only and is never read by the API. Absent or invalid: push is `disabled`, the
     * API still starts, and the in-app alert works as always.
     */
    VAPID_PUBLIC_KEY: z.string().trim().optional(),
    /** Active push subscriptions per ticket (design §12.12: default 3) */
    PUSH_MAX_SUBSCRIPTIONS_PER_TICKET: z.coerce.number().int().min(1).max(10).default(3),
    /** Push TTL in seconds (default 120); the worker enforces it, the API only reports it */
    TURN_ALERT_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    /**
     * Extra push-service host suffixes accepted for subscription endpoints (comma-separated), in
     * addition to the major browsers' push services. Anything else is refused (SSRF defence).
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
    /**
     * MQ.2 (design §11.5.2): longest offline validity of a restricted Ask Que bundle, in seconds.
     * The server always caps it at the session's remaining lifetime; default = session (12 h).
     */
    QUE_OFFLINE_HELP_TTL_SECONDS: z.coerce.number().int().min(300).max(43_200).default(43_200),
    /** Set true only when running behind a trusted reverse proxy (honours X-Forwarded-For). */
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine(checkAuditSigningPair);

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment variables.
 * Throws with a descriptive message if any required variable is missing or invalid.
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const errors = result.error.issues.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Environment variable validation failed:\n${errors}`);
  }
  return result.data;
}

/** Parse CORS_ORIGIN into a list of normalised origins. */
export function allowedOrigins(env: Env): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);
}
