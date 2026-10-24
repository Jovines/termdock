import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  cacheDir: 'node_modules/.vite/keyboard-layout-tests',
  resolve: { alias: { 'node:diagnostics_channel': fileURLToPath(new URL('./src/lib/shims/diagnosticsChannel.ts', import.meta.url)) } },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'zustand/react/shallow',
      '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-web-links',
      '@xterm/addon-unicode11', '@xterm/addon-search', '@xterm/addon-serialize', '@xterm/addon-image',
      '@xterm/addon-ligatures', '@xterm/addon-progress', 'browser-haptic', 'qrcode'],
  },
  test: {
    include: ['src/lib/components/chat/chatViewport.browser.tsx', 'src/lib/components/chat/nativeChatViewport.browser.tsx', 'src/lib/components/terminal/nativeTerminalInput.browser.tsx', 'src/lib/components/layout/keyboardPanelLayout.browser.tsx'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      viewport: { width: 390, height: 844 },
      instances: [{ browser: 'chromium', provider: playwright({ launchOptions: { channel: 'chrome' }, contextOptions: { hasTouch: true } }) }],
      commands: {
        async inputPanelDrag(context, selector: string, dy: number) {
          const box = await context.iframe.locator(selector).boundingBox();
          if (!box) throw new Error(`Missing touch target: ${selector}`);
          const session = await context.context.newCDPSession(context.page);
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          try {
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let i = 1; i <= 12; i++) {
              await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy * i / 12 }] });
              await context.page.waitForTimeout(16);
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } finally { await session.detach(); }
        },
      },
    },
  },
});
