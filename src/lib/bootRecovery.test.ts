// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(`${process.cwd()}/index.html`, 'utf8');
const script = html.match(/<script>\s*(\/\/ Keep recovery[\s\S]*?)<\/script>/)![1];
function boot(storage = new Map<string, string>()) {
  document.documentElement.innerHTML = html;
  const callbacks: Record<string, (event: unknown) => void> = {};
  const reload = vi.fn();
  const setTimeout = vi.fn();
  const context = {
    window: { addEventListener: (name: string, fn: typeof callbacks[string]) => { callbacks[name] = fn; }, location: { reload } },
    document, navigator: { language: 'zh-CN' },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout, clearTimeout: vi.fn(),
  };
  runInNewContext(script, context);
  const fail = () => callbacks.error({ target: document.querySelector('script[type="module"]') });
  return { ...context, fail, reload, callbacks };
}
describe('standalone boot recovery', () => {
  it('recovers a failed entry without any application module or service worker', () => {
    const page = boot(); page.fail();
    expect(page.document.body.textContent).toContain('启动资源加载失败');
    expect(page.setTimeout.mock.calls[0][1]).toBe(2000);
    page.setTimeout.mock.calls[0][0]();
    expect(page.reload).toHaveBeenCalledOnce();
  });
  it('bounds retries across failed reloads and allows manual recovery', () => {
    const storage = new Map<string, string>();
    for (let i = 0; i < 4; i++) {
      const page = boot(storage); page.fail(); page.fail();
      expect(page.setTimeout).toHaveBeenCalledTimes(i < 3 ? 1 : 0);
      if (i === 3) {
        page.document.querySelector('button')!.click();
        expect(page.reload).toHaveBeenCalledOnce();
        expect(storage.size).toBe(0);
      }
      }
  });
  it('ignores noncritical resources and cancels recovery after React mounts', () => {
    const page = boot();
    page.callbacks.error({ target: page.document.createElement('img') });
    expect(page.setTimeout).not.toHaveBeenCalled();
    page.fail();
    page.document.getElementById('root')!.innerHTML = '<main>Connected</main>';
    page.setTimeout.mock.calls[0][0]();
    expect(page.reload).not.toHaveBeenCalled();
  });
});
