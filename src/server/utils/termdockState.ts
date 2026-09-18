/**
 * 单一来源的 Termdock 状态目录 + 原子写。CLI、supervisor、server 三方都读这里，
 * 避免每处各拼一次路径再写出一套略有出入的读写逻辑。
 *
 * 依赖保持轻量（node stdlib only）：supervisor 是独立入口，不能通过这里
 * 间接把 server 的重依赖拖进来。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const TERMDOCK_DIR = path.join(os.homedir(), '.termdock');
export const SERVER_STATE_PATH = path.join(TERMDOCK_DIR, 'server.json');
export const SUPERVISOR_STATE_PATH = path.join(TERMDOCK_DIR, 'supervisor.json');
export const SERVER_LOG_PATH = path.join(TERMDOCK_DIR, 'server.log');
export const RUNTIME_METRICS_PATH = path.join(TERMDOCK_DIR, 'runtime-metrics.log');
/** 记录"用户已看过某时刻之前的服务异常"，供界面红点判定未读。 */
export const INCIDENT_DISMISSED_PATH = path.join(TERMDOCK_DIR, 'incident-dismissed.json');

/** 发 SIGTERM 后等进程自行退出的宽限期，超时才 SIGKILL。CLI 与 supervisor 共用。 */
export const STOP_GRACE_MS = 5_000;

export interface ServerState {
  pid: number;
  host: string;
  port: number;
  scheme?: 'http' | 'https';
  localUrl?: string;
  lanUrl?: string;
  onboardingUrl?: string | null;
  localAccessStatus?: string;
  localAccessReason?: string | null;
  logFile: string;
  startedAt: string;
  localApiToken?: string;
  /** 监督本服务的 supervisor pid；未受管时缺省。 */
  supervisorPid?: number;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 原子替换（tmp + rename + 0600），照 utils/autoUpdate.ts 的 persistState 写法。
 * 读方要么看到旧文件要么看到新文件，绝不会读到写了一半的 JSON。
 */
export function writeJsonStateAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function removeJsonState(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 清理失败不该影响调用方。
  }
}

export function readServerState(): ServerState | null {
  const state = readJsonFile<ServerState>(SERVER_STATE_PATH);
  if (!state || typeof state.pid !== 'number') return null;
  return state;
}
