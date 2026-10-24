import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['src/lib/components/NewSessionShortcut.browser.tsx'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium', provider: playwright({ launchOptions: { channel: 'chrome' } }) }],
    },
  },
});
