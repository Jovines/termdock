import { describe, expect, it, vi } from 'vitest';
import { EDA_PREVIEW_REQUEST_TIMEOUT_MS, readEdaPreviewBlob, EDA_EXTENSIONS, getDefaultEdaPreviewView, getEdaExtForPath, inspectEdaPoint, isPreviewableEdaPath } from './api';

describe('KiCad preview file classification', () => {
  it('recognizes schematic and PCB sources case-insensitively', () => {
    expect(EDA_EXTENSIONS).toEqual(['.kicad_sch', '.kicad_pcb']);
    expect(getEdaExtForPath('/work/控制板.KICAD_SCH')).toBe('.kicad_sch');
    expect(getEdaExtForPath('/work/控制板.kicad_pcb')).toBe('.kicad_pcb');
    expect(isPreviewableEdaPath('/work/控制板.kicad_pro')).toBe(false);
  });

  it('requests an engineering point inspection with the selected view and coordinates', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ available: true, xMm: 12.3, yMm: 45.6, layer: 'F.Cu' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(inspectEdaPoint('/work/控制板.kicad_pcb', 'pcb-front', 25, 75)).resolves.toMatchObject({
        available: true,
        xMm: 12.3,
        yMm: 45.6,
      });
      expect(requestedUrl).toContain('/api/terminal/fs/eda-inspect?');
      expect(requestedUrl).toContain('view=pcb-front');
      expect(requestedUrl).toContain('x=25');
      expect(requestedUrl).toContain('y=75');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('chooses the matching default view', () => {
    expect(getDefaultEdaPreviewView('main.kicad_sch')).toBe('schematic');
    expect(getDefaultEdaPreviewView('main.kicad_pcb')).toBe('pcb-front');
  });
});


describe('KiCad preview transfer deadline', () => {
  it('allows a slow response body past the old 12/30 second deadlines and still bounds a stalled transfer', async () => {
    vi.useFakeTimers();
    let transferSignal: AbortSignal | undefined;
    let completeBody: ((blob: Blob) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      transferSignal = init.signal;
      return {
        ok: true,
        headers: new Headers(),
        blob: () => new Promise<Blob>((resolve, reject) => {
          completeBody = resolve;
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
      };
    }));
    try {
      const preview = readEdaPreviewBlob('/board.kicad_pcb', 'pcb-3d');
      await vi.advanceTimersByTimeAsync(35_000);
      expect(transferSignal?.aborted).toBe(false);
      completeBody!(new Blob(['glb']));
      await expect(preview).resolves.toMatchObject({ view: 'pcb-3d' });
      expect(vi.getTimerCount()).toBe(0);

      const stalled = readEdaPreviewBlob('/board.kicad_pcb', 'pcb-3d');
      const rejection = expect(stalled).rejects.toThrow('rendering or transfer timed out');
      await vi.advanceTimersByTimeAsync(EDA_PREVIEW_REQUEST_TIMEOUT_MS);
      await rejection;
      expect(transferSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const controller = new AbortController();
      const cancelled = readEdaPreviewBlob('/board.kicad_pcb', 'pcb-front', controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      const cancellation = expect(cancelled).rejects.toThrow('User cancelled');
      controller.abort(new Error('User cancelled'));
      await cancellation;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
