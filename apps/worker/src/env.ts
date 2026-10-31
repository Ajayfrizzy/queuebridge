import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// URL'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  SMS_PROVIDER: z.string().default('sandbox'),
  SMS_API_KEY: z.string().optional(),
  USSD_PROVIDER: z.string().default('sandbox'),
  USSD_WEBHOOK_SECRET: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type WorkerEnv = z.infer<typeof EnvSchema>;

export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Worker environment variable validation failed:\n${errors}`);
  }
  return result.data;
}
