/**
 * Termdock 配置中心
 *
 * —— 如何新增可配置值（三步法） ——
 * 1. 选辅助函数：envInt(envKey, fallback) / envStr(envKey, fallback)
 * 2. 在对应命名空间对象上加 getter（不要直接赋值——ESM import hoisting 会导致
 *    dotenv 加载前就读值，getter 懒求值可规避此问题）
 * 3. 在 .env.example 补充文档，在 docs/configuration.md 补充速查表条目
 *
 * —— 命名规则 ——
 * 环境变量：TERMDOCK_<CATEGORY>_<PROPERTY>，全大写蛇形
 * 详见 docs/configuration.md
 *
 * —— 为什么用 getter ——
 * ESM import 先于模块体执行。若在模块顶层直接读 process.env，
 * 此时 dotenv 尚未加载，读到的是空值。getter 在每次属性访问时才
 * 求值，保证读到 dotenv 加载后的正确值。
 */

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}


// 判断是否为开发模式（NODE_ENV === 'development'）
function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

// ---------------------------------------------------------------------------
// 端口配置
// ---------------------------------------------------------------------------

/**
 * 端口配置（可通过环境变量覆盖）
 * - TERMDOCK_PORT_FRONTEND: 前端开发服务器 (Vite) 端口
 * - PORT: 正式服务端口
 * - TERMDOCK_PORT_DEV_BACKEND: 后端开发 API 端口
 */
export const PORT = {
  get frontend(): number { return envInt('TERMDOCK_PORT_FRONTEND', 9833); },
  get backend(): number { return envInt('PORT', 9834); },
  get devBackend(): number { return envInt('TERMDOCK_PORT_DEV_BACKEND', 9835); },
};

/** 默认主机（HOST 环境变量可覆盖） */
export const DEFAULT_HOST = '0.0.0.0';

// ---------------------------------------------------------------------------
// Local Access 域名配置
// ---------------------------------------------------------------------------

export const LOCAL_ACCESS = {
  get domainSuffix(): string { return envStr('TERMDOCK_LOCAL_ACCESS_DOMAIN_SUFFIX', 'termdock.local'); },
  get generatedNameLength(): number { return envInt('TERMDOCK_LOCAL_ACCESS_NAME_LENGTH', 4); },
  get generatedNameAlphabet(): string { return envStr('TERMDOCK_LOCAL_ACCESS_NAME_ALPHABET', 'abcdefghijklmnopqrstuvwxyz0123456789'); },
  get mdnsTtlSeconds(): number { return envInt('TERMDOCK_LOCAL_ACCESS_MDNS_TTL', 120); },
};

// ---------------------------------------------------------------------------
// 终端行为配置
// ---------------------------------------------------------------------------

export const TERMINAL = {
  /**
   * 终端空闲超时（毫秒）。
   * 开发模式默认 30 分钟（手机锁屏后 JS 容易被 OS 暂停），生产模式 6 小时。
   * 环境变量 TERMINAL_IDLE_TIMEOUT 可覆盖。
   */
  get idleTimeout(): number {
    return envInt('TERMINAL_IDLE_TIMEOUT', isDev() ? 1_800_000 : 21_600_000);
  },

  /** 终端清理间隔（毫秒），开发模式 1 分钟，生产 5 分钟 */
  get cleanupInterval(): number {
    return isDev() ? 60_000 : 300_000;
  },

  /** 重连时传回的滚动缓冲区行数 */
  get reconnectScrollback(): number {
    return envInt('TERMINAL_RECONNECT_SCROLLBACK', 200);
  },

  /** 流控暂停租赁时长（毫秒） */
  get flowControlPauseLeaseMs(): number {
    return envInt('TERMINAL_FLOW_CONTROL_PAUSE_LEASE_MS', 15_000);
  },
};

// ---------------------------------------------------------------------------
// Tmux 配置
// ---------------------------------------------------------------------------

export const TMUX = {
  /** tmux scrollback history-limit */
  get historyLimit(): number {
    return envInt('TERMDOCK_TMUX_HISTORY_LIMIT', 10_000);
  },
};
