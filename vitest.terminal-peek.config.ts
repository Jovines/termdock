import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({
  cacheDir: 'node_modules/.vite/terminal-peek-tests',
  resolve: { alias: { 'node:diagnostics_channel': fileURLToPath(new URL('./src/lib/shims/diagnosticsChannel.ts', import.meta.url)) } },
  optimizeDeps: { include: ['uuid', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'zustand/react/shallow', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-web-links', '@xterm/addon-unicode11', '@xterm/addon-search', '@xterm/addon-serialize', '@xterm/addon-image', '@xterm/addon-ligatures', '@xterm/addon-progress', 'browser-haptic', 'qrcode'] },
  test: {
    include: ['src/lib/components/chat/sessionTerminalPeek.browser.tsx'],
    testTimeout: 30000,
    browser: {
      enabled: true, headless: true, screenshotFailures: false,
      viewport: { width: 1280, height: 900 },
      commands: {
        async peekMove(context, selector: string, x = .5, y = .5) {
          const box = await context.iframe.locator(selector).boundingBox();
          if (!box) throw new Error(`Missing pointer target ${selector}`);
          await context.page.mouse.move(box.x + box.width * x, box.y + box.height * y);
        },
      },
      instances: [1, 2].map(deviceScaleFactor => ({
        browser: 'chromium' as const, name: `peek-dpr${deviceScaleFactor}`,
        provider: playwright({ launchOptions: { channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--force-device-scale-factor=${deviceScaleFactor}`] }, contextOptions: { deviceScaleFactor } }),
      })),
    },
  },
});
