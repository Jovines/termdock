/**
 * 服务就绪/存活探测。CLI 首次拉起服务、supervisor 长期盯守都走这里，
 * 避免"启动时怎么判活着"和"运行时怎么判活着"长出两套标准。
 *
 * 从 cli.ts 原样搬出（waitForHealth / DAEMON_START_TIMEOUT_MS），额外拆出
 * 单次探测 probeHealthOnce() 供 supervisor 的卡死判定复用——原来的实现是
 * 写死在循环里的，无法单独调用。
 */

import fs from 'fs';
import http from 'http';
import https from 'https';

/** 等 daemon 子进程响应 /health 的上限。 */
export const DAEMON_START_TIMEOUT_MS = 10_000;
/** 单次 /health 请求的 socket 超时。 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type HealthProbeFailure = 'timeout' | 'unreachable' | 'bad-status' | 'bad-body';

export interface HealthProbeResult {
  ok: boolean;
  failure?: HealthProbeFailure;
  detail?: string;
}

/**
 * 单次探测。注意它同时是"存活"信号：事件循环若卡死，请求根本不会被应答，
 * 于是以 timeout 收场——这正是 supervisor 判 wedge 需要的语义。
 * 自签 HTTPS 通过 caPath 放行；没给 caPath 就不做证书校验（与原实现一致）。
 */
export async function probeHealthOnce(
  healthUrl: string,
  caPath: string | undefined | null,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthProbeResult> {
  return new Promise<HealthProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: HealthProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const transport = healthUrl.startsWith('https:') ? https : http;
      const req = transport.get(healthUrl, {
        ca: caPath ? fs.readFileSync(caPath) : undefined,
        rejectUnauthorized: Boolean(caPath),
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            finish({ ok: false, failure: 'bad-status', detail: `HTTP ${status}` });
            return;
          }
          if (!data.includes('"status":"ok"')) {
            finish({ ok: false, failure: 'bad-body', detail: data.slice(0, 200) });
            return;
          }
          finish({ ok: true });
        });
        res.on('error', (error: Error) => {
          finish({ ok: false, failure: 'unreachable', detail: error.message });
        });
      });
      req.on('error', (error: Error) => {
        finish({ ok: false, failure: 'unreachable', detail: error.message });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, failure: 'timeout' });
      });
    } catch (error) {
      finish({
        ok: false,
        failure: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * 轮询直到就绪、超时或进程死亡。语义与搬迁前完全一致：
 * 先等 isReady() 翻真，再要求 /health 应答且 isAlive() 仍成立。
 */
export async function waitForHealth(
  healthUrl: string,
  caPath: string | undefined | null,
  timeoutMs: number,
  isReady: () => boolean,
  isAlive: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    if (!isReady()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const probe = await probeHealthOnce(healthUrl, caPath);
    if (probe.ok && isAlive()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
