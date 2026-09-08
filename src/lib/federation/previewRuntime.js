/* Runs only in the opaque preview frame. All local reads use its directory capability. */
function installPreviewRuntime(capability, base, externalOrigins, shimUrl) {
  const external = new Set(externalOrigins);
  const report = () => parent.postMessage({ type: 'preview-error', capability }, '*');
  const nativeFetch = window.fetch.bind(window);
  const nativeWorker = window.Worker;
  const externalUrl = value => {
    const url = new URL(value, base);
    const origin = url.protocol === 'wss:' ? 'https://' + url.host : url.origin;
    if (!external.has(origin)) throw new Error('Outside preview network scope');
    return url;
  };
  const bridgeFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), base);
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (url.protocol === 'blob:' || url.protocol === 'data:') return nativeFetch(input, init);
    if (url.origin !== new URL(base).origin) {
      externalUrl(url.href);
      return nativeFetch(url.href, { ...init, method, credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
    if (!['GET', 'HEAD'].includes(method) || !url.pathname.startsWith(new URL(base).pathname)) throw new Error('Outside preview directory');
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) { reject(init.signal.reason); return; }
      const channel = new MessageChannel();
      const finish = () => { clearTimeout(timer); channel.port1.close(); init.signal?.removeEventListener('abort', abort); };
      const abort = () => { finish(); reject(init.signal.reason); };
      const timer = setTimeout(() => { finish(); report(); reject(new Error('Preview resource timeout')); }, 15000);
      init.signal?.addEventListener('abort', abort, { once: true });
      channel.port1.onmessage = event => {
        finish();
        if (event.data.error) { reject(new Error(event.data.error)); return; }
        const response = new Response(method === 'HEAD' ? null : event.data.data, { status: event.data.status, headers: event.data.headers });
        Object.defineProperty(response, 'url', { value: url.href }); resolve(response);
      };
      parent.postMessage({ type: 'preview-fetch', capability, url: url.href, method }, '*', [channel.port2]);
    });
  };
  Object.defineProperty(window, 'fetch', { configurable: false, writable: false, value: bridgeFetch });
  window.esmsInitOptions = { shimMode: true, nativePassthrough: false, fetch: bridgeFetch, onerror: report };
  class PreviewXHR extends EventTarget {
    readyState = 0; status = 0; statusText = ''; response = null; responseText = ''; responseURL = ''; responseType = ''; timeout = 0;
    upload = new EventTarget(); withCredentials = false;
    open(method, url, async = true) {
      if (!async) throw new Error('Synchronous preview requests are unavailable');
      this.abort(); this.method = method; this.url = new URL(url, base).href; this.headers = {}; this.readyState = 1; this.emit('readystatechange');
    }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getAllResponseHeaders() { return this.responseHeaders ? [...this.responseHeaders].map(([key, value]) => key + ': ' + value + '\r\n').join('') : ''; }
    getResponseHeader(name) { return this.responseHeaders?.get(name) ?? null; }
    overrideMimeType(value) { this.mime = value; }
    emit(type, event = new Event(type)) { this.dispatchEvent(event); this['on' + type]?.call(this, event); }
    abort() { if (this.controller) { this.controller.abort(); this.controller = null; this.readyState = 0; this.emit('abort'); this.emit('loadend'); } }
    send(body = null) {
      const controller = new AbortController(); this.controller = controller;
      const timer = this.timeout > 0 ? setTimeout(() => { if (this.controller !== controller) return; controller.abort(); this.controller = null; this.emit('timeout'); this.emit('loadend'); }, this.timeout) : null;
      this.emit('loadstart');
      bridgeFetch(this.url, { method: this.method, headers: this.headers, body, signal: controller.signal }).then(async response => {
        this.status = response.status; this.statusText = response.statusText; this.responseURL = response.url; this.responseHeaders = response.headers;
        this.readyState = 2; this.emit('readystatechange'); this.readyState = 3; this.emit('readystatechange');
        const bytes = await response.arrayBuffer();
        if (this.controller !== controller) return;
        this.responseText = new TextDecoder().decode(bytes);
        this.response = this.responseType === 'arraybuffer' ? bytes : this.responseType === 'blob' ? new Blob([bytes], { type: this.mime || response.headers.get('content-type') || '' }) : this.responseType === 'json' ? (() => { try { return JSON.parse(this.responseText); } catch { return null; } })() : this.responseType === 'document' ? new DOMParser().parseFromString(this.responseText, 'text/html') : this.responseText;
        this.readyState = 4; this.emit('readystatechange'); this.emit('progress', new ProgressEvent('progress', { lengthComputable: true, loaded: bytes.byteLength, total: bytes.byteLength })); this.emit('load'); this.emit('loadend'); this.controller = null;
      }).catch(() => { if (this.controller !== controller) return; this.controller = null; this.status = 0; this.readyState = 4; this.emit('readystatechange'); this.emit('error'); this.emit('loadend'); }).finally(() => clearTimeout(timer));
    }
  }
  for (const [key, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) { PreviewXHR[key] = value; PreviewXHR.prototype[key] = value; }
  Object.defineProperty(window, 'XMLHttpRequest', { configurable: false, writable: false, value: PreviewXHR });
  for (const name of ['WebSocket', 'EventSource']) {
    const Native = window[name];
    if (Native) Object.defineProperty(window, name, { configurable: false, writable: false, value: class extends Native {
      constructor(url, options) { super(externalUrl(url).href, name === 'EventSource' ? { withCredentials: false } : options); }
    } });
  }
  // A worker receives the same read-only bridge over a private MessagePort. Its
  // module graph is loaded by the same shim, including computed dynamic imports.
  class PreviewWorker extends EventTarget {
    constructor(url, options = {}) {
      super();
      const entry = new URL(url, base).href;
      const workerSource = `(${workerBootstrap.toString()})(${JSON.stringify(entry)},${JSON.stringify(options.type || 'classic')},${JSON.stringify(shimUrl)});`;
      this.objectUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      this.worker = new nativeWorker(this.objectUrl, { name: options.name });
      const channel = new MessageChannel(); this.port = channel.port1;
      this.port.onmessage = async event => {
        const { id, url, init } = event.data;
        try { const response = await bridgeFetch(url, init); const data = await response.arrayBuffer(); this.port.postMessage({ id, status: response.status, headers: [...response.headers], data }, [data]); }
        catch (error) { this.port.postMessage({ id, error: String(error) }); }
      };
      this.worker.postMessage({ previewInit: true, base: entry, importMap: window.importShim?.getImportMap?.() }, [channel.port2]);
      for (const type of ['message', 'messageerror', 'error']) this.worker.addEventListener(type, event => {
        const forwarded = type === 'error' ? new ErrorEvent(type, { message: event.message }) : new MessageEvent(type, { data: event.data, ports: event.ports });
        this.dispatchEvent(forwarded); this['on' + type]?.call(this, forwarded);
      });
    }
    postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
    terminate() { this.worker.terminate(); this.port.close(); URL.revokeObjectURL(this.objectUrl); }
  }
  function workerBootstrap(entry, type, shim) {
    const queued = []; let initialized = false, ready = false;
    const receive = event => {
      if (!event.data?.previewInit || initialized) { if (!ready) { event.stopImmediatePropagation(); queued.push(event); } return; }
      initialized = true; event.stopImmediatePropagation();
      const port = event.ports[0]; const pending = new Map(); let next = 0;
      port.onmessage = message => { const done = pending.get(message.data.id); if (!done) return; pending.delete(message.data.id); message.data.error ? done.reject(new Error(message.data.error)) : done.resolve(new Response(message.data.data, { status: message.data.status, headers: message.data.headers })); };
      self.fetch = (url, init = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); port.postMessage({ id, url: new URL(typeof url === 'string' ? url : url.url || String(url), entry).href, init: { method: init.method || 'GET', headers: init.headers } }); });
      self.esmsInitOptions = { shimMode: true, nativePassthrough: false, fetch: self.fetch };
      const nativeImport = self.importScripts.bind(self);
      nativeImport(shim);
      if (event.data.importMap) self.importShim.addImportMap(event.data.importMap);
      const load = type === 'module' ? self.importShim(entry) : self.fetch(entry).then(r => r.text()).then(source => { const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); nativeImport(blob); URL.revokeObjectURL(blob); });
      load.then(() => { ready = true; removeEventListener('message', receive); for (const message of queued) dispatchEvent(new MessageEvent('message', { data: message.data, ports: message.ports })); }).catch(error => setTimeout(() => { throw error; }));
    };
    addEventListener('message', receive);
  }
  Object.defineProperty(window, 'Worker', { configurable: false, writable: false, value: PreviewWorker });
  const navigate = value => {
    const url = new URL(value, base);
    if (url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname)) parent.postMessage({ type: 'preview-navigate', capability, url: url.href }, '*');
    else { externalUrl(url.href); parent.postMessage({ type: 'preview-external', capability, url: url.href }, '*'); }
  };
  Object.defineProperty(window, 'open', { configurable: false, writable: false, value: value => { navigate(value); return null; } });
  document.addEventListener('click', event => { const anchor = event.target.closest?.('a,area'); const href = anchor?.getAttribute('href'); if (href && !href.startsWith('#')) { event.preventDefault(); navigate(href); } }, true);
  document.addEventListener('submit', event => {
    event.preventDefault(); const form = event.target;
    const url = new URL(form.getAttribute('action') || base, base);
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') { report(); return; }
    for (const [key, value] of new FormData(form)) if (typeof value === 'string') url.searchParams.append(key, value);
    navigate(url.href);
  }, true);
  window.addEventListener('securitypolicyviolation', report);
  window.addEventListener('error', report, true);
  window.addEventListener('unhandledrejection', report);
}
