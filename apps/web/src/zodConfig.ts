import { config } from 'zod';
/**
 * M7.2: the production CSP has no `'unsafe-eval'`. Zod's optional JIT probes `new Function`,
 * which a strict CSP reports as a violation even though Zod catches it and falls back. Jitless
 * mode skips the probe; validation results are identical. Imported first, before any parse.
 */
config({ jitless: true });
