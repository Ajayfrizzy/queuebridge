import { z } from 'zod';

/**
 * Environment variable schema for apps/api.
 * Validated at startup — missing required variables prevent the server from starting.
 */
const EnvSchema = z.object({
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
  AUDIT_SIGNING_KEY_ID: z.string().min(1).optional(),
  AUDIT_SIGNING_KEY: z.string().min(1).optional(),
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
  /** Set true only when running behind a trusted reverse proxy (honours X-Forwarded-For). */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

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
