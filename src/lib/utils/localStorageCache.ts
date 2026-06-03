// 通用 localStorage 缓存工具。
//
// 设计意图：
//  - "乐观渲染"模式：UI 同步 hydrate 缓存 → 立即显示 → 后台 fetch → reconcile。
//  - 所有不依赖即时一致的数据（settings / toolbar presets / agent rules /
//    session 列表 / xterm scrollback 等）都走这一套，避免冷启动等 HTTP RTT。
//  - 服务端始终是真值；缓存只是"上次看到"的快照，fetch 完会被覆盖到一致。
//
// 失败容忍：
//  - JSON 损坏 / 校验不过 / 隐私模式 / 配额超 → 返回 null 或静默忽略，
//    调用方走 HTTP fallback 一切照常。

export type CacheValidator<T> = (value: unknown) => value is T;

export function readCache<T>(key: string, validator: CacheValidator<T>): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === '') return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!validator(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额超 / 隐私模式：静默忽略，下次启动靠 HTTP fallback。
  }
}

export function clearCache(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch { /* ignore */ }
}

// 简单的 per-key throttle：避免高频写入（如 xterm 数据流）打爆主线程。
// 第一次立即写，之后在 windowMs 内只保留最后一次（trailing edge）。
const throttleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, unknown>();
const lastWriteAt = new Map<string, number>();

export function writeCacheThrottled<T>(key: string, value: T, windowMs: number): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const last = lastWriteAt.get(key) ?? 0;
  const elapsed = now - last;

  if (elapsed >= windowMs) {
    // 距上次足够久，立刻写。
    lastWriteAt.set(key, now);
    writeCache(key, value);
    return;
  }

  // 仍在 throttle 窗口内：暂存最新值，定时器到期再写。
  pendingValues.set(key, value);
  if (throttleTimers.has(key)) return;
  const delay = windowMs - elapsed;
  const timer = setTimeout(() => {
    throttleTimers.delete(key);
    const pending = pendingValues.get(key);
    pendingValues.delete(key);
    lastWriteAt.set(key, Date.now());
    if (pending !== undefined) writeCache(key, pending);
  }, delay);
  throttleTimers.set(key, timer);
}

// 立刻 flush 某 key 的待写值（用于页面卸载、session 关闭等场景）。
export function flushCacheThrottled(key: string): void {
  const timer = throttleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    throttleTimers.delete(key);
  }
  const pending = pendingValues.get(key);
  if (pending !== undefined) {
    pendingValues.delete(key);
    lastWriteAt.set(key, Date.now());
    writeCache(key, pending);
  }
}

// 通用的 deep equal（小数据用 JSON.stringify 够用，避免引入额外依赖）。
export function shallowJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
