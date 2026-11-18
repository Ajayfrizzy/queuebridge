import {
  CapabilityManifestSchema,
  PublicKbResponseSchema,
  type CapabilityManifest,
  type PublicKbResponse,
} from '@queuebridge/contracts';
// The compiled public bundle, emitted as a hashed asset and precached by the service worker
import builtInPublicKbUrl from '@queuebridge/assist/kb/visitor.json?url&no-inline';

/**
 * Public Ask Que help (MQ.2; design §11.5). Anyone may read it; it needs no account.
 *
 * Order: the API (`GET /api/v1/que/kb/public`, kept offline by the service worker's
 * stale-while-revalidate cache), then the copy built into this app version (precached at
 * install). Everything is schema-checked; nothing invalid is ever returned.
 */
export type PublicKbSource = 'server' | 'built_in';

export async function loadPublicKb(
  fromApi: () => Promise<unknown>,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url),
  builtInUrl: string = builtInPublicKbUrl,
): Promise<{ bundle: PublicKbResponse; source: PublicKbSource } | null> {
  try {
    const parsed = PublicKbResponseSchema.safeParse(await fromApi());
    if (parsed.success) return { bundle: parsed.data, source: 'server' };
  } catch {
    // unreachable: fall through to the built-in copy
  }
  try {
    const res = await fetchImpl(builtInUrl);
    if (res.ok) {
      const parsed = PublicKbResponseSchema.safeParse(await res.json());
      if (parsed.success) return { bundle: parsed.data, source: 'built_in' };
    }
  } catch {
    // not cached (first visit offline)
  }
  return null;
}

/**
 * The capability manifest (server-issued; the service worker keeps the last copy for offline
 * use). Returns `null` when unavailable or invalid, which every consumer treats as "not usable"
 * (decision D1: fail closed).
 */
export async function loadCapabilities(
  fromApi: () => Promise<unknown>,
): Promise<CapabilityManifest | null> {
  try {
    const parsed = CapabilityManifestSchema.safeParse(await fromApi());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
