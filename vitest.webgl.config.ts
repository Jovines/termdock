import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Real WebGL2 rendering, with a reproducible software GPU for headless CI.
// Run separately from the Node/jsdom suite: npm run test:webgl.
export default defineConfig({
  test: {
    include: ['src/lib/terminal/*.browser.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      viewport: { width: 1280, height: 1000 },
      instances: [1, 2].map(deviceScaleFactor => ({
        browser: 'chromium' as const,
        name: `chromium-dpr${deviceScaleFactor}`,
        provider: playwright({
          launchOptions: {
            // Chrome is also available on macOS. Install with
            // `npx playwright install chrome` if it is not already present.
            channel: 'chrome',
            args: [
              '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader',
              // Match the real backing pixels to emulated devicePixelRatio;
              // xterm measures both through ResizeObserver.
              `--force-device-scale-factor=${deviceScaleFactor}`,
            ],
          },
          contextOptions: { deviceScaleFactor },
        }),
      })),
    },
  },
});
