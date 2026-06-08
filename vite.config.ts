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
          // ghostty-web chunk + 内嵌 wasm：404KB，发布后基本不变。
          // CacheFirst 让重复访问秒开；不依赖 precache（manualChunks 是动态入口）。
          {
            urlPattern: /\/assets\/ghostty[-.].*\.(js|wasm)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ghostty-bundle',
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 天
              },
              cacheableResponse: { statuses: [0, 200] },
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
        target: `http://localhost:${PORT.devBackend}`,
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
          ghostty: ['ghostty-web'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
    // ghostty-web 是动态 import（ensureGhosttyWasmReady），默认不在 entry 的静态
    // 依赖图里 → Vite 不自动注入 <link rel="modulepreload">。把 ghostty 命名空间下
    // 的 chunk 也加入 modulepreload 列表，让浏览器在解析 entry 时就并行抓 ghostty
    // chunk JS（含内嵌 base64 wasm），首屏 open 第一个 terminal 时 WASM 已就绪。
    modulePreload: {
      polyfill: false,
      resolveDependencies: (filename, deps, { hostId, hostType }) => {
        // filename 形如 '/assets/ghostty-XXXX.js'。把 ghostty 包的 chunk 显式加入。
        return deps.filter((d) => /\/ghostty[-.]/i.test(d) || !/^node_modules\//.test(d) || /\/xterm\//.test(d) || d === filename);
      },
    },
  },
});
