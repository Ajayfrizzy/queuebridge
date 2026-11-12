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
    SMS_PROVIDER: z.string().default('sandbox'),
    SMS_API_KEY: z.string().optional(),
    USSD_PROVIDER: z.string().default('sandbox'),
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
