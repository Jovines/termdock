/* Native resource loads cannot use window.fetch hooks. Keep API traffic inside the
 * requesting document's authenticated channel; never fall back to network. */
(() => {
  const MAX_BODY = 5 * 1024 * 1024;
  const active = new Map();
  const frameBindings = new Map();
  const denied = () => new Response('Encrypted connection unavailable', {
    status: 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
  function canonicalPath(value) {
    try {
      if (!value.startsWith('/api/') || value.includes('//')) return null;
      return value.split('/').map(segment => {
        const decoded = decodeURIComponent(segment);
        if (decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f]/.test(decoded) || /%[a-f0-9]{2}/i.test(decoded)) throw new Error('Invalid preview path');
        return decoded;
      }).join('/');
    } catch { return null; }
  }
  function previewPrefix(requestUrl, location) {
    const requested = new URL(requestUrl);
    const final = new URL(location || requestUrl, requestUrl);
    if (final.origin !== self.location.origin) return null;
    const prefix = '/api/terminal/fs/preview/';
    const source = canonicalPath(requested.pathname), target = canonicalPath(final.pathname);
    if (!source?.startsWith(prefix) || !target?.startsWith(prefix)) return null;
    const targetParts = target.slice(prefix.length).split('/');
    if (!/^[a-f0-9]{32}$/.test(targetParts[0])) return null;
    const sourceParts = source.slice(prefix.length).split('/');
    if (/^[a-f0-9]{32}$/.test(sourceParts[0])) sourceParts.shift();
    // The target may only tokenize the requested document/directory, not redirect
    // a trusted navigation into an unrelated filesystem root.
    if (sourceParts.join('/').replace(/\/$/, '') !== targetParts.slice(1).join('/').replace(/\/$/, '')) return null;
    return target.endsWith('/') ? target : target.slice(0, target.lastIndexOf('/') + 1);
  }
  async function boundedBody(request) {
    if (!request.body) return undefined;
    const reader = request.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_BODY) throw new Error('Request budget exceeded');
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes.buffer;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  async function proxy(event) {
    // No arbitrary "first matching window" fallback: another tab may access a different target.
    const source = event.clientId ? await self.clients.get(event.clientId) : undefined;
    if (!source || source.type !== 'window' || new URL(source.url).origin !== self.location.origin) return denied();
    const isApplication = client => {
      if (!client || new URL(client.url).origin !== self.location.origin) return false;
      const url = new URL(client.url);
      return client.frameType === 'top-level' || (url.pathname === '/workspace.html'
        && /^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(url.searchParams.get('termdock-workspace') || ''));
    };
    const binding = isApplication(source) ? undefined : frameBindings.get(source.id);
    const client = isApplication(source) ? source : binding ? await self.clients.get(binding.ownerId) : undefined;
    if (!isApplication(client)) {
      frameBindings.delete(source.id); return denied();
    }
    if (binding && (!['GET', 'HEAD'].includes(event.request.method) || !canonicalPath(new URL(event.request.url).pathname)?.startsWith(binding.previewPrefix))) return denied();
    if ((active.get(client.id) || 0) >= 32) return denied();
    active.set(client.id, (active.get(client.id) || 0) + 1);
    const channel = new MessageChannel();
    const port = channel.port1;
    let ended = false, pending, timer;
    const cleanup = () => {
      if (ended) return; ended = true; clearTimeout(timer);
      const count = (active.get(client.id) || 1) - 1;
      if (count > 0) active.set(client.id, count); else active.delete(client.id);
      port.postMessage({ type: 'cancel' }); port.close();
    };
    const wait = () => new Promise((resolve, reject) => {
      if (ended) { reject(new Error('Closed')); return; }
      pending = { resolve, reject };
      timer = setTimeout(() => { pending = undefined; reject(new Error('Bridge timeout')); cleanup(); }, 30000);
    });
    port.onmessage = message => {
      if (!pending) { cleanup(); return; }
      const next = pending; pending = undefined; clearTimeout(timer);
      if (message.data?.type === 'error') { next.reject(new Error('Bridge failed')); cleanup(); }
      else next.resolve(message.data);
    };
    port.onmessageerror = () => { pending?.reject(new Error('Bridge invalid')); pending = undefined; cleanup(); };
    port.start();
    try {
      const request = event.request;
      const body = await boundedBody(request);
      const headers = {}; request.headers.forEach((value, key) => { headers[key] = value; });
      const url = new URL(request.url);
      const headPromise = wait();
      client.postMessage({ type: 'termdock-secure-fetch', path: url.pathname + url.search,
        method: request.method, headers, body, expectedTargetPeerId: binding?.targetPeerId || new URL(client.url).searchParams.get('termdock-workspace'), previewPrefix: binding?.previewPrefix }, [channel.port2, ...(body ? [body] : [])]);
      const head = await headPromise;
      if (head?.type !== 'head' || !Number.isInteger(head.status)) throw new Error('Invalid bridge header');
      if (event.resultingClientId && request.mode === 'navigate' && typeof head.targetPeerId === 'string') {
        const scope = binding?.previewPrefix || previewPrefix(request.url, head.headers?.location || head.headers?.Location);
        if (!scope) throw new Error('Preview capability unavailable');
        // The browser supplies the new frame ID and its initiating client; bind only
        // that proven relationship, never a matching origin or an arbitrary window.
        const stale = await Promise.all([...frameBindings.keys()].map(async id => !await self.clients.get(id) ? id : null));
        for (const id of stale) if (id) frameBindings.delete(id);
        if (frameBindings.size >= 128) frameBindings.delete(frameBindings.keys().next().value);
        frameBindings.set(event.resultingClientId, { ownerId: client.id, targetPeerId: head.targetPeerId, previewPrefix: scope });
      }
      if (head.bodyless || request.method === 'HEAD' || [204, 205, 304].includes(head.status)) {
        cleanup(); return new Response(null, { status: head.status, headers: head.headers });
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const response = wait(); port.postMessage({ type: 'pull' });
            const packet = await response;
            if (packet?.type === 'end') { controller.close(); cleanup(); return; }
            if (packet?.type !== 'chunk' || !(packet.data instanceof ArrayBuffer) || packet.data.byteLength > 64 * 1024) throw new Error('Invalid bridge chunk');
            controller.enqueue(new Uint8Array(packet.data));
          } catch (error) { controller.error(error); cleanup(); }
        },
        cancel() { cleanup(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { status: head.status, headers: head.headers });
    } catch { cleanup(); return denied(); }
  }
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/')) return;
    if (event.request.method === 'GET' && ['/api/meta', '/api/auth/status', '/api/auth/password/parameters', '/api/auth/open/parameters'].includes(url.pathname)) return;
    if (event.request.method === 'POST' && ['/api/auth/password/start', '/api/auth/password/finish'].includes(url.pathname)) return;
    event.respondWith(proxy(event));
  });
})();
