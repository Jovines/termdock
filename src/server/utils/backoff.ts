/**
 * 指数退避。PTY 创建冷却与 supervisor 的崩溃重启共用同一套曲线，
 * 免得两处各写一遍 `min(30_000, 1000 * 2 ** (n - 1))` 再各自跑偏。
 */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** 增长上限（次数），超过后停在 maxMs。 */
  cap?: number;
}

/**
 * 第 `failures` 次失败后应等待多久。failures 从 1 起算
 * （0 或负数按第 1 次处理），因此返回 baseMs 而不是它的一半。
 */
export function backoffDelayMs(failures: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 30_000;
  const cap = options.cap ?? 6;
  const attempt = Math.max(1, Math.min(failures, cap));
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}
