import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import { PORT, DEFAULT_HOST } from './src/server/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // dev 模式下也启用 SW，方便手机 PWA 调试。
      // 配合下面 workbox.skipWaiting + clientsClaim，每次刷新检测到新版 SW
      // 都会立刻接管旧版、控制当前页面，省掉手动清缓存的步骤。
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon-180x180.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
        'robots.txt',
        'fonts/*.woff2',
      ],
      manifest: {
        name: 'Termdock',
        short_name: 'Termdock',
        description: 'A complete web-based terminal application',
        theme_color: '#1C1B1A',
        background_color: '#1C1B1A',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        globIgnores: ['**/apple-splash-*.png'],
        // 关键：新 SW 安装完不要 wait，直接 activate；并立刻 claim 已打开的页面。
        // 这样以后无论 dev 还是 prod，用户刷新一次就能拿到最新代码，不再有
        // "PWA 缓存了旧 bundle 导致看不到新功能" 的窘境。
        skipWaiting: true,
        clientsClaim: true,
        // dev 模式下经常涉及一些没缓存好的资源（HMR 客户端、新加的模块等），
        // 让 SW 在拿不到 precached 内容时回到 network 而不是报 404。
        navigateFallbackDenylist: [/^\/api\//, /^\/health$/],
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60, // 1 hour
              },
              networkTimeoutSeconds: 10,
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: PORT.frontend,
    strictPort: true,
    host: DEFAULT_HOST,
    proxy: {
      '/api': {
        target: `http://localhost:${PORT.backend}`,
        changeOrigin: true,
        ws: true,
        configure: (proxy, options) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            // CORS headers for cookies to work across ports
            if (!proxyRes.headers['access-control-allow-origin']) {
              proxyRes.headers['access-control-allow-origin'] = req.headers.origin || '*';
            }
            proxyRes.headers['access-control-allow-credentials'] = 'true';
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
});
