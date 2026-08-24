import { describe, expect, it } from 'vitest';
import { edaViewLabel, formatEdaAnnotation } from './EdaPreview';

describe('EDA annotation', () => {
  it('formats an absolute, view-specific review reference', () => {
    expect(formatEdaAnnotation('/home/qiao/板卡/control.kicad_pcb', 'pcb-back', {
      xPercent: 12.345,
      yPercent: 67.89,
    })).toBe('"电子标注: /home/qiao/板卡/control.kicad_pcb / 视图: PCB背面（镜像） / 图片位置: (12.3%,67.9%) [相对渲染图左上角]"');
  });

  it('adds engineering coordinates, layer, and nearest KiCad object', () => {
    expect(formatEdaAnnotation('/work/control.kicad_pcb', 'pcb-front', {
      xPercent: 51.2,
      yPercent: 78.5,
    }, {
      available: true,
      xMm: 28.674,
      yMm: 44.017,
      layer: 'F.Cu',
      nearest: {
        kind: 'pad',
        label: 'J1 焊盘 2',
        reference: 'J1',
        pad: '2',
        net: 'GND',
        layer: 'F.Cu',
        distanceMm: 0.284,
      },
    })).toBe('"电子标注: /work/control.kicad_pcb / 视图: PCB正面 / 图片位置: (51.2%,78.5%) [相对渲染图左上角] / PCB坐标: (28.67,44.02)mm [KiCad板坐标] / 显示层: F.Cu / 最近对象: J1 焊盘 2（网络 GND，对象层 F.Cu，距离 0.28mm）"');
  });

  it('labels every supported rendered view', () => {
    expect(edaViewLabel('schematic')).toBe('原理图第1页');
    expect(edaViewLabel('pcb-front')).toBe('PCB正面');
    expect(edaViewLabel('pcb-back')).toBe('PCB背面（镜像）');
    expect(edaViewLabel('pcb-3d')).toBe('PCB 3D正面');
  });
});
