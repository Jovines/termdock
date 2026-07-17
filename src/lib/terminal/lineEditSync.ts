/**
 * 光标感知的行编辑同步：把「隐藏 textarea 的内容 + 光标」翻译成发给 PTY 的
 * 最小编辑操作序列（光标移动 / 退格 / 插入）。
 *
 * 背景：移动端键盘的括号自动配对（敲 `(` 得到 `()`，光标落在中间）、
 * type-over、滑动光标等交互让编辑点不再固定在行尾。旧的「公共前缀 diff +
 * 退格重打整条尾巴」算法假设编辑只发生在行尾，遇到中间编辑会把
 * sentValueRef 基线和对端行内容打飞，误差逐键累积。
 *
 * 这里的模型约定：
 * - sent / next 是「我们相信对端行里已有的内容」和「textarea 现在的内容」；
 * - 光标位置一律用 code point 计数（readline / vim 按字符移动，不是按
 *   UTF-16 单元，也不是按显示 cell）；
 * - 移动越界由对端行编辑器自行钳制（readline 到行首/行尾即停），
 *   模型漂移不会灾难性放大，下一次 diff 会重新收敛。
 */

export interface LineEditOps {
  /** 光标左移的字符数（\x1b[D 的次数） */
  left?: number;
  /** 光标右移的字符数（\x1b[C 的次数） */
  right?: number;
  /** 退格次数（\x7f 的次数），删除光标前的字符 */
  backspace?: number;
  /** 在光标处插入的文本 */
  insert?: string;
}

export interface CursorAwareEdit {
  /** 有序操作序列：先移动，再退格，再插入，最后对齐光标 */
  ops: LineEditOps[];
  /** 操作全部应用后模型中的光标位置（code points） */
  cursor: number;
}

function toCodePoints(value: string): string[] {
  return Array.from(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 计算把 (sent, sentCursor) 变换为 (next, nextCursor) 所需的最小编辑序列。
 * 内容 diff 用公共前缀 + 公共后缀圈定改动区间；光标先移到删除区间末尾
 * （\x7f 只删光标前的字符），删除并插入后，再对齐到目标光标。
 */
export function computeCursorAwareEdit(
  sent: string,
  next: string,
  sentCursor: number,
  nextCursor: number,
): CursorAwareEdit {
  const sentChars = toCodePoints(sent);
  const nextChars = toCodePoints(next);

  let cursor = clamp(sentCursor, 0, sentChars.length);
  const targetCursor = clamp(nextCursor, 0, nextChars.length);

  let prefix = 0;
  while (
    prefix < sentChars.length &&
    prefix < nextChars.length &&
    sentChars[prefix] === nextChars[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < sentChars.length - prefix &&
    suffix < nextChars.length - prefix &&
    sentChars[sentChars.length - 1 - suffix] === nextChars[nextChars.length - 1 - suffix]
  ) {
    suffix++;
  }

  const deleteCount = sentChars.length - prefix - suffix;
  const insertText = nextChars.slice(prefix, nextChars.length - suffix).join('');

  const ops: LineEditOps[] = [];

  if (deleteCount > 0 || insertText) {
    // 1. 移到删除/插入区间末尾（无编辑时跳过，纯光标移动不该被
    //    强行先拉到行尾再拉回来）
    const deleteEnd = prefix + deleteCount;
    if (cursor > deleteEnd) {
      ops.push({ left: cursor - deleteEnd });
    } else if (cursor < deleteEnd) {
      ops.push({ right: deleteEnd - cursor });
    }
    cursor = deleteEnd;

    // 2. 退格删除改动区间
    if (deleteCount > 0) {
      ops.push({ backspace: deleteCount });
      cursor = prefix;
    }

    // 3. 插入新内容
    if (insertText) {
      ops.push({ insert: insertText });
      cursor += toCodePoints(insertText).length;
    }
  }

  // 4. 对齐到 textarea 光标
  if (cursor > targetCursor) {
    ops.push({ left: cursor - targetCursor });
  } else if (cursor < targetCursor) {
    ops.push({ right: targetCursor - cursor });
  }
  cursor = targetCursor;

  return { ops, cursor };
}

/**
 * textarea 的光标位置（selectionStart 是 UTF-16 偏移）换算成 code point 数。
 * 计数基于原始值（sanitize 之前），调用方负责与 sanitize 后的内容对齐钳制。
 */
export function textareaCursorInCodePoints(textarea: HTMLTextAreaElement): number {
  const value = textarea.value;
  const selectionStart = textarea.selectionStart ?? value.length;
  return toCodePoints(value.slice(0, selectionStart)).length;
}
