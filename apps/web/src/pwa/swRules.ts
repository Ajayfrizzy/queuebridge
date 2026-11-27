/**
 * Service-worker runtime-caching rules (vite-plugin-pwa / Workbox), kept here so they can be
 * unit-tested against real API paths.
 *
 * MQ.2 correction (readiness report F10): the M2 rule matched `/api/v1/facilities/.+/public`,
 * which no API route serves, so public facility data was never cached. The API path is
 * `/api/v1/public/facilities/:orgSlug/:facilitySlug`. The corrected rule matches exactly that
 * resource (network-first); it deliberately does NOT match `/board` (live state) or `/stream` (SSE).
 *
 * Only public, non-personal responses are cached here. Authenticated responses (including the
 * restricted Ask Que bundle `GET /api/v1/que/kb`) are never cached by the service worker; the
 * restricted bundle lives only in the per-user IndexedDB store (design §11.5).
 */

/** Public facility details used by the join page (no personal data). */
export const PUBLIC_FACILITY_URL =
  /^https?:\/\/[^/]+\/api\/v1\/public\/facilities\/[a-z0-9-]+\/[a-z0-9-]+$/;
/** Public Ask Que bundle (visitor articles only). */
export const QUE_PUBLIC_KB_URL = /^https?:\/\/[^/]+\/api\/v1\/que\/kb\/public$/;
/** Server capability manifest (booleans and statuses only). */
export const QUE_CAPABILITIES_URL = /^https?:\/\/[^/]+\/api\/v1\/que\/capabilities$/;

export interface RuntimeRule {
  urlPattern: RegExp;
  /**
   * NetworkFirst for data whose freshness matters online (facility details, capability
   * availability): the network answers when reachable, the cache only when it is not. The public
   * Ask Que bundle uses stale-while-revalidate as design §11.5 specifies (versioned content).
   */
  handler: 'NetworkFirst' | 'StaleWhileRevalidate';
  options: { cacheName: string; expiration: { maxAgeSeconds: number; maxEntries: number } };
}

export const RUNTIME_CACHING: RuntimeRule[] = [
  {
    urlPattern: PUBLIC_FACILITY_URL,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'facility-public-data',
      expiration: { maxAgeSeconds: 3600, maxEntries: 20 },
    },
  },
  {
    urlPattern: QUE_PUBLIC_KB_URL,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'que-public-kb',
      expiration: { maxAgeSeconds: 30 * 24 * 3600, maxEntries: 1 },
    },
  },
  {
    urlPattern: QUE_CAPABILITIES_URL,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'que-capabilities',
      expiration: { maxAgeSeconds: 7 * 24 * 3600, maxEntries: 1 },
    },
  },
];

/** Static assets precached at install. `json` covers the built-in public Ask Que bundle. */
export const PRECACHE_GLOB_PATTERNS = ['**/*.{js,css,html,ico,png,svg,woff2,json}'];
