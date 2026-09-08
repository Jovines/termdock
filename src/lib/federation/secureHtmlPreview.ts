import { canonicalApiPath } from '../../server/federation/accessPolicy.js';

const PREFIX = '/api/terminal/fs/preview/';
const MAX_RESOURCE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_RESOURCES = 128;
const BLOCKED = 'data:,';
type PreviewFetch = (path: string, init?: RequestInit) => Promise<Response>;
interface Resource { bytes: Uint8Array; type: string; status: number }
export interface SecureHtmlPreview {
  html: string;
  shellUrl: string;
  errors: string[];
  attach(frame: HTMLIFrameElement, report: (message: string) => void): () => void;
  dispose(): void;
}
function fail(message: string): never { throw new Error(message); }
function scriptText(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }
async function replaceAsync(text: string, regex: RegExp, replacement: (match: RegExpMatchArray) => Promise<string>): Promise<string> {
  let out = '', offset = 0;
  for (const match of text.matchAll(regex)) { out += text.slice(offset, match.index) + await replacement(match); offset = match.index! + match[0].length; }
  return out + text.slice(offset);
}

/** User HTML never receives a terminal credential, a real navigation URL, or an unrestricted fetch bridge. */
export async function prepareSecureHtmlPreview(src: string, options: { fetch: PreviewFetch; signal?: AbortSignal; origin?: string }): Promise<SecureHtmlPreview> {
  const origin = options.origin ?? location.origin;
  const first = new URL(src, origin);
  if (first.origin !== origin || !canonicalApiPath(first.pathname)?.startsWith(PREFIX)) fail('预览地址不是有效的本地文件入口');
  const capability = crypto.randomUUID();
  const virtualBase = `https://termdock-preview.invalid/${capability}/`;
  const errors: string[] = [];
  const report = (message: string) => { if (!errors.includes(message) && errors.length < 20) errors.push(message); };
  const urls = new Set<string>();
  const packed: { token: string; data: BlobPart; type: string }[] = [];
  const externalOrigins = new Set<string>();
  const resources = new Map<string, Promise<Resource>>();
  const rewritten = new Map<string, Promise<string>>();
  let total = 0, disposed = false;
  const liveBridges = new Set<() => void>();
  const release = () => { disposed = true; for (const close of [...liveBridges]) close(); urls.clear(); packed.length = 0; };
  async function read(response: Response): Promise<Resource> {
    if (!response.ok) fail(`预览资源读取失败（${response.status}）`);
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength; total += item.value.byteLength;
        if (size > MAX_RESOURCE || total > MAX_TOTAL) fail('预览资源超出大小限制');
        chunks.push(item.value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, type: response.headers.get('content-type') ?? 'application/octet-stream', status: response.status };
  }
  let documentUrl = first;
  let documentResponse: Response | undefined;
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await options.fetch(documentUrl.pathname + documentUrl.search, { signal: options.signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) { documentResponse = response; break; }
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) fail('预览重定向缺少目标');
    const target = new URL(location, documentUrl);
    if (target.origin !== origin || !canonicalApiPath(target.pathname)?.startsWith(PREFIX)) fail('预览重定向越出文件范围');
    documentUrl = target;
  }
  if (!documentResponse) fail('预览重定向次数过多');
  const canonical = canonicalApiPath(documentUrl.pathname)!;
  const parts = canonical.slice(PREFIX.length).split('/');
  if (!/^[a-f0-9]{32}$/.test(parts[0])) fail('服务未提供有效的预览资源授权');
  const initialParts = canonicalApiPath(first.pathname)!.slice(PREFIX.length).split('/');
  if (/^[a-f0-9]{32}$/.test(initialParts[0])) initialParts.shift();
  if (initialParts.join('/').replace(/\/$/, '') !== parts.slice(1).join('/').replace(/\/$/, '')) fail('预览重定向改变了文件范围');
  const root = canonical.endsWith('/') ? canonical : canonical.slice(0, canonical.lastIndexOf('/') + 1);
  const rootUrl = new URL(documentUrl.pathname.endsWith('/') ? documentUrl.pathname : documentUrl.pathname.slice(0, documentUrl.pathname.lastIndexOf('/') + 1), origin);
  function localUrl(value: string, base: URL): URL | null {
    const url = new URL(value, base);
    if (url.origin !== origin) return null;
    const path = canonicalApiPath(url.pathname);
    if (!path?.startsWith(root)) fail('已阻止预览访问目录之外的资源');
    return url;
  }
  function virtualUrl(value: string): URL {
    const url = new URL(value, virtualBase);
    if (url.origin !== new URL(virtualBase).origin || !url.pathname.startsWith(new URL(virtualBase).pathname)) fail('已阻止预览访问服务接口或目录之外的资源');
    const relative = url.pathname.slice(new URL(virtualBase).pathname.length) + url.search;
    return localUrl(relative, rootUrl) ?? fail('预览资源无效');
  }
  function load(url: URL): Promise<Resource> {
    const key = url.pathname + url.search;
    const cached = resources.get(key); if (cached) return cached;
    if (disposed || options.signal?.aborted) return Promise.reject(new Error('预览已关闭'));
    if (resources.size >= MAX_RESOURCES) return Promise.reject(new Error('预览资源数量超出限制'));
    const promise = options.fetch(key, { signal: options.signal, redirect: 'manual' }).then(read);
    resources.set(key, promise); return promise;
  }
  function blob(data: BlobPart, type: string): string {
    if (disposed) fail('预览已关闭');
    const url = `termdock-resource-${capability}-${packed.length}`; packed.push({ token: url, data, type }); urls.add(url); return url;
  }
  async function asset(value: string, base: URL, kind: 'css' | 'script' | 'resource', stack: Set<string> = new Set()): Promise<string> {
    if (!value || value.startsWith('#')) return value;
    if (/^data:(?:image|font)\//i.test(value) && kind === 'resource') return value;
    try {
      const url = localUrl(value, base);
      if (!url) {
        const external = new URL(value, base);
        if (external.protocol !== 'https:' || external.username || external.password || external.origin === new URL(virtualBase).origin) fail('已阻止不安全的外部资源');
        externalOrigins.add(external.origin); return external.href;
      }
      const key = `${kind}:${url.href}`;
      if (stack.has(key) || stack.size >= 8) fail('预览资源存在循环或过深引用');
      const cached = rewritten.get(key); if (cached) return cached;
      const next = new Set(stack); next.add(key);
      const promise = (async () => {
        const resource = await load(url);
        if (kind === 'css') return blob(await css(new TextDecoder().decode(resource.bytes), url, next), 'text/css');
        if (kind === 'script') return blob(resource.bytes as Uint8Array<ArrayBuffer>, 'text/javascript');
        return blob(resource.bytes as Uint8Array<ArrayBuffer>, resource.type);
      })();
      rewritten.set(key, promise); return await promise;
    } catch (error) { report(error instanceof Error ? error.message : '部分预览资源未能加载'); return BLOCKED; }
  }
  async function css(text: string, base: URL, stack: Set<string>): Promise<string> {
    // Resolve imports first so nested stylesheets retain their own relative directory.
    text = await replaceAsync(text, /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?([^;]*);/gi, async match => {
      const url = await asset(match[1], base, 'css', stack);
      return `@import url("${url}")${match[2]};`;
    });
    return replaceAsync(text, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, async match => {
      const value = (match[1] ?? match[2] ?? match[3]).trim();
      if (urls.has(value)) return match[0];
      return `url("${await asset(value, base, 'resource', stack)}")`;
    });
  }
  try {
    const main = await read(documentResponse);
    const document = new DOMParser().parseFromString(new TextDecoder().decode(main.bytes), 'text/html');
    document.querySelectorAll('base,meta[http-equiv],iframe,frame,object,embed').forEach(node => node.remove());
    for (const node of document.querySelectorAll<HTMLElement>('*')) {
      node.removeAttribute('ping'); node.removeAttribute('srcdoc');
      if (node.hasAttribute('style')) node.setAttribute('style', await css(node.getAttribute('style')!, documentUrl, new Set()));
      if (node.tagName === 'STYLE') node.textContent = await css(node.textContent ?? '', documentUrl, new Set());
      if (node.tagName === 'FORM') { node.removeAttribute('action'); node.removeAttribute('method'); }
      if (node.tagName === 'A' || node.tagName === 'AREA') {
        const href = node.getAttribute('href');
        if (href && !href.startsWith('#')) { node.removeAttribute('href'); node.setAttribute('title', '预览中的页面跳转已禁用'); }
      }
      for (const name of ['action', 'formaction', 'data', 'manifest']) node.removeAttribute(name);
      if (node.tagName === 'SCRIPT' && node.getAttribute('type') === 'module') {
        node.remove(); report('模块脚本的动态依赖暂不支持安全预览'); continue;
      }
      if (node.tagName === 'LINK') {
        const rel = (node.getAttribute('rel') ?? '').toLowerCase();
        if (!['stylesheet', 'icon'].includes(rel)) { node.remove(); continue; }
        const href = node.getAttribute('href'); if (href) node.setAttribute('href', await asset(href, documentUrl, rel === 'stylesheet' ? 'css' : 'resource'));
      }
      if (node.hasAttribute('src')) node.setAttribute('src', await asset(node.getAttribute('src')!, documentUrl, node.tagName === 'SCRIPT' ? 'script' : 'resource'));
      if (node.hasAttribute('poster')) node.setAttribute('poster', await asset(node.getAttribute('poster')!, documentUrl, 'resource'));
      if (node.hasAttribute('srcset')) {
        const source = node.getAttribute('srcset')!;
        if (/data:/i.test(source)) { node.removeAttribute('srcset'); report('混合内嵌图片候选暂不支持安全预览'); }
        else node.setAttribute('srcset', (await Promise.all(source.split(',').map(async item => {
          const [url, ...descriptor] = item.trim().split(/\s+/); return `${await asset(url, documentUrl, 'resource')} ${descriptor.join(' ')}`;
        }))).join(', '));
      }
      node.setAttribute('referrerpolicy', 'no-referrer');
      // Blob/data resources do not need the original integrity hash after rewriting.
      node.removeAttribute('integrity'); node.removeAttribute('crossorigin');
    }
    const sources = [...externalOrigins].join(' ');
    const csp = document.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
    csp.content = `default-src 'none'; script-src 'unsafe-inline' blob: ${sources}; style-src 'unsafe-inline' blob: ${sources}; img-src blob: data: ${sources}; font-src blob: data: ${sources}; media-src blob: data: ${sources}; connect-src ${sources || "'none'"}; frame-src 'none'; object-src 'none'; base-uri https://termdock-preview.invalid; form-action 'none'`;
    const base = document.createElement('base'); base.href = virtualBase;
    const referrer = document.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer';
    const bootstrap = document.createElement('script'); bootstrap.textContent = previewBootstrap(capability, virtualBase, [...externalOrigins]);
    document.head.prepend(csp, referrer, base, bootstrap);
    const html = '<!doctype html>\n' + document.documentElement.outerHTML;
    return {
      html, shellUrl: `/preview-shell.html#${capability}`, errors,
      attach(frame, onError) {
        const pending = new Set<MessagePort>();
        const listener = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.data?.capability !== capability) return;
          if (event.data.type === 'preview-ready') { frame.contentWindow?.postMessage({ type: 'preview-init', capability, html, resources: packed }, '*'); return; }
          if (event.data.type === 'preview-error') { onError('部分动态内容被安全预览限制'); return; }
          if (event.data.type !== 'preview-fetch' || event.ports.length !== 1) return;
          const port = event.ports[0];
          if (pending.size >= 8 || !['GET', 'HEAD'].includes(event.data.method)) { port.postMessage({ error: '预览仅允许读取已授权目录资源' }); port.close(); return; }
          pending.add(port);
          void (async () => {
            const url = virtualUrl(String(event.data.url));
            const resource = await load(url);
            if (!pending.has(port) || disposed) return;
            const bytes = event.data.method === 'HEAD' ? new Uint8Array() : resource.bytes.slice();
            port.postMessage({ status: resource.status, headers: { 'content-type': resource.type }, data: bytes.buffer }, [bytes.buffer]);
          })().catch(() => { port.postMessage({ error: '预览资源不在授权范围或无法加载' }); onError('部分动态资源不可用或超出预览目录'); })
            .finally(() => { pending.delete(port); port.close(); });
        };
        window.addEventListener('message', listener);
        const close = () => { window.removeEventListener('message', listener); for (const port of pending) port.close(); pending.clear(); liveBridges.delete(close); };
        liveBridges.add(close); return close;
      },
      dispose: release,
    };
  } catch (error) { release(); throw error; }
}

