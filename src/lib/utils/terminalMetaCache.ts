// Per-session "tab metadata" 缓存。
//
// 给顶部 tab 用的：programa / cwd / agent 状态。这些值平时是 WS 'connected'
// 事件 + 后端 poll 推过来的，冷启动一开始为 null，导致 tab 名先显示成
// tmux session 名（fallback），WS 连上才切到友好名。
//
// 缓存机制和 buffer cache 类似：
//  - localStorage 同步 hydrate → tab 名立即正确
//  - WS 'connected' / poll 推到的最新值覆盖缓存 → 始终以服务端为准
//  - 只缓存 string / 标量字段，单 session 几十字节，多 tab 也不占地方

import { readCache, writeCacheThrottled, clearCache, flushCacheThrottled } from './localStorageCache';
import type { AgentStatus, AgentIndicator } from '../terminal/types';

type ActiveProgramSource = 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown';

const META_CACHE_KEY_PREFIX = 'termdock-meta-';
// 与 buffer cache 一致的节流窗口，控制写入频率。
const META_CACHE_WRITE_THROTTLE_MS = 1500;

export interface CachedSessionMeta {
  activeProgram: string | null;
  activeProgramSource: ActiveProgramSource | null;
  cwd: string | null;
  agentStatus: AgentStatus | null;
  agentColor: string | null;
  agentIndicator: AgentIndicator | null;
}

function metaCacheKey(frontendSessionId: string): string {
  return `${META_CACHE_KEY_PREFIX}${frontendSessionId}`;
}

function isCachedSessionMeta(v: unknown): v is CachedSessionMeta {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  // 各字段允许为 null；类型只要不是错的就接受（旧版本字段缺失也容忍）。
  const okString = (x: unknown): boolean => x === null || x === undefined || typeof x === 'string';
  return okString(obj.activeProgram) &&
    okString(obj.activeProgramSource) &&
    okString(obj.cwd) &&
    okString(obj.agentStatus) &&
    okString(obj.agentColor) &&
    okString(obj.agentIndicator);
}

export function readMetaCache(frontendSessionId: string): CachedSessionMeta | null {
  const raw = readCache<CachedSessionMeta>(metaCacheKey(frontendSessionId), isCachedSessionMeta);
  if (!raw) return null;
  // 补齐缺失字段为 null，避免下游解构出 undefined
  return {
    activeProgram: raw.activeProgram ?? null,
    activeProgramSource: raw.activeProgramSource ?? null,
    cwd: raw.cwd ?? null,
    agentStatus: raw.agentStatus ?? null,
    agentColor: raw.agentColor ?? null,
    agentIndicator: raw.agentIndicator ?? null,
  };
}

export function writeMetaCache(frontendSessionId: string, meta: CachedSessionMeta): void {
  writeCacheThrottled(metaCacheKey(frontendSessionId), meta, META_CACHE_WRITE_THROTTLE_MS);
}

export function flushMetaCache(frontendSessionId: string): void {
  flushCacheThrottled(metaCacheKey(frontendSessionId));
}

export function clearMetaCache(frontendSessionId: string): void {
  flushCacheThrottled(metaCacheKey(frontendSessionId));
  clearCache(metaCacheKey(frontendSessionId));
}
