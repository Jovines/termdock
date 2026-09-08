// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { prepareSecureHtmlPreview } from './secureHtmlPreview';

const token = 'abcdef0123456789abcdef0123456789';
const root = `/api/terminal/fs/preview/${token}/tmp/site/`;
describe('secure HTML resource pack', () => {
  it('loads only the preview directory and sends resources to the matching opaque frame', async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === root + 'index.html') return new Response('<link rel="stylesheet" href="style.css"><script src="app.js"></script><img src="../private.png"><iframe src="/api/terminal/settings"></iframe>');
      if (path === root + 'style.css') return new Response('body{color:red}', { headers: { 'content-type': 'text/css' } });
      if (path === root + 'app.js') return new Response('window.ready=true;');
      throw new Error('Unexpected fetch');
    });
    const preview = await prepareSecureHtmlPreview(root + 'index.html', { fetch, origin: location.origin });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([root + 'index.html', root + 'style.css', root + 'app.js']);
    expect(preview.html).not.toContain('<iframe');
    expect(preview.html).not.toContain(token);
    expect(preview.errors).toContain('已阻止预览访问目录之外的资源');
    expect(preview.shellUrl).toMatch(/^\/preview-shell.html#[a-f0-9-]+$/);
    const frame = document.createElement('iframe'); document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const detach = preview.attach(frame, vi.fn());
    const capability = preview.shellUrl.split('#')[1];
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'preview-ready', capability } }));
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'preview-ready', capability } }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'preview-init', resources: expect.arrayContaining([expect.objectContaining({ type: 'text/css' }), expect.objectContaining({ type: 'text/javascript' })]) }), '*');
    detach(); preview.dispose(); frame.remove();
  });
  it('rejects a redirect that swaps the selected file', async () => {
    await expect(prepareSecureHtmlPreview('/api/terminal/fs/preview/tmp/site/index.html', { origin: location.origin, fetch: async () => new Response(null, { status: 302, headers: { location: root + 'secret.html' } }) })).rejects.toThrow();
  });
});
