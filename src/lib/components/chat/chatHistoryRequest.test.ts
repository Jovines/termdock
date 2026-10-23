// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearChatHistoryRequests, preloadChatHistory, readChatHistory } from './chatHistoryRequest';
const scope = vi.hoisted(() => ({ client: {}, target: 'local' }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => scope.client, savedConnection: () => ({ targetPeerId: scope.target }) }));
afterEach(() => { clearChatHistoryRequests(); vi.unstubAllGlobals(); });
it('starts history before the renderer is ready and reuses even an already-completed warm request', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ messages: [], revision: 'one' })); vi.stubGlobal('fetch', fetch);
  const release = preloadChatHistory('warm');
  expect(fetch).toHaveBeenCalledOnce();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await readChatHistory('warm', new AbortController().signal)).toMatchObject({ revision: 'one' });
  expect(fetch).toHaveBeenCalledOnce(); release();
  await readChatHistory('warm', new AbortController().signal, 'one');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe('/api/terminal/warm/chat?limit=30&revision=one');
});
it('does not launch a second warm request after a mounted view already requested history', async () => {
  const fetch = vi.fn(async () => Response.json({ messages: [] })); vi.stubGlobal('fetch', fetch);
  const reading = readChatHistory('mounted', new AbortController().signal);
  const release = preloadChatHistory('mounted');
  await reading; release(); expect(fetch).toHaveBeenCalledOnce();
});
it('cancels unused warming on a quick switch and never reuses another connection’s response', async () => {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url, init) => { signals.push(init.signal); return new Promise<Response>(() => {}); }); vi.stubGlobal('fetch', fetch);
  const release = preloadChatHistory('away'); release(); expect(signals[0].aborted).toBe(true);
  const releaseOld = preloadChatHistory('changed'); scope.client = {};
  const releaseNew = preloadChatHistory('changed');
  expect(signals[1].aborted).toBe(true); expect(signals[2].aborted).toBe(false);
  releaseOld(); expect(signals[2].aborted).toBe(false); releaseNew();
});
it('starts a fresh revalidation instead of reusing an earlier consumed request after a send', async () => {
  const fetch = vi.fn(async () => Response.json({ messages: [] })); vi.stubGlobal('fetch', fetch);
  const before = readChatHistory('sending', new AbortController().signal, 'before');
  const after = readChatHistory('sending', new AbortController().signal, 'after');
  await Promise.all([before, after]); expect(fetch).toHaveBeenCalledTimes(2);
});
