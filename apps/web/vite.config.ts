import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { PRECACHE_GLOB_PATTERNS, RUNTIME_CACHING } from './src/pwa/swRules.js';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'QueueBridge',
        short_name: 'QueueBridge',
        description: 'Resilient, accessible, accountable queue-coordination platform',
        theme_color: '#1a56db',
        background_color: '#ffffff',
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
        ],
      },
      workbox: {
        // MQ.2: includes the built-in public Ask Que bundle (a hashed JSON asset)
        globPatterns: PRECACHE_GLOB_PATTERNS,
        // API calls must never be answered with the cached app shell
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
        // M5.4: turn-alert push and notification-click handlers (public/push-handler.js)
        importScripts: ['push-handler.js'],
        // Public, non-personal API responses only (src/pwa/swRules.ts; MQ.2 corrected the
        // public-facility rule, which never matched the real API path)
        runtimeCaching: RUNTIME_CACHING,
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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
