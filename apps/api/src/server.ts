import { buildApp } from './app.js';
import { parseEnv } from './env.js';
import { auditKeyFingerprint } from './queue/audit.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const app = await buildApp(env);

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`QueueBridge API listening on port ${env.PORT}`);
    // Never the key itself: a fingerprint to compare with the worker's startup log
    if (env.AUDIT_SIGNING_KEY && env.AUDIT_SIGNING_KEY_ID) {
      app.log.info(
        {
          audit_key_id: env.AUDIT_SIGNING_KEY_ID,
          audit_key_fingerprint: auditKeyFingerprint(env.AUDIT_SIGNING_KEY),
        },
        'Audit checkpoint verification key loaded',
      );
    } else {
      app.log.warn(
        'No audit signing key: integrity checks of signed checkpoints will report "incomplete"',
      );
    }
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

await main();
