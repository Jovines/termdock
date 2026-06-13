/**
 * fitTerminal 的 hysteresis 决策：判断"刚算出的新 cols/rows 该不该接受"。
 *
 * 背景：浏览器 layout pass 在亚像素层面是浮点的（DPR 非整数、CSS transform
 * 合成层、flex/grid 容器的 round-half-even、字号微调都会让 clientWidth /
 * getBoundingClientRect().width 有 ±0.5px 范围的抖动）。
 *
 * 终端 fit 把 rect.width / metrics.width 向下取整 (Math.floor) 算 cols。
 * 当 rect.width 落在 metrics.width 的整数倍附近时，亚像素抖动会让 floor
 * 跨越整数边界 → cols 跳 1 → terminal.resize → 全文本重 wrap → 整页字符
 * "抖一下"。
 *
 * 翻页 (page-flip) / visibility / focus / blur 这种"显示状态变化"场景，
 * 容器尺寸理论上一点没变，cols 任何变化都是误差，必须吃掉。
 * 真正的尺寸变化场景（窗口缩放、转屏、DPR 改、新会话）必须立即跟进，
 * 哪怕只差 1 列也接受。
 *
 * 策略：白名单 + threshold。reason 在白名单里 → 任意非零 delta 都接受；
 * 否则 → 必须 delta ≥ HYSTERESIS_THRESHOLD 才接受。
 */

/** delta 必须 ≥ 这个值才接受，除非 reason 在白名单里。 */
export const HYSTERESIS_THRESHOLD = 2;

/**
 * 这些 reason 标记"容器尺寸真的变了或必须强制对齐"，绕过 hysteresis。
 *
 * - mount / init-fit：首次挂载，必须 fit
 * - resize：window/visualViewport/ResizeObserver 真实尺寸变化
 * - dpr-change：DPR 改变 → 字号像素改变 → cols 必须重算
 * - session-key-change / session-reset：切会话或重置，要按当前容器重新算
 * - tmux-layout：服务端推下来的 layout，server 是权威，必须采纳
 */
const REAL_RESIZE_REASONS: ReadonlySet<string> = new Set<string>([
  'mount',
  'init-fit',
  'resize',
  'dpr-change',
  'session-key-change',
  'session-reset',
  'tmux-layout',
]);

export interface FitHysteresisInput {
  /** runRefreshSequence 传进来的 reason（可能带 'refresh:' 前缀）。 */
  reason: string;
  currentCols: number;
  currentRows: number;
  proposedCols: number;
  proposedRows: number;
}

export interface FitHysteresisDecision {
  accept: boolean;
  /** 是否走的是 "白名单"（真实 resize）路径。给日志/调试用。 */
  isRealResize: boolean;
  colsDelta: number;
  rowsDelta: number;
}

/**
 * 判断这次 fit 算出的 cols/rows 该不该 commit 到 terminal.resize()。
 *
 * 不依赖任何 DOM / 全局状态，纯函数。
 */
export function decideFitHysteresis(input: FitHysteresisInput): FitHysteresisDecision {
  const stripped = input.reason.replace(/^refresh:/, '');
  const isRealResize = REAL_RESIZE_REASONS.has(stripped);
  const colsDelta = Math.abs(input.proposedCols - input.currentCols);
  const rowsDelta = Math.abs(input.proposedRows - input.currentRows);
  const accept = isRealResize
    ? (colsDelta > 0 || rowsDelta > 0)
    : (colsDelta >= HYSTERESIS_THRESHOLD || rowsDelta >= HYSTERESIS_THRESHOLD);
  return { accept, isRealResize, colsDelta, rowsDelta };
}
