import postgres, { type Sql } from 'postgres';
import type { Env } from './env.js';

/** Shared SQL client type. All queries use tagged-template parameters — never string concatenation. */
export type Db = Sql;

export function createDb(env: Env): Db {
  return postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'test' ? 5 : 10,
    connect_timeout: 5,
    idle_timeout: 30,
    // Suppress NOTICE output (e.g. idempotent migration messages)
    onnotice: () => undefined,
  });
}
