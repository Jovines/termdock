import type express from 'express';
import { writeErrorLog } from './serverLogger.js';

/**
 * 全局请求兜底超时（系统性保险丝）。
 *
 * 背景：浏览器对同源 HTTP/1.1 只有 6 条并发连接。任何一个 handler 挂起
 * （忘了加超时、外部依赖 wedge、客户端半开连接），就永久占住一条；占满后
 * 所有后续请求在浏览器侧排队，用户看到"整个服务 io 全部超时"，只能重启。
 *
 * 这个中间件保证：无论 handler 自己是否记得加超时，每个进入 Express 的
 * 请求都有死亡上界。到期后销毁 socket，浏览器立即释放连接槽，其余请求
 * 照常进行。显式的长连接端点（watch NDJSON 流、终端 SSE）按表豁免，
 * 慢但合法的端点（搜索、大文件下载）给更长档位；路由也可以通过
 * `res.locals.requestDeadlineMs` 自行调档。
 */

const DEFAULT_DEADLINE_MS = 30_000;

interface DeadlineRule {
  method?: string;
  pattern: RegExp;
  /** null = 豁免（长连接）。 */
  deadlineMs: number | null;
}

const DEADLINE_RULES: DeadlineRule[] = [
  // 无限流：文件监听 NDJSON、终端 SSE。
  { method: 'GET', pattern: /^\/api\/terminal\/fs\/watch$/, deadlineMs: null },
  { method: 'GET', pattern: /^\/api\/terminal\/[^/]+\/stream$/, deadlineMs: null },
  // 有限但可能很久：大目录搜索（有 done 事件的进度流）、大文件下载。
  { method: 'GET', pattern: /^\/api\/terminal\/fs\/search$/, deadlineMs: 120_000 },
  { method: 'GET', pattern: /^\/api\/terminal\/fs\/download$/, deadlineMs: 300_000 },
  // 上传最多 100MB×50 文件，弱网下接收请求体可能要几分钟。注意 Node 内置
  // requestTimeout（默认 300s，本项目未改）管「请求体接收」阶段并在超时后
  // 回 408，所以这里必须低于 300s——让我们的 503+日志先出手，而不是被
  // Node 的裸 408 抢先。
  { method: 'POST', pattern: /^\/api\/terminal\/fs\/upload$/, deadlineMs: 280_000 },
  // 会话打开/创建/重启内部串了多段 tmux 命令（各有 5s 超时），tmux 退化时
  // 合法完成也可能要 20-40s——给 60s，超过才算真挂起。
  { method: 'POST', pattern: /^\/api\/terminal\/session-inventory\/open$/, deadlineMs: 60_000 },
  { method: 'POST', pattern: /^\/api\/terminal\/create$/, deadlineMs: 60_000 },
  { method: 'POST', pattern: /^\/api\/terminal\/[^/]+\/restart$/, deadlineMs: 60_000 },
];

function resolveDeadlineMs(method: string, pathname: string): number | null {
  for (const rule of DEADLINE_RULES) {
    if (rule.method && rule.method !== method) continue;
    if (rule.pattern.test(pathname)) return rule.deadlineMs;
  }
  return DEFAULT_DEADLINE_MS;
}

declare module 'express-serve-static-core' {
  interface Locals {
    /** 路由可自行调档（毫秒）；null 表示豁免。在中间件触发时读取。 */
    requestDeadlineMs?: number | null;
  }
}

export function requestDeadlineMiddleware(options: { defaultDeadlineMs?: number } = {}): express.RequestHandler {
  const defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  return (req, res, next) => {
    let pathname: string;
    try {
      pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.path || req.url || '';
    }

    const ruleDeadline = resolveDeadlineMs(req.method, pathname);
    const effectiveDeadline = ruleDeadline === DEFAULT_DEADLINE_MS ? defaultDeadlineMs : ruleDeadline;
    if (effectiveDeadline === null) {
      next();
      return;
    }

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onFire = () => {
      const elapsed = Date.now() - startedAt;
      // 路由在 handler 里调过档：按新档位重新计时（null = 豁免）。
      const override = res.locals.requestDeadlineMs;
      if (override === null) {
        clear();
        return;
      }
      if (typeof override === 'number' && override > elapsed) {
        timer = setTimeout(onFire, override - elapsed);
        return;
      }

      console.warn(`[request-deadline] ${req.method} ${pathname} exceeded ${elapsed}ms — aborting request`);
      writeErrorLog({
        source: 'request-deadline',
        method: req.method,
        path: pathname,
        durationMs: elapsed,
        clientId: req.clientId,
      });
      if (!res.headersSent) {
        // 未发头：socket 是健康的，干净地回 503 即可，连接还能继续复用。
        res.status(503).json({
          error: 'Request took too long and was aborted by the server. Please retry.',
          code: 'REQUEST_DEADLINE',
        });
        return;
      }
      // 已发头但流卡死（含客户端消失的半开连接）：无法写出合法响应，
      // 销毁底层 socket，浏览器立即释放该连接槽。
      req.socket.destroy();
    };

    timer = setTimeout(onFire, effectiveDeadline);
    res.on('finish', clear);
    res.on('close', clear);

    next();
  };
}
