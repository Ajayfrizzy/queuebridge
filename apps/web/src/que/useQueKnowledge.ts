import { useCallback, useEffect, useState } from 'react';
import type { CapabilityManifest, KbArticle } from '@queuebridge/contracts';
import { api } from '../lib/api.js';
import type { BundleState } from './offlineHelp.js';
import { loadCapabilities, loadPublicKb, queHelp } from './index.js';
import type { PublicKbSource } from './publicKb.js';

/**
 * What Ask Que may show right now (MQ.3). It only READS the MQ.2 sources:
 * - the public bundle (server copy, else the copy built into the app);
 * - the server capability manifest (null when unavailable: every capability then counts as
 *   not usable, decision D1);
 * - the signed-in user's restricted bundle, through `queHelp.restrictedHelp`, which applies
 *   the server-issued fingerprint, expiry and invalidation rules. Nothing here decides access.
 */
export interface QueKnowledge {
  publicState: 'loading' | 'ready' | 'failed';
  source: PublicKbSource | null;
  kbVersion: number | null;
  /** Public articles plus, for a signed-in user, the restricted articles that may be shown. */
  articles: KbArticle[];
  manifest: CapabilityManifest | null;
  /** `none` for anonymous visitors. */
  restricted: BundleState | 'pending' | 'none';
  reload: () => void;
}

export function useQueKnowledge(userId: string | null, reachable: boolean): QueKnowledge {
  const [publicState, setPublicState] = useState<QueKnowledge['publicState']>('loading');
  const [source, setSource] = useState<PublicKbSource | null>(null);
  const [kbVersion, setKbVersion] = useState<number | null>(null);
  const [publicArticles, setPublicArticles] = useState<KbArticle[]>([]);
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null);
  const [restrictedArticles, setRestrictedArticles] = useState<KbArticle[]>([]);
  const [restricted, setRestricted] = useState<QueKnowledge['restricted']>('none');
  const [attempt, setAttempt] = useState(0);

  // Public help and the manifest: on open, on retry and when the server becomes reachable again
  useEffect(() => {
    let cancelled = false;
    setPublicState((s) => (s === 'ready' ? s : 'loading'));
    void (async (): Promise<void> => {
      const [pub, caps] = await Promise.all([
        loadPublicKb(() => api.quePublicKb()),
        loadCapabilities(() => api.queCapabilities()),
      ]);
      if (cancelled) return;
      setManifest(caps);
      if (pub) {
        setPublicArticles(pub.bundle.articles);
        setKbVersion(pub.bundle.kbVersion);
        setSource(pub.source);
        setPublicState('ready');
      } else {
        setPublicState((s) => (s === 'ready' ? s : 'failed'));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [attempt, reachable]);

  // Restricted help: re-read whenever the cache may have changed (revalidation, purge, user)
  useEffect(() => {
    if (!userId) {
      setRestricted('none');
      setRestrictedArticles([]);
      return undefined;
    }
    let cancelled = false;
    const read = (): void => {
      void queHelp
        .restrictedHelp(userId)
        .then((r) => {
          if (cancelled) return;
          setRestricted(r.state);
          setRestrictedArticles(r.articles);
        })
        .catch(() => {
          if (cancelled) return;
          setRestricted('missing');
          setRestrictedArticles([]);
        });
    };
    read();
    const unsubscribe = queHelp.subscribe(read);
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId, reachable, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const byId = new Map<string, KbArticle>();
  for (const a of publicArticles) byId.set(a.id, a);
  if (userId && restricted === 'valid') for (const a of restrictedArticles) byId.set(a.id, a);

  return {
    publicState,
    source,
    kbVersion,
    articles: [...byId.values()],
    manifest,
    restricted,
    reload,
  };
}
