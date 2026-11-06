import { z } from 'zod';

/**
 * Environment variable schema for apps/api.
 * Validated at startup — missing required variables prevent the server from starting.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
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
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
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
