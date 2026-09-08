// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRemoteSession, remoteSessionAddress } from './remoteSession';
afterEach(() => { delete window.termdockDesktop; vi.restoreAllMocks(); });
describe('remote collaboration navigation', () => {
  it('keeps legacy IDs and decodes origin and session independently', () => {
    expect(remoteSessionAddress('remote:https%3A%2F%2Fc.test:one%3Atwo')).toEqual({ origin: 'https://c.test', sessionId: 'one:two' });
    expect(remoteSessionAddress('remote:javascript%3Aalert(1):one')).toBeNull();
  });
  it('opens a PWA target through the verified connection gate', async () => {
    const listener = vi.fn(); window.addEventListener('termdock:open-remote-session', listener, { once: true });
    await openRemoteSession('remote:https%3A%2F%2Fc.test:one');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toEqual({ origin: 'https://c.test', sessionId: 'one' });
  });
});
