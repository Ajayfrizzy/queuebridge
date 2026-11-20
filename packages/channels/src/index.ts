/**
 * @queuebridge/channels
 *
 * ChannelAdapter interface, sandbox test doubles, and provider adapter registry.
 *
 * Import boundaries:
 * - MAY import: @queuebridge/contracts
 * - MUST NOT import: @queuebridge/domain, @queuebridge/continuity, any DB client
 */

export * from './adapter.js';
export * from './sandbox.js';
export * from './push.js';
export * from './sms.js';
export * from './registry.js';
