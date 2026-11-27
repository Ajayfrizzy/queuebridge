import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { PRECACHE_GLOB_PATTERNS, RUNTIME_CACHING } from './src/pwa/swRules.js';
import { WEB_SECURITY_HEADERS } from './src/pwa/securityHeaders.js';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // M7.1: the product owner's supplied icons (public/); one manifest, generated here
      includeAssets: ['favicon.ico', 'favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'QueueBridge',
        short_name: 'QueueBridge',
        description: 'Resilient, accessible, accountable queue-coordination platform',
        theme_color: '#102a43',
        background_color: '#f8fafc',
        display: 'standalone',
        // No `orientation`: the app must work in portrait and landscape (WCAG 1.3.4, REQ-F7.17)
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // MQ.2: includes the built-in public Ask Que bundle (a hashed JSON asset)
        globPatterns: PRECACHE_GLOB_PATTERNS,
        globIgnores: ['assets/LandingPage-*.{js,css}', 'assets/landing-preview-*.png'],
        // API calls must never be answered with the cached app shell
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
        // M5.4: turn-alert push and notification-click handlers (public/push-handler.js)
        importScripts: ['push-handler.js'],
        // Public, non-personal API responses only (src/pwa/swRules.ts; MQ.2 corrected the
        // public-facility rule, which never matched the real API path)
        runtimeCaching: [
          ...RUNTIME_CACHING,
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin &&
              /^\/assets\/(?:LandingPage-[\w-]+\.(?:js|css)|landing-preview-[\w-]+\.png)$/.test(
                url.pathname,
              ) &&
              !url.search,
            handler: 'CacheFirst',
            options: {
              cacheName: 'landing-assets',
              expiration: { maxEntries: 8, maxAgeSeconds: 2592000 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['API_PROXY_TARGET'] ?? 'http://localhost:3002',
        changeOrigin: true,
      },
      // Reachability probe used by the offline layer (separate from navigator.onLine)
      '/health': {
        target: process.env['API_PROXY_TARGET'] ?? 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  // M7.2: the built app is served with the production security headers (design §14.7), so the
  // Playwright suite runs under them; production serving must send the same set
  // (docs/deployment/web-security-headers.md)
  preview: {
    headers: { ...WEB_SECURITY_HEADERS },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
