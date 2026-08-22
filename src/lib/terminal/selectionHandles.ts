// 移动端选区 handle 的几何换算（纯函数，方便单测）。
// 与 TerminalViewport.tsx 的 getTerminalCellFromPoint 互为逆运算：
// 那里把 clientX/Y 折成 buffer 行列，这里把 buffer 行列折回 client 像素，
// 用来定位「首/尾拖动 handle」。两端共用 getTerminalGridMetrics 的真实
// 几何，保证 handle、手指落点、xterm 画的选区高亮三者严格一致。

export interface SelectionCell {
  col: number;
  row: number;
}

export interface ClientRectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersectRects(a: ClientRectBounds, b: ClientRectBounds): ClientRectBounds | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function overlapArea(a: ClientRectBounds, b: ClientRectBounds): number {
  const overlap = intersectRects(a, b);
  return overlap ? (overlap.right - overlap.left) * (overlap.bottom - overlap.top) : 0;
}

/** xterm Terminal 的最小结构子集，测试里可用 stub 传入。 */
export interface TerminalGeometryLike {
  cols: number;
  rows: number;
  element: {
    offsetWidth: number;
    offsetHeight: number;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    querySelector?: (selector: string) => {
      getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    } | null;
  } | null | undefined;
  dimensions?: {
    css?: {
      cell?: { width?: number; height?: number };
    };
  };
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
    };
  };
}

export interface TerminalGridMetrics {
  /** client px，第 0 列左缘 */
  originLeft: number;
  /** client px，视口第 0 行上缘 */
  originTop: number;
  cellW: number;
  cellH: number;
}

/**
 * 终端网格的真实几何。
 * - 原点取 `.xterm-screen` 的 rect（网格真正起点）：`.terminal` 容器因
 *   fit 取整会在底部留白，`offsetHeight/rows` 均分会随行号向下漂移。
 * - cellW 恒用 screen rect 均分：本仓库 CSS 强制 `.xterm-screen canvas`
 *   `width:100%`（index.css:827），画布横向被拉伸，xterm 实测 cellW
 *   （dimensions.css.cell.width）与渲染结果不一致。
 * - cellH 优先 xterm 实测值，取不到再均分。
 */
export function getTerminalGridMetrics(
  terminal: TerminalGeometryLike
): TerminalGridMetrics | null {
  const element = terminal.element;
  if (!element || !terminal.cols || !terminal.rows) return null;
  const screenEl = element.querySelector?.('.xterm-screen') ?? null;
  const rect = (screenEl ?? element).getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const measuredH = terminal.dimensions?.css?.cell?.height;
  const cellW = rect.width / terminal.cols;
  const cellH = measuredH && measuredH > 0 ? measuredH : rect.height / terminal.rows;
  return { originLeft: rect.left, originTop: rect.top, cellW, cellH };
}

/**
 * buffer 行列 → client 像素（该格的上边缘水平中点）。
 * 端点滚出当前视口时返回 null（调用方据此隐藏对应 handle，
 * 选区本身在 buffer 里仍然有效）。
 */
export function cellToClientPoint(
  terminal: TerminalGeometryLike,
  cell: SelectionCell
): { x: number; y: number } | null {
  const m = getTerminalGridMetrics(terminal);
  if (!m) return null;
  const viewportRow = cell.row - terminal.buffer.active.viewportY;
  if (viewportRow < 0 || viewportRow >= terminal.rows) return null;
  const col = Math.max(0, Math.min(terminal.cols - 1, cell.col));
  return {
    x: m.originLeft + (col + 0.5) * m.cellW,
    y: m.originTop + viewportRow * m.cellH,
  };
}

/** 把拖动落点钳到 buffer 有效范围（行 0..baseY+rows-1，列 0..cols-1）。 */
export function clampCellToBuffer(
  terminal: TerminalGeometryLike,
  cell: SelectionCell
): SelectionCell {
  const maxRow = Math.max(0, terminal.buffer.active.baseY + terminal.rows - 1);
  return {
    col: Math.max(0, Math.min(terminal.cols - 1, cell.col)),
    row: Math.max(0, Math.min(maxRow, cell.row)),
  };
}

/**
 * 把无序的 anchor/focus 按线性 offset 排成首/尾。
 * selectTerminalRange 用同样的 row*cols+col 展平方式，保持一致。
 */
