import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff.js';

describe('backoffDelayMs', () => {
  it('从 baseMs 起翻倍', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
  });

  it('封顶在 maxMs，且 cap 之后再增长也不变', () => {
    expect(backoffDelayMs(6)).toBe(30_000);
    expect(backoffDelayMs(7)).toBe(30_000);
    expect(backoffDelayMs(100)).toBe(30_000);
  });

  it('0 或负数按第一次失败处理，不会给出半个 baseMs', () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(-3)).toBe(1_000);
  });

  it('尊重自定义参数', () => {
    expect(backoffDelayMs(3, { baseMs: 100, maxMs: 500, cap: 4 })).toBe(400);
    expect(backoffDelayMs(4, { baseMs: 100, maxMs: 500, cap: 4 })).toBe(500);
  });
});
