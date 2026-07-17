import { describe, expect, it } from 'vitest';
import { computeCursorAwareEdit, type LineEditOps } from './lineEditSync';

/** 模拟一次同步：给定旧模型和新 (值, 光标)，返回 ops 并推进模型 */
function makeSession() {
  let sent = '';
  let cursor = 0;
  return {
    apply(next: string, nextCursor: number): LineEditOps[] {
      const result = computeCursorAwareEdit(sent, next, cursor, nextCursor);
      sent = next;
      cursor = result.cursor;
      // 不变式：返回的光标永远落在目标内容范围内
      expect(result.cursor).toBeGreaterThanOrEqual(0);
      expect(result.cursor).toBeLessThanOrEqual(Array.from(next).length);
      return result.ops;
    },
  };
}

describe('computeCursorAwareEdit', () => {
  it('纯末尾追加：只插入，不动光标', () => {
    const s = makeSession();
    expect(s.apply('a', 1)).toEqual([{ insert: 'a' }]);
    expect(s.apply('ab', 2)).toEqual([{ insert: 'b' }]);
  });

  it('末尾退格：只退格', () => {
    const s = makeSession();
    s.apply('ab', 2);
    expect(s.apply('a', 1)).toEqual([{ backspace: 1 }]);
    expect(s.apply('', 0)).toEqual([{ backspace: 1 }]);
  });

  it('括号自动配对全流程：每步都是最小编辑，无退格重打', () => {
    const s = makeSession();
    // 敲 ( → 键盘写入 () 光标落中间
    expect(s.apply('()', 1)).toEqual([{ insert: '()' }, { left: 1 }]);
    // 敲 a → 中间插入，无退格、无光标移动
    expect(s.apply('(a)', 2)).toEqual([{ insert: 'a' }]);
    // 敲 ) → type-over：值不变，光标右移一格
    expect(s.apply('(a)', 3)).toEqual([{ right: 1 }]);
    // 敲 b → 末尾追加
    expect(s.apply('(a)b', 4)).toEqual([{ insert: 'b' }]);
    // 退格删 b
    expect(s.apply('(a)', 3)).toEqual([{ backspace: 1 }]);
    // 光标在 ) 后（步骤 3 的 type-over 移过去了）：先左移到 a 后，再退格删 a
    expect(s.apply('()', 1)).toEqual([{ left: 1 }, { backspace: 1 }]);
    // 成对删除 → 先右移到区间末尾再退两格
    expect(s.apply('', 0)).toEqual([{ right: 1 }, { backspace: 2 }]);
  });

  it('中间插入不删尾巴：compare with 旧算法（会退格重打）', () => {
    const s = makeSession();
    s.apply('foo bar', 7);
    // 光标移到 foo 后，插入 X → fooX bar（行尾 7 → 插入点 3，左移 4 格）
    expect(s.apply('fooX bar', 4)).toEqual([{ left: 4 }, { insert: 'X' }]);
  });

  it('中间修改圈定最小区间：stats → status 只插一个 u', () => {
    const s = makeSession();
    s.apply('git stats', 9);
    // 公共前缀 'git stat' + 公共后缀 's'：改动只有中间的 u
    expect(s.apply('git status', 10)).toEqual([
      { left: 1 },
      { insert: 'u' },
      { right: 1 },
    ]);
  });

  it('CJK 字符按 code point 计数', () => {
    const s = makeSession();
    s.apply('(你)', 2);
    expect(s.apply('(你好)', 3)).toEqual([{ insert: '好' }]);
  });

  it('光标模型越界时钳制，不产生负移动', () => {
    // sentCursor 超出 sent 长度（模型漂移）→ 钳到行尾再算
    const result = computeCursorAwareEdit('ab', 'abc', 99, 3);
    expect(result.ops).toEqual([{ insert: 'c' }]);
    expect(result.cursor).toBe(3);
  });

  it('纯光标移动：内容不变只发移动', () => {
    const s = makeSession();
    s.apply('hello', 5);
    expect(s.apply('hello', 0)).toEqual([{ left: 5 }]);
    expect(s.apply('hello', 3)).toEqual([{ right: 3 }]);
  });

  it('空到空：无操作', () => {
    const s = makeSession();
    expect(s.apply('', 0)).toEqual([]);
  });
});
