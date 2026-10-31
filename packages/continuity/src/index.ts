/**
 * @queuebridge/continuity
 *
 * Offline command schema, reconciliation logic, and coordinator authority checks.
 * No I/O, no direct database calls.
 *
 * Import boundaries:
 * - MAY import: @queuebridge/contracts, @queuebridge/domain
 * - MUST NOT import: any DB client, HTTP library, IndexedDB directly, or apps/api
 */

export * from './authority.js';
export * from './reconcile.js';
