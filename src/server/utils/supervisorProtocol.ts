/**
 * supervisor ↔ server ↔ launcher 的协议，以及**纯函数**决策逻辑。
 *
 * 决策逻辑刻意与进程操作分开：判"这次退出算什么"必须能脱离真实进程单测，
 * 否则唯一验证手段就只剩"手动 kill 一下看看"。
 */

export const SUPERVISOR_STATE_VERSION = 1;

// —— 消息 ——

export interface ReadyMessage {
  type: 'termdock-ready';
}

export interface StartupFailedMessage {
  type: 'termdock-startup-failed';
  reason: string;
  detail?: string;
}

export type RestartIntent = 'restart-after-update' | 'stop';

export interface ServerIntentMessage {
  type: 'termdock-intent';
  intent: RestartIntent;
  /** restart-after-update：试图离开的版本 */
  from?: string;
  /** restart-after-update：要切换到的版本 */
  to?: string;
}

export type ServerToSupervisorMessage = ReadyMessage | ServerIntentMessage;
export type SupervisorToLauncherMessage = ReadyMessage | StartupFailedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return isRecord(value) && value.type === 'termdock-ready';
}

export function isServerIntentMessage(value: unknown): value is ServerIntentMessage {
  if (!isRecord(value) || value.type !== 'termdock-intent') return false;
  return value.intent === 'restart-after-update' || value.intent === 'stop';
}

// —— 持久化状态（supervisor.json，只有 supervisor 写） ——

export type SupervisorPhase = 'starting' | 'running' | 'restarting' | 'gave-up' | 'stopped';

export interface SupervisorIncident {
  at: number;
  event: ExitEvent;
  /** 供人看的短技术细节（如 "exit code 1" / "SIGKILL"）；界面文案走 i18n 的 event 映射 */
  detail: string;
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
  version: string | null;
  oomSuspect: boolean;
  restartCount: number;
}

export interface SupervisorState {
  version: number;
  /** supervisor 自己的 pid */
  pid: number;
  serverPid: number | null;
  phase: SupervisorPhase;
  startedAt: number;
  /** 本次 supervisor 生命期内重启过多少次 */
  restarts: number;
  consecutiveCrashes: number;
  lastIncident: SupervisorIncident | null;
}

// —— 退出分类 ——

export type ExitEvent =
  | 'stop'
  | 'update-restart'
  | 'manual-restart'
  | 'startup-failure'
  | 'exit-zero-unexpected'
  | 'crash'
  | 'crash-native'
  | 'killed'
  | 'terminated-externally'
  | 'port-conflict'
  | 'wedge';

export interface ExitObservation {
  /** 子进程退出前通过 IPC 声明的意图；没说就是 null */
  intent: RestartIntent | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 这一世代是否曾经就绪过 */
  becameReady: boolean;
  /** supervisor 自己收到停止信号（termdock --stop / 关机） */
  supervisorStopRequested: boolean;
  /** supervisor 自己收到 SIGHUP（termdock --restart，人在重启而不是更新在重启） */
  restartRequested: boolean;
  /** 是 supervisor 判定卡死后主动杀的 */
  wedge: boolean;
  /** 这一世代的运行记录里出现过 EADDRINUSE */
  portConflict: boolean;
  /** 崩溃前最后一次 RSS 采样逼近内存上限 —— 仅用于标注，不影响分类 */
  oomSuspect: boolean;
}

export interface ExitDecision {
  event: ExitEvent;
  detail: string;
  restart: boolean;
  countAsCrash: boolean;
  resetBackoff: boolean;
}

const NATIVE_CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE']);

function exitDetail(exitCode: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (exitCode !== null) return `exit code ${exitCode}`;
  return 'unknown termination';
}

