/* Decrypted, device-local attachments. Never fetch these capability URLs from a server. */
(() => {
  const cacheName = 'termdock-downloads-v1';
  const prefix = '/__termdock-download/';
  const lifetime = 5 * 60 * 1000;
  async function clean(cache) {
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (Number(response?.headers.get('X-Termdock-Expires')) < Date.now()) await cache.delete(key);
    }
  }
  self.addEventListener('message', event => {
    if (event.data?.type !== 'termdock:prepare-download' || event.ports.length !== 1) return;
    const port = event.ports[0];
    event.waitUntil((async () => {
      const client = event.source?.id && await self.clients.get(event.source.id);
      if (!client || client.type !== 'window' || new URL(client.url).origin !== self.location.origin) throw new Error('Invalid download owner');
      const ownerUrl = new URL(client.url);
      if (client.frameType !== 'top-level' && !(ownerUrl.pathname === '/workspace.html'
        && /^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(ownerUrl.searchParams.get('termdock-workspace') || ''))) throw new Error('Invalid download owner');
      const { blob, filename } = event.data;
      if (!(blob instanceof Blob) || typeof filename !== 'string' || filename.length > 512) throw new Error('Invalid download');
      const cache = await caches.open(cacheName); await clean(cache);
      if ((await cache.keys()).length >= 8) throw new Error('Too many pending downloads');
      const url = new URL(prefix + crypto.randomUUID(), self.location.origin).href;
      const safeName = filename.replace(/[\r\n\x00]/g, '_');
      const encoded = encodeURIComponent(safeName).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16));
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encoded, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Termdock-Expires': String(Date.now() + lifetime) } }));
      port.postMessage({ url });
    })().catch(() => port.postMessage({ error: 'Download unavailable' })).finally(() => port.close()));
  });
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName); await clean(cache);
      const response = await cache.match(url.href);
      if (!response || event.request.method !== 'GET') return new Response('Download expired', { status: 410 });
      await cache.delete(url.href);
      return response;
    })());
  });
})();
