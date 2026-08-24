import { describe, expect, it } from 'vitest';
import { formatKicadProjectAnnotation, summarizeKicadJson } from './KicadProjectPreview';

describe('KiCad project JSON preview', () => {
  it('summarizes manufacturing-relevant project defaults', () => {
    const items = summarizeKicadJson(JSON.stringify({
      meta: { version: 3 },
      board: { design_settings: { drc_exclusions: [] } },
      net_settings: { classes: [{ name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }] },
    }), false);
    expect(items).toContainEqual({ label: '默认线宽', value: '0.25 mm' });
    expect(items).toContainEqual({ label: 'DRC 排除项', value: '0' });
  });

  it('marks local state files as non-design data', () => {
    const items = summarizeKicadJson('{"meta":{"version":5},"board":{"active_layer":0}}', true);
    expect(items[0].value).toContain('不属于电气设计源文件');
  });

  it('formats a setting annotation', () => {
    expect(formatKicadProjectAnnotation('/work/a.kicad_pro', { label: '默认线宽', value: '0.2 mm' }))
      .toBe('"KiCad项目标注: /work/a.kicad_pro / 项: 默认线宽 / 值: 0.2 mm"');
  });
});