function previewBootstrap(capability: string, virtualBase: string, externalOrigins: string[]): string {
  return `(() => {
    const capability=${scriptText(capability)}, base=${scriptText(virtualBase)}, external=new Set(${scriptText(externalOrigins)});
    const report=()=>parent.postMessage({type:'preview-error',capability},'*');
    const nativeFetch=window.fetch.bind(window);
    Object.defineProperty(window,'fetch',{configurable:false,writable:false,value:async(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url||String(input),base);
      const method=String(init.method||(input&&input.method)||'GET').toUpperCase();
      if(!['GET','HEAD'].includes(method)){report();throw new Error('Preview is read-only');}
      if(external.has(url.origin))return nativeFetch(url.href,{...init,method,credentials:'omit',referrerPolicy:'no-referrer'});
      if(url.origin!==new URL(base).origin||!url.pathname.startsWith(new URL(base).pathname)){report();throw new Error('Outside preview scope');}
      return new Promise((resolve,reject)=>{
        const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();report();reject(new Error('Preview resource timeout'));},15000);
        channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();if(e.data.error){report();reject(new Error(e.data.error));}else resolve(new Response(method==='HEAD'?null:e.data.data,{status:e.data.status,headers:e.data.headers}));};
        parent.postMessage({type:'preview-fetch',capability,url:url.href,method},'*',[channel.port2]);
      });
    }});
    for(const name of ['XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker'])Object.defineProperty(window,name,{configurable:false,writable:false,value:function(){report();throw new Error(name+' is unavailable in secure preview');}});
    Object.defineProperty(window,'open',{configurable:false,writable:false,value:()=>{report();return null;}});
    document.addEventListener('submit',e=>{e.preventDefault();report();},true);
    document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a,area');if(a&&a.getAttribute('href')&&!a.getAttribute('href').startsWith('#')){e.preventDefault();report();}},true);
    window.addEventListener('securitypolicyviolation',report);
    window.addEventListener('error',report,true);
    window.addEventListener('unhandledrejection',report);
  })();`;
}
