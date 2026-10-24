import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['src/lib/components/chat/chatComposer.browser.tsx'],
    browser: {
      enabled: true, headless: true, screenshotFailures: false,
      viewport: { width: 390, height: 844 },
      instances: [{ browser: 'chromium', provider: playwright({ launchOptions: { channel: 'chrome' }, contextOptions: { hasTouch: true, isMobile: true } }) }],
      commands: {
        async touchDrag(context, selector: string, dx: number, dy: number) {
          const box = await context.iframe.locator(selector).boundingBox();
          if (!box) throw new Error(`Missing touch target: ${selector}`);
          const session = await context.context.newCDPSession(context.page);
          const x = box.x + (dx < 0 ? box.width * .8 : box.width * .2), y = box.y + box.height * .55;
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let i = 1; i <= 12; i++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 12, y: y + dy * i / 12 }] });
            await context.page.waitForTimeout(16);
          }
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await session.detach();
        },
      },
    },
  },
});
