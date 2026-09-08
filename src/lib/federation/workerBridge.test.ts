import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';

function worker(frameType = 'top-level') {
  let handler: (event: { request: Request; clientId: string; resultingClientId?: string; respondWith(value: Promise<Response>): void }) => void;
  const frames: string[] = [];
  const requests: Array<{ expectedTargetPeerId?: string }> = [];
  let port: import('node:worker_threads').MessagePort | undefined;
  const script = readFileSync(new URL('../../../public/sw-secure-api.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    Response, Request, URL, Uint8Array, ArrayBuffer, MessageChannel, ReadableStream, setTimeout, clearTimeout,
    self: {
      location: { origin: 'https://termdock.test' },
      clients: { get: async (id: string) => ({ id, type: 'window', frameType: id.startsWith('child') ? 'nested' : frameType, url: 'https://termdock.test/',
        postMessage: (message: { expectedTargetPeerId?: string }, ports: import('node:worker_threads').MessagePort[]) => {
          requests.push(message);
          port = ports[0]; let sent = false;
          port.on('message', value => {
            frames.push(value.type);
            if (value.type === 'pull') {
              if (sent) port!.postMessage({ type: 'end' });
              else { sent = true; port!.postMessage({ type: 'chunk', data: new TextEncoder().encode('encrypted-resource').buffer }); }
            }
          });
          port.postMessage({ type: 'head', status: 206, headers: { 'Content-Type': 'text/plain' }, targetPeerId: 'verified-C' });
        },
      }) },
      addEventListener: (_type: string, fn: typeof handler) => { handler = fn; },
    },
  });
  return {
    frames, requests,
    fetch(path: string, clientId = 'tab-1', resultingClientId?: string, method = 'GET') {
      let response: Promise<Response> | undefined;
      const request = new Request('https://termdock.test' + path, { method });
      if (resultingClientId) Object.defineProperty(request, 'mode', { value: 'navigate' });
      handler({ request, clientId, resultingClientId, respondWith: value => { response = value; } });
      return response;
    },
    close() { port?.close(); },
  };
}
describe('encrypted API service-worker interception', () => {
  it('streams only on consumer demand through the exact requesting client', async () => {
    const w = worker();
    try {
      const response = await w.fetch('/api/terminal/fs/video?path=secret');
      expect(response?.status).toBe(206);
      expect(w.frames).toEqual([]);
      expect(await response!.text()).toBe('encrypted-resource');
      expect(w.frames.filter(type => type === 'pull')).toHaveLength(2);
    } finally { w.close(); }
  });
  it('binds only browser-proven iframe descendants to the original verified target', async () => {
    const w = worker();
    try {
      const navigation = await w.fetch('/api/terminal/fs/preview/abcdef0123456789abcdef0123456789/site/index.html', 'tab-1', 'child-known');
      expect(await navigation!.text()).toBe('encrypted-resource');
      const image = await w.fetch('/api/terminal/fs/preview/abcdef0123456789abcdef0123456789/site/image.png', 'child-known');
      expect(await image!.text()).toBe('encrypted-resource');
      expect(w.requests[1].expectedTargetPeerId).toBe('verified-C');
      expect((await w.fetch('/api/terminal/create', 'child-known', undefined, 'POST'))?.status).toBe(503);
      expect((await w.fetch('/api/terminal/settings', 'child-known'))?.status).toBe(503);
      expect((await w.fetch('/api/terminal/fs/preview/abcdef0123456789abcdef0123456789/outside/key', 'child-known'))?.status).toBe(503);
      expect((await w.fetch('/api/terminal/fs/blob', 'child-unknown'))?.status).toBe(503);
    } finally { w.close(); }
  });
  it('fails closed for unbound nested frames and leaves only public metadata on network', async () => {
    const w = worker('nested');
    try {
      expect((await w.fetch('/api/terminal/fs/blob'))?.status).toBe(503);
      expect(w.fetch('/api/meta')).toBeUndefined();
      expect(w.fetch('/api/auth/status')).toBeUndefined();
      expect(w.frames).toEqual([]);
    } finally { w.close(); }
  });
});
