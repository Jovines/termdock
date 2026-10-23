import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['src/lib/components/chat/chatViewport.browser.tsx'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      viewport: { width: 390, height: 844 },
      instances: [{ browser: 'chromium', provider: playwright({ launchOptions: { channel: 'chrome' } }) }],
    },
  },
});
