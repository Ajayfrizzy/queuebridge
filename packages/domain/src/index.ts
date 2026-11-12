/**
 * @queuebridge/domain
 *
 * Pure business logic: ticket state machine, routing, wait-time estimates, fairness policy.
 * NO database dependency. NO I/O. All functions are deterministic.
 *
 * Import boundaries:
 * - MAY import: @queuebridge/contracts
 * - MUST NOT import: any DB client, HTTP library, or @queuebridge/{api,worker,channels,continuity,ui}
 */

export * from './state-machine.js';
export * from './routing.js';
export * from './wait-estimate.js';
export * from './queue.js';
export * from './audit.js';
