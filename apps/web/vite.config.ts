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
        orientation: 'portrait',
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
        target: process.env['VITE_API_BASE_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
