import { describe, expect, it } from 'vitest';
import { EDA_EXTENSIONS, getDefaultEdaPreviewView, getEdaExtForPath, inspectEdaPoint, isPreviewableEdaPath } from './api';

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
