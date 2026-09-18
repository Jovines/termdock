/**
 * 「服务最近出过什么事」——给界面红点与设置面板用的只读快照。
 *
 * 数据源是 **crash.log**，不是 supervisor.json：crash.log 由两个角色一起写
 * （supervisor 记子进程怎么死的，服务自己记 uncaughtException / supervisor-lost），
 * 因此在**没有监督者**的部署里同样有内容。supervisor.json 只补两样它才知道的事：
 * 谁在盯着、重启了几次、当前处于哪个阶段。
 *
 * 这个模块只读不写（dismiss 除外），且绝不抛异常：它服务于"出事了怎么告诉用户"，
 * 自己再炸一次就太难看了。
 */

import {
  INCIDENT_DISMISSED_PATH,
  readJsonFile,
  writeJsonStateAtomic,
} from './termdockState.js';
import { readCrashLogTail } from './crashForensics.js';
import { getSupervisorStatus } from './supervisorClient.js';
import type { SupervisorState } from './supervisorProtocol.js';

/**
 * 值得用户知道的事件。刻意排除 `stop`（是用户自己停的）、
 * `update-restart` / `manual-restart`（我们自己发起的，成功了就没什么可说）。
 */
const NOTABLE_EVENTS = new Set([
  'startup-failure',
  'crash',
  'crash-native',
  'killed',
  'wedge',
  'port-conflict',
  'gave-up',
  'exit-zero-unexpected',
  'terminated-externally',
  'supervisor-lost',
  'uncaught-exception',
  'unhandled-rejection',
  'exit-nonzero',
]);

export interface ServerHealthIncident {
  /** 事件发生时刻（epoch ms，由记录里的 ts 解析而来） */
  at: number;
  /** 机器可读的事件名，界面文案走 i18n 映射 */
  event: string;
  /** 技术细节（英文，来自记录本身），作为副标题展示 */
  detail: string;
  /** 谁记的这条：'server'（进程内取证）或 'supervisor'（看门人） */
  role: string;
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number | null;
  version: string | null;
  oomSuspect: boolean;
  /** supervisor 记的这条是它生命期内的第几次重启 */
  restartCount: number | null;
}

export interface ServerHealthState {
  /** 本进程是否由 supervisor 盯着（决定"它会自己回来吗"） */
  supervised: boolean;
  /**
   * `consecutiveCrashes` 与 `restarts` 不是一回事：放弃时前者才等于"连续崩了几次"
   * （restarts 是它此前成功重启的次数，少一次）。界面说"连续崩溃 N 次后放弃"要用前者。
   */
  supervisor: {
    pid: number;
    alive: boolean;
    phase: string;
    restarts: number;
    consecutiveCrashes: number;
  } | null;
  incident: ServerHealthIncident | null;
  /** 用户上次点「知道了」时确认掉的那条事件的时间 */
  dismissedAt: number | null;
  /** 红点：存在一条尚未被确认的异常 */
  attention: boolean;
  generatedAt: number;
}

interface DismissalRecord {
  dismissedAt: number;
}

export interface ServerHealthOptions {
  crashLogPath?: string;
  dismissedPath?: string;
  supervisorStatePath?: string;
  now?: () => number;
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function pickNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 把一条 crash.log 记录投影成界面要的形状。缺字段一律降级为 null，不猜。 */
export function toIncident(entry: Record<string, unknown>): ServerHealthIncident | null {
  const event = pickString(entry.event);
  if (!event) return null;
  const parsed = pickString(entry.ts) ? Date.parse(entry.ts as string) : Number.NaN;
  return {
    at: Number.isFinite(parsed) ? parsed : 0,
    event,
    detail: pickString(entry.detail) ?? '',
    role: pickString(entry.role) ?? 'unknown',
    exitCode: pickNumber(entry.exitCode),
    signal: pickString(entry.signal),
    uptimeMs: pickNumber(entry.uptimeMs),
    version: pickString(entry.version),
    oomSuspect: entry.oomSuspect === true,
    restartCount: pickNumber(entry.restartCount),
  };
}

/** 最新一条值得注意的事件（没有就返回 null）。 */
export function findLatestNotableIncident(entries: Record<string, unknown>[]): ServerHealthIncident | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const incident = toIncident(entries[index]);
    if (incident && NOTABLE_EVENTS.has(incident.event)) return incident;
  }
  return null;
}

function readDismissal(path: string): number | null {
  const record = readJsonFile<Partial<DismissalRecord>>(path);
  return typeof record?.dismissedAt === 'number' ? record.dismissedAt : null;
}

function projectSupervisor(state: SupervisorState | null, alive: boolean) {
  if (!state) return null;
  return {
    pid: state.pid,
    alive,
    phase: state.phase as string,
    restarts: state.restarts,
    consecutiveCrashes: state.consecutiveCrashes,
  };
}

export function buildServerHealthState(options: ServerHealthOptions = {}): ServerHealthState {
  const now = options.now ?? (() => Date.now());
  const crashLogPath = options.crashLogPath;
  const dismissedPath = options.dismissedPath ?? INCIDENT_DISMISSED_PATH;

  let incident: ServerHealthIncident | null = null;
  try {
    incident = findLatestNotableIncident(readCrashLogTail(undefined, crashLogPath));
  } catch {
    // 取证读取失败不该让界面也挂掉：没有消息就是没有消息。
  }

  let supervisor = null;
  try {
    const status = getSupervisorStatus(options.supervisorStatePath);
    supervisor = projectSupervisor(status?.state ?? null, status?.alive ?? false);
  } catch {
    supervisor = null;
  }

  const dismissedAt = readDismissal(dismissedPath);
  return {
    supervised: process.env.TERMDOCK_SUPERVISED === '1',
    supervisor,
    incident,
    dismissedAt,
    attention: Boolean(incident && incident.at > (dismissedAt ?? 0)),
    generatedAt: now(),
  };
}

/** 「知道了」：把当前这条记成已被确认，红点随之消失。 */
export function dismissServerHealth(options: ServerHealthOptions = {}): ServerHealthState {
  const before = buildServerHealthState(options);
  if (before.incident) {
    try {
      writeJsonStateAtomic(options.dismissedPath ?? INCIDENT_DISMISSED_PATH, {
        dismissedAt: before.incident.at,
      } satisfies DismissalRecord);
    } catch {
      // 写不进去就等于没确认，红点会再出现——比谎报"已读"好。
    }
  }
  return buildServerHealthState(options);
}
