import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PORT is set by tooling (e.g. preview launchers); default stays 5173
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'MultiPaint — multicolor model painter',
        short_name: 'MultiPaint',
        description: 'Paint STL/3MF models for multicolor 3D printing and export a painted 3MF for Orca/Bambu.',
        theme_color: '#1b1d21',
        background_color: '#1b1d21',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // precache the app shell (js/css/html/icons); never the big sample STLs
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        globIgnores: ['**/*.stl'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
});
