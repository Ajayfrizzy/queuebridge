/* global URL, console -- Node build script (not covered by the TypeScript config) */
// Writes apps/web/src/tokens.css from the typed token source (run after `pnpm build` of this package).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensToCss } from '../dist/tokens.js';
const out = fileURLToPath(new URL('../../../apps/web/src/tokens.css', import.meta.url));
writeFileSync(out, tokensToCss());
console.log(`wrote ${out}`);
