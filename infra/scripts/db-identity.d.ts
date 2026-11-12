import type { Sql } from 'postgres';

export type DatabaseKind = 'empty' | 'queuebridge' | 'legacy' | 'foreign' | 'inconsistent';

export interface Inspection {
  kind: DatabaseKind;
  database: string;
  applied: string[];
  pending: string[];
  reasons: string[];
}

export const PROJECT_ID: string;
export const MARKER_TABLE: string;
export const HISTORY_TABLE: string;
export const LOCK_KEY: string;
export const SENTINELS: Record<string, string[]>;

export function listMigrationFiles(dir: string): Promise<string[]>;
export function inspectDatabase(sql: Sql, files: string[]): Promise<Inspection>;
export function refusal(inspection: Inspection): string;
export function recordIdentity(sql: Sql, how: 'initialized' | 'adopted'): Promise<void>;
export function migrateDatabase(
  sql: Sql,
  opts: { dir: string; log?: (line: string) => void },
): Promise<{ kind: DatabaseKind; applied: string[] }>;
export function assertQueueBridge(
  sql: Sql,
  dir: string,
  opts?: { requireFullyMigrated?: boolean; allowEmpty?: boolean },
): Promise<Inspection>;
