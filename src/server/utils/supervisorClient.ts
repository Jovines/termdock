/**
 * launcher（`td` / `td --status` / `td --stop`）看向 supervisor 的那一侧。
 *
 * 与 supervisor.ts 分开是为了单向依赖：supervisor 是独立入口，不能反过来
 * 依赖 CLI 的进程；CLI 只是它的客户端。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProcessRunning, readJsonFile, SUPERVISOR_STATE_PATH } from './termdockState.js';
import { isSupervisorState, type SupervisorState } from './supervisorProtocol.js';
import { STOP_GRACE_MS } from './termdockState.js';

export interface SpawnSupervisorOptions {
  childEntry: string;
  childArgs: string[];
  healthUrl: string;
  healthCaPath?: string;
  version?: string | null;
  /** 已打开的日志文件 fd（server.log），supervisor 与子进程共用 */
  logFileFd: number;
  /** 等 ready/启动失败的上限 */
  readyTimeoutMs: number;
}

export interface SupervisorLaunchResult {
  ok: boolean;
  pid?: number;
  /** 启动失败时的原因（子进程没起来 / 起太慢） */
  reason?: string;
  detail?: string;
}

/** supervisor.js 与 cli.js 同目录，所以从本模块（dist/server/utils/）回退一级。 */
export function resolveSupervisorScript(): string {
  return fileURLToPath(new URL('../supervisor.js', import.meta.url));
}

export function readSupervisorState(): SupervisorState | null {
  const state = readJsonFile<unknown>(SUPERVISOR_STATE_PATH);
  return isSupervisorState(state) ? state : null;
}

export interface SupervisorStatus {
  state: SupervisorState;
  alive: boolean;
}

/**
 * 读出 supervisor 状态，并单独给出"它现在还活着吗"。
 *
 * **进程死了也不删状态文件**：`gave-up` 正是它死的原因，那份记录就是结论本身；
 * 别的 phase 下进程没了则意味着"supervisor 自己崩了，服务现在无人监督"——
 * 两件事都必须能被告知用户。陈旧的判断交给调用方（它才知道自己在问什么），
 * 真正的清理留给 `td --stop`。
 */
export function getSupervisorStatus(statePath: string = SUPERVISOR_STATE_PATH): SupervisorStatus | null {
  const raw = readJsonFile<unknown>(statePath);
  if (!isSupervisorState(raw)) return null;
  return { state: raw, alive: isProcessRunning(raw.pid) };
}

/**
 * 起一个 detached 的 supervisor，并等它把子进程的结局告诉我们。
 *
 * 与旧实现的关键差别：这里**会等结果**。旧 `node -e` bridge 是发射后不管，
 * 新进程起没起来只有用户下次访问才知道。
 */
export function spawnSupervisor(options: SpawnSupervisorOptions): Promise<SupervisorLaunchResult> {
  return new Promise<SupervisorLaunchResult>((resolve) => {
    const args = [
      resolveSupervisorScript(),
      '--health-url', options.healthUrl,
      '--child', options.childEntry,
    ];
    if (options.healthCaPath) args.push('--health-ca', options.healthCaPath);
    if (options.version) args.push('--version', options.version);
    args.push('--', ...options.childArgs);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', options.logFileFd, options.logFileFd, 'ipc'],
      });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-failed', detail: (error as Error).message });
      return;
    }

    let settled = false;
    let spawnError: Error | null = null;

    // 拿到结局就断开 IPC 并 unref：supervisor 继续跑，launcher 可以退出。
    const finish = (result: SupervisorLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', detail: `no ready within ${options.readyTimeoutMs}ms` });
    }, options.readyTimeoutMs);

    child.on('error', (error: Error) => {
      spawnError = error;
      finish({ ok: false, reason: 'spawn-failed', detail: error.message });
    });

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      const typed = message as { type: string; reason?: string; detail?: string };
      if (typed.type === 'termdock-ready') {
        finish({ ok: true, pid: child.pid });
      } else if (typed.type === 'termdock-startup-failed') {
        finish({ ok: false, reason: typed.reason, detail: typed.detail });
      }
    });

    child.on('exit', (code, signal) => {
      finish({
        ok: false,
        reason: 'supervisor-exited',
        detail: spawnError?.message ?? `exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`,
      });
    });
  });
}

/**
 * 停 supervisor：它是唯一该被停的东西，子进程由它负责。
 *
 * 先发 SIGTERM 让它自己收拾（杀子进程、删状态、退出 0）；宽限期到了还在，
 * 才 SIGKILL。**不**在这里直接杀子进程——那会让它变成"意外死亡"从而被重启。
 */
export async function stopSupervisor(pid: number, graceMs = STOP_GRACE_MS): Promise<boolean> {
  if (!isProcessRunning(pid)) {
    try { fs.rmSync(SUPERVISOR_STATE_PATH, { force: true }); } catch { /* nothing to clean */ }
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  const deadline = Date.now() + graceMs;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessRunning(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  try { fs.rmSync(SUPERVISOR_STATE_PATH, { force: true }); } catch { /* nothing to clean */ }
  return !isProcessRunning(pid);
}

/** `td --restart`：让 supervisor 重启子进程，但继续监督。 */
export function signalSupervisorRestart(pid: number): boolean {
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}

export { SUPERVISOR_STATE_PATH };
