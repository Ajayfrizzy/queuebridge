import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  AUDIENCES,
  KbBundleSchema,
  type Audience,
  type KbBundleFile,
} from '@queuebridge/contracts';

/**
 * Compiled Ask Que knowledge base (MQ.2; design §11.5). The bundles are produced at build time
 * by `@queuebridge/assist` (`dist/kb/<audience>.json`) and read once at start-up. Every bundle is
 * validated against the shared schema; anything missing or malformed leaves the knowledge base
 * unavailable (the endpoints answer 503) instead of serving unvalidated content. The rest of the
 * API is unaffected.
 */
export interface LoadedKnowledgeBase {
  kbVersion: number;
  bundles: Record<Audience, KbBundleFile>;
}

const require = createRequire(import.meta.url);

export function loadKnowledgeBase(
  read: (audience: Audience) => string = (audience) =>
    readFileSync(require.resolve(`@queuebridge/assist/kb/${audience}.json`), 'utf8'),
): LoadedKnowledgeBase {
  const bundles = {} as Record<Audience, KbBundleFile>;
  let kbVersion: number | null = null;
  for (const audience of AUDIENCES) {
    const bundle = KbBundleSchema.parse(JSON.parse(read(audience)));
    if (bundle.audience !== audience) throw new Error(`bundle ${audience} has the wrong audience`);
    if (kbVersion !== null && bundle.kbVersion !== kbVersion) {
      throw new Error('knowledge-base bundles have different versions');
    }
    kbVersion = bundle.kbVersion;
    bundles[audience] = bundle;
  }
  if (kbVersion === null) throw new Error('no knowledge-base bundles');
  return { kbVersion, bundles };
}
