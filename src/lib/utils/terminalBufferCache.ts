// Per-session 终端 buffer (xterm scrollback) 缓存。
//
// 目的：让 PWA 冷启动 / iOS PWA 被踢出内存后重开时，xterm 立刻显示上次的内容，
// 不用等 WS 'connected' 携带 replayChunks 回来才有画面。
//
// 设计：
//  - localStorage key 按前端 sessionId（每个 tab 稳定）：`termdock-buffer-${sessionId}`
//  - 单 session 上限 BUFFER_CACHE_LIMIT_BYTES，超出按尾部截断（保留最近输出）
//  - 写入节流 BUFFER_CACHE_WRITE_THROTTLE_MS，避免高速数据流打爆主线程
//  - 数据始终以服务端为准：WS 'connected' 携带 replayChunks 时由 TerminalView
//    的 'connected' handler 自动 clear → 重放，缓存内容被覆盖到一致

import { readCache, writeCacheThrottled, clearCache, flushCacheThrottled } from './localStorageCache';

const BUFFER_CACHE_KEY_PREFIX = 'termdock-buffer-';
// 单 session 最大缓存字节数。64KB 大致覆盖 80×500 行的 ASCII 输出，再大对手机
// localStorage 配额（一般 5MB）压力变大；多 tab × 多 KB 也吃得消。
export const BUFFER_CACHE_LIMIT_BYTES = 64 * 1024;
// 写节流窗口：xterm data 事件高速密集，每 1.5s 落一次盘足够，不会丢任何"最后状态"
// （trailing edge throttle）。
export const BUFFER_CACHE_WRITE_THROTTLE_MS = 1500;

function bufferCacheKey(frontendSessionId: string): string {
  return `${BUFFER_CACHE_KEY_PREFIX}${frontendSessionId}`;
}

function isStringValue(v: unknown): v is string {
  return typeof v === 'string';
}

export function readBufferCache(frontendSessionId: string): string | null {
  return readCache(bufferCacheKey(frontendSessionId), isStringValue);
}

// 按尾部截断到 limit。注意：以 UTF-16 code unit 计算（与 string.length 一致），
// 终端控制序列可能被截到一半，但 xterm 解析器对孤立序列容忍度较高（最多漏一两个
// 单元的渲染），不会崩溃。冷启动时服务端的权威 replayChunks 会立刻覆盖修正。
function tailTrim(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(value.length - limit);
}

export function writeBufferCache(frontendSessionId: string, value: string): void {
  const trimmed = tailTrim(value, BUFFER_CACHE_LIMIT_BYTES);
  writeCacheThrottled(bufferCacheKey(frontendSessionId), trimmed, BUFFER_CACHE_WRITE_THROTTLE_MS);
}

export function flushBufferCache(frontendSessionId: string): void {
  flushCacheThrottled(bufferCacheKey(frontendSessionId));
}

export function clearBufferCache(frontendSessionId: string): void {
  flushCacheThrottled(bufferCacheKey(frontendSessionId));
  clearCache(bufferCacheKey(frontendSessionId));
}