export function orderSelectionEndpoints(
  anchor: SelectionCell,
  focus: SelectionCell,
  cols: number
): { start: SelectionCell; end: SelectionCell } {
  const anchorOffset = anchor.row * cols + anchor.col;
  const focusOffset = focus.row * cols + focus.col;
  return anchorOffset <= focusOffset
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

/**
 * 当前可视部分的选区包围盒。单行选区按真实首尾列计算，多行选区中间行
 * 会铺满终端宽度，因此横向使用完整网格。选区完全滚出视口时返回 null。
 */
export function selectionCellsToClientBounds(
  terminal: TerminalGeometryLike,
  anchor: SelectionCell,
  focus: SelectionCell,
): ClientRectBounds | null {
  const m = getTerminalGridMetrics(terminal);
  if (!m) return null;
  const { start, end } = orderSelectionEndpoints(anchor, focus, terminal.cols);
  const viewportY = terminal.buffer.active.viewportY;
  const viewportEnd = viewportY + terminal.rows - 1;
  if (end.row < viewportY || start.row > viewportEnd) return null;

  const visibleStartRow = Math.max(start.row, viewportY);
  const visibleEndRow = Math.min(end.row, viewportEnd);
  const top = m.originTop + (visibleStartRow - viewportY) * m.cellH;
  const bottom = m.originTop + (visibleEndRow - viewportY + 1) * m.cellH;
  if (start.row === end.row) {
    return {
      left: m.originLeft + start.col * m.cellW,
      top,
      right: m.originLeft + (end.col + 1) * m.cellW,
      bottom,
    };
  }
  return {
    left: m.originLeft,
    top,
    right: m.originLeft + terminal.cols * m.cellW,
    bottom,
  };
}

/**
 * 把移动端复制气泡放进「可视窗口 ∩ 当前终端」内。
 * 有选区时依次考虑上、下、左右与安全区边角，并按以下优先级评分：
 * 1. 绝不挡住选区手柄/当前手指的触控热区；
 * 2. 尽量不盖住选中文字；
 * 3. 同等条件下优先选区上方。
 * 没有选区几何时保留原先的“手指上方，放不下则下方”回退。
 */
export function clampMobileCopyPopoverPosition(input: {
  clientX: number;
  clientY: number;
  viewport: ClientRectBounds;
  terminal: ClientRectBounds;
  width: number;
  height: number;
  margin: number;
  fingerGap: number;
  selection?: ClientRectBounds | null;
  avoid?: ClientRectBounds[];
  selectionGap?: number;
  preference?: {
    vertical: 'above' | 'below';
    alignX: number;
    focusX: number;
    focusY: number;
  };
}): { left: number; top: number } {
  const boundsLeft = Math.max(input.viewport.left, input.terminal.left);
  const boundsTop = Math.max(input.viewport.top, input.terminal.top);
  const boundsRight = Math.min(input.viewport.right, input.terminal.right);
  const boundsBottom = Math.min(input.viewport.bottom, input.terminal.bottom);
  const minLeft = boundsLeft + input.margin;
  const minTop = boundsTop + input.margin;
  const maxLeft = Math.max(minLeft, boundsRight - input.width - input.margin);
  const maxTop = Math.max(minTop, boundsBottom - input.height - input.margin);

  const clampLeft = (left: number) => Math.max(minLeft, Math.min(left, maxLeft));
  const clampTop = (top: number) => Math.max(minTop, Math.min(top, maxTop));
  const selection = input.selection ? intersectRects(input.selection, {
    left: boundsLeft,
    top: boundsTop,
    right: boundsRight,
    bottom: boundsBottom,
  }) : null;

  if (!selection) {
    const left = clampLeft(input.clientX - input.width / 2);
    const preferredTop = input.clientY - input.height - input.fingerGap;
    const fallbackTop = input.clientY + input.fingerGap;
    const top = clampTop(preferredTop >= minTop ? preferredTop : fallbackTop);
    return { left: Math.round(left), top: Math.round(top) };
  }

  const centerX = (selection.left + selection.right) / 2;
  const centerY = (selection.top + selection.bottom) / 2;
  const alignX = input.preference?.alignX ?? centerX;
  const selectionGap = input.selectionGap ?? input.fingerGap;
  const aboveTop = selection.top - input.height - selectionGap;
  const belowTop = selection.bottom + selectionGap;
  const preferredTop = input.preference?.vertical === 'below' ? belowTop : aboveTop;
  const oppositeTop = input.preference?.vertical === 'below' ? aboveTop : belowTop;
  const corners = [
    { left: minLeft, top: minTop },
    { left: maxLeft, top: minTop },
    { left: minLeft, top: maxTop },
    { left: maxLeft, top: maxTop },
  ];
  if (input.preference) {
    corners.sort((a, b) => {
      const distance = (candidate: { left: number; top: number }) => {
        const x = candidate.left + input.width / 2;
        const y = candidate.top + input.height / 2;
        return Math.hypot(x - input.preference!.focusX, y - input.preference!.focusY);
      };
      return distance(b) - distance(a);
    });
  }
  const rawCandidates = [
    // 首选始终在拖动方向的“身后”，并偏向固定端；第二候选才居中。
    { left: alignX - input.width / 2, top: preferredTop },
    { left: centerX - input.width / 2, top: preferredTop },
    { left: alignX - input.width / 2, top: oppositeTop },
    { left: centerX - input.width / 2, top: oppositeTop },
    { left: selection.left - input.width - input.fingerGap, top: centerY - input.height / 2 },
    { left: selection.right + input.fingerGap, top: centerY - input.height / 2 },
    ...corners,
  ].map((candidate) => ({
    left: clampLeft(candidate.left),
    top: clampTop(candidate.top),
  }));

  let best = rawCandidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  rawCandidates.forEach((candidate, index) => {
    const rect = {
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + input.width,
      bottom: candidate.top + input.height,
    };
    const avoidOverlap = (input.avoid ?? []).reduce((sum, avoid) => sum + overlapArea(rect, avoid), 0);
    const score = (avoidOverlap > 0 ? 1_000_000 : 0)
      + avoidOverlap * 100
      + overlapArea(rect, selection) * 10
      + index * 0.01;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  return { left: Math.round(best.left), top: Math.round(best.top) };
}
