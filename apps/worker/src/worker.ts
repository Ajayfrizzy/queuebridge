import { parseEnv } from './env.js';

/**
 * QueueBridge notification and audit worker.
 *
 * Jobs (M0 stubs — full implementations in M2/M4/M6):
 * - processNotificationOutbox: consume notification_outbox and dispatch via ChannelAdapter
 * - verifyAuditCheckpoints: verify hash chain integrity periodically
 * - expireCoordinatorTokens: mark expired device authorizations
 */

const env = parseEnv();

let running = true;

async function processNotificationOutbox(): Promise<void> {
  // TODO (M2/M6): query notification_outbox where next_attempt_at <= NOW()
  // and dispatch via appropriate ChannelAdapter
  // Stub: no-op
}

async function verifyAuditCheckpoints(): Promise<void> {
  // TODO (M4): verify hash chain for recent checkpoints
  // Stub: no-op
}

async function expireCoordinatorTokens(): Promise<void> {
  // TODO (M3): mark coordinator authorizations where expires_at <= NOW() as expired
  // Stub: no-op
}

async function runOnce(): Promise<void> {
  await processNotificationOutbox();
  await verifyAuditCheckpoints();
  await expireCoordinatorTokens();
}

async function main(): Promise<void> {
  console.log(`QueueBridge worker started. Poll interval: ${env.WORKER_POLL_INTERVAL_MS}ms`);

  while (running) {
    try {
      await runOnce();
    } catch (err) {
      console.error('Worker job error:', err);
    }
    await sleep(env.WORKER_POLL_INTERVAL_MS);
  }

  console.log('QueueBridge worker stopped.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Worker received SIGTERM — stopping after current job');
  running = false;
});

process.on('SIGINT', () => {
  running = false;
});

await main();
