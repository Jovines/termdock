// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('terminal font startup', () => {
  it('waits for normal and bold prompt icons before exposing the terminal', async () => {
    let finish!: (value: unknown[]) => void;
    const icons = new Promise<unknown[]>(resolve => { finish = resolve; });
    const load = vi.fn((font: string) => font.includes('Termdock Prompt Icons') ? icons : Promise.resolve([]));
    vi.stubGlobal('document', { fonts: { load, ready: Promise.resolve() } });
    const { ensureTerminalFontsReady } = await import('./fontLoading');
    let ready = false;
    const pending = ensureTerminalFontsReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    for (const weight of ['400', '700']) {
      expect(load).toHaveBeenCalledWith(`${weight} 14px "Termdock Prompt Icons"`, expect.stringContaining('\uf179'));
      expect(load).toHaveBeenCalledWith(`${weight} 14px "Termdock Prompt Icons"`, expect.stringContaining('\uf115'));
      expect(load).toHaveBeenCalledWith(`${weight} 14px "Termdock Prompt Icons"`, expect.stringContaining('\ue0a0'));
    }
    finish([]);
    await pending;
    expect(ready).toBe(true);
    const calls = load.mock.calls.length;
    await ensureTerminalFontsReady();
    expect(load).toHaveBeenCalledTimes(calls);
  });

  it('still starts with fallback fonts when a font download fails', async () => {
    vi.stubGlobal('document', { fonts: { load: vi.fn().mockRejectedValue(new Error('offline')), ready: Promise.resolve() } });
    const { ensureTerminalFontsReady } = await import('./fontLoading');
    await expect(ensureTerminalFontsReady()).resolves.toBeUndefined();
  });

  it('supports environments without the font loading API', async () => {
    vi.stubGlobal('document', {});
    const { ensureTerminalFontsReady } = await import('./fontLoading');
    await expect(ensureTerminalFontsReady()).resolves.toBeUndefined();
  });
});
