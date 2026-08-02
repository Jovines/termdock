import { describe, expect, it } from 'vitest';
import {
  cellToClientPoint,
  clampCellToBuffer,
  getTerminalGridMetrics,
  orderSelectionEndpoints,
  type TerminalGeometryLike,
} from './selectionHandles';

function makeTerminal(overrides: Partial<{
  cols: number;
  rows: number;
  viewportY: number;
  baseY: number;
  offsetWidth: number;
  offsetHeight: number;
  rectLeft: number;
  rectTop: number;
  element: TerminalGeometryLike['element'];
  dimensions: TerminalGeometryLike['dimensions'];
}> = {}): TerminalGeometryLike {
  const cols = overrides.cols ?? 80;
  const rows = overrides.rows ?? 24;
  const offsetWidth = overrides.offsetWidth ?? 800;
  const offsetHeight = overrides.offsetHeight ?? 480;
  const rectLeft = overrides.rectLeft ?? 10;
  const rectTop = overrides.rectTop ?? 20;
  return {
    cols,
    rows,
    element: overrides.element !== undefined ? overrides.element : {
      offsetWidth,
      offsetHeight,
      getBoundingClientRect: () => ({
        left: rectLeft,
        top: rectTop,
        width: offsetWidth,
        height: offsetHeight,
      }),
    },
    dimensions: overrides.dimensions,
    buffer: {
      active: {
        viewportY: overrides.viewportY ?? 0,
        baseY: overrides.baseY ?? 0,
      },
    },
  };
}

describe('getTerminalGridMetrics', () => {
  it('优先用 .xterm-screen 的 rect；cellW 恒按 rect 均分（canvas 被 CSS 拉伸）', () => {
    // .terminal 容器 800x500（底部留白 20px），screen 只有 800x480；
    // 实测 cellH = 20 —— 若按容器均分会算出 500/24 ≈ 20.83 向下漂移。
    // dimensions 里的 cellW=9.9 必须被忽略：canvas 被强制 width:100% 拉伸，
    // 真实列宽 = screen rect 宽 / cols。
    const term = makeTerminal({
      offsetHeight: 500,
      dimensions: { css: { cell: { width: 9.9, height: 20 } } },
    });
    const screenRect = { left: 12, top: 24, width: 800, height: 480 };
    (term.element as NonNullable<TerminalGeometryLike['element']>).querySelector =
      (selector: string) => (selector === '.xterm-screen'
        ? { getBoundingClientRect: () => screenRect }
        : null);
    const m = getTerminalGridMetrics(term);
    expect(m).toEqual({ originLeft: 12, originTop: 24, cellW: 10, cellH: 20 });
  });

  it('没有 .xterm-screen / 实测尺寸时回退到容器 rect 均分', () => {
    const m = getTerminalGridMetrics(makeTerminal());
    expect(m).toEqual({ originLeft: 10, originTop: 20, cellW: 10, cellH: 20 });
  });

  it('element 缺失或 rect 为 0 返回 null', () => {
    expect(getTerminalGridMetrics(makeTerminal({ element: null }))).toBeNull();
    expect(getTerminalGridMetrics(makeTerminal({ offsetWidth: 0 }))).toBeNull();
  });
});

describe('cellToClientPoint', () => {
  it('把行列换算成格子上边缘中点的 client 像素', () => {
    // cellW = 800/80 = 10, cellH = 480/24 = 20
    const p = cellToClientPoint(makeTerminal(), { col: 4, row: 2 });
    expect(p).toEqual({ x: 10 + 4.5 * 10, y: 20 + 2 * 20 });
  });

  it('row 是 buffer 绝对行，需减 viewportY', () => {
    const p = cellToClientPoint(makeTerminal({ viewportY: 100 }), { col: 0, row: 103 });
    expect(p).toEqual({ x: 10 + 0.5 * 10, y: 20 + 3 * 20 });
  });

  it('端点滚出视口（上方）返回 null', () => {
    expect(cellToClientPoint(makeTerminal({ viewportY: 100 }), { col: 0, row: 99 })).toBeNull();
  });

  it('端点滚出视口（下方）返回 null', () => {
    expect(cellToClientPoint(makeTerminal(), { col: 0, row: 24 })).toBeNull();
  });

  it('element 缺失或尺寸为 0 返回 null', () => {
    expect(cellToClientPoint(makeTerminal({ element: null }), { col: 0, row: 0 })).toBeNull();
    expect(cellToClientPoint(makeTerminal({ offsetWidth: 0 }), { col: 0, row: 0 })).toBeNull();
  });

  it('列越界时钳到边缘列', () => {
    const p = cellToClientPoint(makeTerminal(), { col: 999, row: 0 });
    expect(p?.x).toBe(10 + 79.5 * 10);
  });
});

describe('clampCellToBuffer', () => {
  it('钳到 buffer 有效范围', () => {
    const term = makeTerminal({ baseY: 100, rows: 24 }); // 有效行 0..123
    expect(clampCellToBuffer(term, { col: -5, row: -1 })).toEqual({ col: 0, row: 0 });
    expect(clampCellToBuffer(term, { col: 80, row: 200 })).toEqual({ col: 79, row: 123 });
    expect(clampCellToBuffer(term, { col: 10, row: 50 })).toEqual({ col: 10, row: 50 });
  });
});

describe('orderSelectionEndpoints', () => {
  it('anchor 在前时原样返回', () => {
    const r = orderSelectionEndpoints({ col: 2, row: 1 }, { col: 5, row: 3 }, 80);
    expect(r.start).toEqual({ col: 2, row: 1 });
    expect(r.end).toEqual({ col: 5, row: 3 });
  });

  it('focus 在前时交换（反向拖动）', () => {
    const r = orderSelectionEndpoints({ col: 5, row: 3 }, { col: 2, row: 1 }, 80);
    expect(r.start).toEqual({ col: 2, row: 1 });
    expect(r.end).toEqual({ col: 5, row: 3 });
  });

  it('同行按列排序', () => {
    const r = orderSelectionEndpoints({ col: 30, row: 7 }, { col: 10, row: 7 }, 80);
    expect(r.start.col).toBe(10);
    expect(r.end.col).toBe(30);
  });
});
