import { describe, expect, it } from 'vitest';
import {
  cellToClientPoint,
  clampMobileCopyPopoverPosition,
  clampCellToBuffer,
  getTerminalGridMetrics,
  orderSelectionEndpoints,
  selectionCellsToClientBounds,
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

describe('selectionCellsToClientBounds', () => {
  it('单行选区使用真实首尾列', () => {
    expect(selectionCellsToClientBounds(makeTerminal(), { col: 3, row: 2 }, { col: 8, row: 2 })).toEqual({
      left: 40,
      top: 60,
      right: 100,
      bottom: 80,
    });
  });

  it('多行选区横向覆盖完整终端，并裁到当前视口', () => {
    expect(selectionCellsToClientBounds(
      makeTerminal({ viewportY: 100 }),
      { col: 30, row: 98 },
      { col: 4, row: 105 },
    )).toEqual({ left: 10, top: 20, right: 810, bottom: 140 });
  });

  it('选区完全滚出视口时返回 null', () => {
    expect(selectionCellsToClientBounds(
      makeTerminal({ viewportY: 100 }),
      { col: 0, row: 90 },
      { col: 5, row: 91 },
    )).toBeNull();
  });
});

describe('clampMobileCopyPopoverPosition', () => {
  const base = {
    viewport: { left: 0, top: 0, right: 390, bottom: 844 },
    terminal: { left: 20, top: 100, right: 370, bottom: 700 },
    width: 88,
    height: 36,
    margin: 10,
    fingerGap: 14,
  };

  it('把横向位置限制在当前终端内', () => {
    expect(clampMobileCopyPopoverPosition({ ...base, clientX: 0, clientY: 300 }).left).toBe(30);
    expect(clampMobileCopyPopoverPosition({ ...base, clientX: 390, clientY: 300 }).left).toBe(272);
  });

  it('把纵向位置限制在当前终端内，并在顶部放不下时改放手指下方', () => {
    expect(clampMobileCopyPopoverPosition({ ...base, clientX: 200, clientY: 105 }).top).toBe(119);
    expect(clampMobileCopyPopoverPosition({ ...base, clientX: 200, clientY: 710 }).top).toBe(654);
  });

  it('终端与 visual viewport 相交后再计算安全边界', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 200,
      clientY: 400,
      viewport: { left: 50, top: 180, right: 340, bottom: 600 },
    });
    expect(position).toEqual({ left: 156, top: 350 });
  });

  it('终端空间小于气泡时不会产生反向边界', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 45,
      clientY: 125,
      terminal: { left: 20, top: 100, right: 70, bottom: 140 },
    });
    expect(position).toEqual({ left: 30, top: 110 });
  });

  it('有空间时优先放在选区上方，而不是跟随抬手位置', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 330,
      clientY: 610,
      selection: { left: 80, top: 300, right: 260, bottom: 340 },
    });
    expect(position).toEqual({ left: 126, top: 250 });
  });

  it('顶部放不下时放到选区下方', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 120,
      clientY: 150,
      selection: { left: 80, top: 105, right: 260, bottom: 145 },
    });
    expect(position).toEqual({ left: 126, top: 159 });
  });

  it('安全空间不足时避开手柄和手指热区', () => {
    const avoid = { left: 140, top: 110, right: 230, bottom: 190 };
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 185,
      clientY: 150,
      terminal: { left: 20, top: 100, right: 370, bottom: 240 },
      selection: { left: 20, top: 100, right: 370, bottom: 240 },
      avoid: [avoid],
    });
    const popover = { left: position.left, top: position.top, right: position.left + 88, bottom: position.top + 36 };
    const overlapsAvoid = popover.left < avoid.right && popover.right > avoid.left
      && popover.top < avoid.bottom && popover.bottom > avoid.top;
    expect(overlapsAvoid).toBe(false);
  });

  it('向上扩选时把按钮放在选区下方，留出活动端前方空间', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 120,
      clientY: 300,
      selection: { left: 60, top: 280, right: 330, bottom: 500 },
      preference: { vertical: 'below', alignX: 195, focusX: 120, focusY: 280 },
    });
    expect(position).toEqual({ left: 151, top: 514 });
  });

  it('同行扩选时可偏向固定端，不占活动端上方', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 300,
      clientY: 320,
      selection: { left: 80, top: 300, right: 320, bottom: 320 },
      preference: { vertical: 'above', alignX: 140, focusX: 300, focusY: 310 },
    });
    expect(position).toEqual({ left: 96, top: 250 });
  });

  it('为选区外侧的 44px 手柄热区预留完整净空', () => {
    const position = clampMobileCopyPopoverPosition({
      ...base,
      clientX: 300,
      clientY: 340,
      selection: { left: 80, top: 320, right: 320, bottom: 340 },
      selectionGap: 52,
      preference: { vertical: 'above', alignX: 200, focusX: 300, focusY: 330 },
    });
    expect(position).toEqual({ left: 156, top: 232 });
    expect(position.top + base.height).toBe(320 - 52);
  });
});
