// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

describe('PWA update consent', () => {
  it('leaves a waiting worker idle until the user accepts and flushes drafts first', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const postMessage = vi.fn();
    const registration = { waiting: { postMessage }, addEventListener: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
    const serviceWorker = new EventTarget();
    Object.assign(serviceWorker, { controller: {}, register: vi.fn().mockResolvedValue(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
    const flush = vi.fn();
    window.addEventListener('termdock:before-update', flush);
    const { setupPwaUpdateReload, applyPwaUpdate } = await import('./pwaUpdate');
    setupPwaUpdateReload();
    window.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(flush).not.toHaveBeenCalled();
    applyPwaUpdate();
    expect(flush).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(postMessage.mock.invocationCallOrder[0]);
    window.removeEventListener('termdock:before-update', flush);
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