/**
 * 决定一次子进程退出意味着什么。判定顺序即优先级，改动前先想清楚：
 * - 停止请求（supervisor 收到 SIGTERM）优先于一切，否则 `--stop` 会被当成崩溃重启，
 *   变成"用户刚停，它自己又回来"。
 * - 卡死判定优先于信号判定：wedge 是我们自己 SIGTERM/SIGKILL 的，否则会被
 *   误读成"被外部终止"从而不重启。
 * - 更新重启优先于端口冲突/未就绪：更新重启的退出码可能是 0 也可能非 0。
 * - 手动重启排在更新重启之后：两者都是"我们让子进程重启"，但记录里要分得清
 *   是应用了更新还是人在敲 `td --restart`。
 */
export function classifyChildExit(observation: ExitObservation): ExitDecision {
  const {
    intent, exitCode, signal, becameReady,
    supervisorStopRequested, restartRequested, wedge, portConflict,
  } = observation;

  if (supervisorStopRequested || intent === 'stop') {
    return {
      event: 'stop',
      detail: supervisorStopRequested ? 'supervisor stop requested' : 'server requested stop',
      restart: false,
      countAsCrash: false,
      resetBackoff: true,
    };
  }

  if (wedge) {
    return {
      event: 'wedge',
      detail: 'health probes stopped responding',
      restart: true,
      countAsCrash: true,
      resetBackoff: false,
    };
  }

  if (intent === 'restart-after-update') {
    return {
      event: 'update-restart',
      detail: 'restart requested after update',
      restart: true,
      countAsCrash: false,
      resetBackoff: true,
    };
  }

  if (restartRequested) {
    return {
      event: 'manual-restart',
      detail: 'restart requested by termdock --restart',
      restart: true,
      countAsCrash: false,
      resetBackoff: true,
    };
  }

  if (portConflict) {
    return {
      event: 'port-conflict',
      detail: 'port already in use',
      restart: true,
      countAsCrash: true,
      resetBackoff: false,
    };
  }

  if (!becameReady) {
    return {
      event: 'startup-failure',
      detail: `exited before becoming ready (${exitDetail(exitCode, signal)})`,
      restart: true,
      countAsCrash: true,
      resetBackoff: false,
    };
  }

  if (signal) {
    const detail = exitDetail(exitCode, signal);
    // SIGTERM/SIGINT 但没有 intent = 有人主动停它（部署脚本的 pkill 兜底、关机流程）。
    // 重启它会把一次有意的停机变成重启风暴，所以只记录、不重启。
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      return {
        event: 'terminated-externally',
        detail,
        restart: false,
        countAsCrash: false,
        resetBackoff: true,
      };
    }
    if (signal === 'SIGKILL') {
      return {
        event: 'killed',
        detail,
        restart: true,
        countAsCrash: true,
        resetBackoff: false,
      };
    }
    if (NATIVE_CRASH_SIGNALS.has(signal)) {
      return {
        event: 'crash-native',
        detail,
        restart: true,
        countAsCrash: true,
        resetBackoff: false,
      };
    }
    return {
      event: 'crash',
      detail,
      restart: true,
      countAsCrash: true,
      resetBackoff: false,
    };
  }

  if (exitCode === 0) {
    return {
      event: 'exit-zero-unexpected',
      detail: 'exit code 0 without a stop request',
      restart: true,
      countAsCrash: true,
      resetBackoff: false,
    };
  }

  return {
    event: 'crash',
    detail: exitDetail(exitCode, signal),
    restart: true,
    countAsCrash: true,
    resetBackoff: false,
  };
}

export const DEFAULT_MAX_CONSECUTIVE_CRASHES = 5;
/** 连续健康这么久就认为稳住了，把崩溃计数清零。 */
export const CRASH_COUNTER_RESET_MS = 60_000;

export function shouldGiveUp(
  consecutiveCrashes: number,
  maxCrashes: number = DEFAULT_MAX_CONSECUTIVE_CRASHES,
): boolean {
  return consecutiveCrashes >= maxCrashes;
}

export function isSupervisorState(value: unknown): value is SupervisorState {
  return isRecord(value)
    && value.version === SUPERVISOR_STATE_VERSION
    && typeof value.pid === 'number';
}
