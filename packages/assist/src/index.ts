/**
 * @queuebridge/assist — Ask Que deterministic core (F13, MQ.1; ADR-011, design §11).
 *
 * Route/screen registry, audience and permission helpers, capability gating, keyword search and
 * the deterministic answer builder. Read-only and pure: no network, no database, no storage, no
 * inference, no clock.
 *
 * Import boundaries:
 * - MAY import: @queuebridge/contracts
 * - MUST NOT import: any app, DB client, network or Node I/O, or another @queuebridge package
 */
export * from './audiences.js';
export * from './registry.js';
export * from './operations.js';
export * from './links.js';
export * from './capabilities.js';
export * from './search.js';
export * from './answer.js';
export * from './kb-compile.js';
