/**
 * Line-range selection helpers shared by the file preview and the diff viewer.
 * Leaf module on purpose: the diff viewer must not import from RightSidebar
 * (which already imports the diff viewer), so anything both surfaces need
 * lives here.
 */

export type LineRange = { start: number; end: number };

/**
 * Tap-to-select semantics for reference ranges: tapping the exact same range
 * again clears it, tapping a second line while a single line is selected
 * extends to cover both, anything else restarts at the tapped line.
 */
export function getNextReferenceLineRange(
  current: LineRange | null,
  startLine: number,
  endLine: number,
): LineRange | null {
  const nextStart = Math.min(startLine, endLine);
  const nextEnd = Math.max(startLine, endLine);
  if (current?.start === nextStart && current.end === nextEnd) return null;
  if (current && current.start === current.end) {
    return {
      start: Math.min(current.start, nextStart),
      end: Math.max(current.end, nextEnd),
    };
  }
  return { start: nextStart, end: nextEnd };
}

export function getReferenceFloatingButtonClass(isMobile: boolean, completed: boolean): string {
  const sizeClass = isMobile ? 'h-9 px-4 text-[12px]' : 'h-7 px-3 text-[11px]';
  const toneClass = completed
    ? 'bg-surface-elevated text-foreground ring-border-strong/40 hover:bg-surface-2'
    : 'bg-primary text-primary-foreground ring-primary/30 hover:bg-primary/90';
  // 局部刻度 z-30（面板内部悬浮钮铁律 < 40）：高于 sticky 表头(z-10)，
  // 但任何全屏浮层（lightbox / modal / drawer）打开时必然盖住它。
  // 曾经用 z-popover(200) → lightbox(110) 打开后按钮还浮在图上面。
  return `pointer-events-auto absolute z-30 inline-flex items-center gap-1 rounded-full font-semibold shadow-lg ring-1 transition active:scale-95 ${sizeClass} ${toneClass}`;
}

/** True while the user has a live text selection — taps must not hijack it. */
export function hasNativeTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}
