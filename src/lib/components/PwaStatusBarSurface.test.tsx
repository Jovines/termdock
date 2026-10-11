// @vitest-environment jsdom
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PwaStatusBarSurface } from './PwaStatusBarSurface';
import { clientLog } from '../utils/clientLog';

vi.mock('../utils/clientLog', () => ({ clientLog: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function ipad(standalone: boolean) {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    platform: 'MacIntel', maxTouchPoints: 5, standalone,
  });
}

it('keeps the sampling strip outside a transformed app container and removes it on unmount', () => {
  ipad(true);
  const host = document.createElement('div');
  host.style.transform = 'translateY(-100px)';
  document.body.appendChild(host);
  const { container, unmount } = render(<PwaStatusBarSurface />, { container: host });
  const surface = document.querySelector<HTMLElement>('[data-pwa-status-bar-surface]');
  expect(surface).not.toBeNull();
  expect(surface?.parentElement).toBe(document.body);
  expect(container.childElementCount).toBe(0);
  expect(surface?.getAttribute('aria-hidden')).toBe('true');
  expect(surface?.className).toContain('pointer-events-none');
  expect(surface?.className).toContain('app-chrome-bg');
  unmount();
  expect(document.querySelector('[data-pwa-status-bar-surface]')).toBeNull();
  host.remove();
});

it('reports the mounted revision once after the authenticated viewport is presented', () => {
  ipad(true);
  render(<PwaStatusBarSurface />);
  expect(clientLog).not.toHaveBeenCalled();
  fireEvent(window, new Event('termdock:initial-viewport-presented'));
  fireEvent(window, new Event('termdock:initial-viewport-presented'));
  expect(clientLog).toHaveBeenCalledTimes(1);
  expect(clientLog).toHaveBeenCalledWith('info', 'PWA_STATUS_BAR_SURFACE', expect.objectContaining({
    revision: 'ipad-default-status-bar', parent: 'BODY',
  }));
});

it('also recognizes standalone display mode without the legacy navigator flag', () => {
  ipad(false);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)' }));
  render(<PwaStatusBarSurface />);
  expect(document.querySelector('[data-pwa-status-bar-surface]')).not.toBeNull();
});

it('leaves an iPad browser tab unchanged', () => {
  ipad(false);
  const { container } = render(<PwaStatusBarSurface />);
  expect(container.childElementCount).toBe(0);
  expect(document.querySelector('[data-pwa-status-bar-surface]')).toBeNull();
});

it('leaves desktop and Android PWAs unchanged', () => {
  for (const platform of ['MacIntel', 'Linux', 'Win32']) {
    vi.stubGlobal('navigator', { platform, userAgent: 'Chrome', maxTouchPoints: 0, standalone: true });
    const { container, unmount } = render(<PwaStatusBarSurface />);
    expect(container.childElementCount).toBe(0);
    expect(document.querySelector('[data-pwa-status-bar-surface]')).toBeNull();
    unmount();
  }
});

it('paints only the entry document when a retained service workspace is framed', () => {
  ipad(true);
  vi.stubGlobal('parent', {});
  const { container } = render(<PwaStatusBarSurface />);
  expect(container.childElementCount).toBe(0);
  expect(document.querySelector('[data-pwa-status-bar-surface]')).toBeNull();
});
