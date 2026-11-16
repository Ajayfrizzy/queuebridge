import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // API calls must never be answered with the cached app shell
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
        // M5.4: turn-alert push and notification-click handlers (public/push-handler.js)
        importScripts: ['push-handler.js'],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/v1\/facilities\/.+\/public/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'facility-public-data',
              expiration: { maxAgeSeconds: 3600 },
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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
