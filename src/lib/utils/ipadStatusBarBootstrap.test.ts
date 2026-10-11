// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const html = readFileSync('index.html', 'utf8');
const startup = new DOMParser().parseFromString(html, 'text/html')
  .getElementById('termdock-ipad-status-bar')!;
const script = readFileSync(`public${startup.getAttribute('src')}`, 'utf8');

it('loads the configuration synchronously under the app CSP and precaches it for offline launches', () => {
  expect(startup.hasAttribute('async')).toBe(false);
  expect(startup.hasAttribute('defer')).toBe(false);
  expect(startup.getAttribute('type')).toBeNull();
  expect(startup.getAttribute('src')).toBe('/ipad-status-bar.js');
  expect(readFileSync('vite.config.ts', 'utf8')).toContain("'ipad-status-bar.js'");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.remove();
  delete document.documentElement.dataset.termdockPwaStatusBar;
  document.documentElement.style.removeProperty('--safe-top-inset');
});

it.each([
  ['desktop-UA iPad', 'Macintosh', 'MacIntel', 5, 'default'],
  ['iPad UA', 'iPad', 'iPad', 5, 'default'],
  ['iPhone', 'iPhone', 'iPhone', 5, 'black-translucent'],
  ['Mac desktop', 'Macintosh', 'MacIntel', 0, 'black-translucent'],
  ['Windows touch laptop', 'Windows', 'Win32', 10, 'black-translucent'],
  ['Android tablet', 'Android', 'Linux', 5, 'black-translucent'],
])('configures installation metadata for %s before the app loads', (_, userAgent, platform, maxTouchPoints, expected) => {
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
  const meta = document.createElement('meta');
  meta.name = 'apple-mobile-web-app-status-bar-style';
  meta.content = 'black-translucent';
  document.head.append(meta);
  new Function(script)();
  expect(meta.content).toBe(expected);
  expect(document.documentElement.dataset.termdockPwaStatusBar).toBe(expected === 'default' ? 'default' : undefined);
  expect(document.documentElement.style.getPropertyValue('--safe-top-inset')).toBe(
    expected === 'default' ? 'env(safe-area-inset-top, 0px)' : '',
  );
});
