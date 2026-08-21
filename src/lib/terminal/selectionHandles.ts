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
 * 把移动端复制气泡放进「可视窗口 ∩ 当前终端」内。
 * preferredAbove 放不下时尝试手指下方，最终再钳到有效矩形；即使终端
 * 比气泡还窄/矮，也固定在其左上安全边缘，避免算出反向边界。
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
}): { left: number; top: number } {
  const boundsLeft = Math.max(input.viewport.left, input.terminal.left);
  const boundsTop = Math.max(input.viewport.top, input.terminal.top);
  const boundsRight = Math.min(input.viewport.right, input.terminal.right);
  const boundsBottom = Math.min(input.viewport.bottom, input.terminal.bottom);
  const minLeft = boundsLeft + input.margin;
  const minTop = boundsTop + input.margin;
  const maxLeft = Math.max(minLeft, boundsRight - input.width - input.margin);
  const maxTop = Math.max(minTop, boundsBottom - input.height - input.margin);

  const unclampedLeft = input.clientX - input.width / 2;
  const left = Math.max(minLeft, Math.min(unclampedLeft, maxLeft));
  const preferredTop = input.clientY - input.height - input.fingerGap;
  const fallbackTop = input.clientY + input.fingerGap;
  const topCandidate = preferredTop >= minTop ? preferredTop : fallbackTop;
  const top = Math.max(minTop, Math.min(topCandidate, maxTop));

  return { left: Math.round(left), top: Math.round(top) };
}
