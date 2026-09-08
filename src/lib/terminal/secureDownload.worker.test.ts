import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
function fixture(frameType = 'top-level') {
  const handlers: Record<string, (event: any) => void> = {};
  const records = new Map<string, Response>();
  const key = (value: Request | string) => typeof value === 'string' ? value : value.url;
  const cache = { keys: async () => [...records.keys()].map(url => new Request(url)), match: async (url: Request | string) => records.get(key(url))?.clone(), put: async (url: string, response: Response) => { records.set(url, response); }, delete: async (url: Request | string) => records.delete(key(url)) };
  runInNewContext(readFileSync('public/sw-downloads.js', 'utf8'), { Blob, Response, URL, Date, crypto: webcrypto, caches: { open: async () => cache },
    self: { location: { origin: 'https://app.test' }, clients: { get: async () => ({ type: 'window', frameType, url: 'https://app.test/' }) }, addEventListener: (type: string, callback: (event: any) => void) => { handlers[type] = callback; } } });
  return {
    records,
    async prepare() {
      let pending!: Promise<void>, result: { url?: string; error?: string } = {};
      handlers.message({ source: { id: 'owner' }, data: { type: 'termdock:prepare-download', blob: new Blob(['private bytes']), filename: '测试.txt' }, ports: [{ postMessage: (value: typeof result) => { result = value; }, close() {} }], waitUntil: (value: Promise<void>) => { pending = value; } });
      await pending; return result;
    },
    async download(url: string) {
      let response!: Promise<Response>;
      handlers.fetch({ request: new Request(url), respondWith: (value: Promise<Response>) => { response = value; } });
      return response;
    },
  };
}
it('serves a one-use local attachment with the original bytes and Unicode name', async () => {
  const f = fixture(), prepared = await f.prepare();
  expect(prepared.url).toMatch(/^https:\/\/app.test\/__termdock-download\/[a-f0-9-]+$/);
  const response = await f.download(prepared.url!);
  expect(await response.text()).toBe('private bytes');
  expect(response.headers.get('Content-Disposition')).toContain(encodeURIComponent('测试.txt'));
  expect((await f.download(prepared.url!)).status).toBe(410);
});
it('does not let an untrusted preview frame create a top-level download capability', async () => {
  const f = fixture('nested');
  expect((await f.prepare()).error).toBeTruthy(); expect(f.records.size).toBe(0);
});
it('removes expired attachments instead of ever fetching them from a server', async () => {
  const f = fixture(), prepared = await f.prepare();
  f.records.get(prepared.url!)!.headers.set('X-Termdock-Expires', '0');
  expect((await f.download(prepared.url!)).status).toBe(410); expect(f.records.size).toBe(0);
});
