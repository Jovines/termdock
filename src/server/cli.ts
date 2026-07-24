#!/usr/bin/env node

import { config as loadDotenv } from 'dotenv';
import os from 'os';
import { resolve } from 'path';

// 加载 .env 配置：用户级 ~/.termdock/.env 为基准，项目级 CWD .env 可覆盖
// dotenv 不会覆盖已存在的环境变量，因此系统环境变量和命令行参数优先级最高
loadDotenv({ path: resolve(os.homedir(), '.termdock', '.env'), quiet: true });
loadDotenv({ path: resolve(process.cwd(), '.env'), quiet: true });

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import readline from 'readline';
import { createHash, randomUUID } from 'crypto';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { createRequire } from 'module';
import { PORT, DEFAULT_HOST, TMUX } from './config.js';
import { isFirstRunCompleted, markFirstRunCompleted, normalizeLocalAccessName, setLocalAccessSetting, getLocalAccessSetting, getPreventSleepSetting } from './utils/settings.js';
import { runBootChecks, formatBootCheckReport } from './utils/bootCheck.js';
import { localAccessManager, getLanIPv4Addresses } from './utils/localAccess.js';
import type { CertificateRefreshResult, StartServerResult } from './entry.js';
import {
  clearAuthFile,
  destroyAllSessions,
  hashPassword,
  isAuthEnabled,
  isEnvPasswordSet,
  writeAuthFile,
} from './utils/authProtection.js';

const execFileAsync = promisify(execFile);

const TERMDOCK_VERSION: string = (() => {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(path.join(__dirname || '', '..', '..', 'package.json'));
    if (typeof pkg?.version === 'string') return pkg.version;
  } catch { /* fall through */ }
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_('../../package.json');
    if (typeof pkg?.version === 'string') return pkg.version;
  } catch { /* ignore */ }
  return '0.0.0';
})();
const TERMDOCK_HOST = os.hostname();
const TERMDOCK_PID = String(process.pid);
const TERMDOCK_TMUX_HISTORY_LIMIT = TMUX.historyLimit;

const stateDir = path.join(os.homedir(), '.termdock');
const stateFilePath = path.join(stateDir, 'server.json');
const logFilePath = path.join(stateDir, 'server.log');
const globalSessionStateFilePath = path.join(stateDir, 'global-session-state.json');
const localApiTokenPath = path.join(stateDir, 'local-api-token');
const changeAuditSnapshotPath = path.join(stateDir, 'change-audit-snapshot.json');
const certDir = path.join(stateDir, 'certs');
const defaultHttpsCertPath = path.join(certDir, 'termdock-local.pem');
const defaultHttpsKeyPath = path.join(certDir, 'termdock-local-key.pem');
const defaultHttpsCaPath = path.join(certDir, 'rootCA.pem');
const restartBridgeCaffeinateSeconds = 300;

// ANSI color helpers. Disabled when stdout is not a TTY (e.g. piped, log file)
// or when the user opts out via NO_COLOR / FORCE_COLOR=0.
const colorsEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  return Boolean((process.stdout as NodeJS.WriteStream).isTTY);
})();

function paint(code: string, text: string): string {
  return colorsEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const c = {
  bold: (s: string) => paint('1', s),
  dim: (s: string) => paint('2', s),
  red: (s: string) => paint('31', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  cyan: (s: string) => paint('36', s),
  gray: (s: string) => paint('90', s),
};

const ICON = {
  ok: c.green('✓'),
  warn: c.yellow('!'),
  err: c.red('✗'),
  info: c.cyan('›'),
  lock: '🔒',
};

function startRestartBridgeCaffeinate(): boolean {
  if (process.platform !== 'darwin') return false;
  if (!getPreventSleepSetting()) return false;

  try {
    const child = spawn('caffeinate', ['-i', '-s', '-t', String(restartBridgeCaffeinateSeconds)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface CliOptions {
  host?: string;
  port?: number;
  httpsCert?: string;
  httpsKey?: string;
  httpsCa?: string;
  setupLocalHttps: boolean;
  foreground: boolean;
  status: boolean;
  stop: boolean;
  setPassword: boolean;
  clearPassword: boolean;
  tls: boolean;
  tlsAll: boolean;
  tlsJson: boolean;
  attachTmux: boolean;
  attachTmuxName?: string;
  newTmux: boolean;
  newTmuxName?: string;
  newTmuxAttach: boolean;
  injectChangeAudit?: string | true;
  injectBranchAudit?: string | true;
  branchAuditExport?: { base: string; cwd?: string };
  changeAuditExport?: string | true;
  changeAuditList?: string | true;
  changeAuditShow?: { id: string; cwd?: string };
  injectChangeAuditHunk?: { id: string; cwd?: string };
}

interface ServerState {
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
}

interface PersistedCliSession {
  sessionId: string;
  name: string;
  customName?: boolean;
  backendSessionId: string | null;
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
}

interface GlobalCliSessionState {
  sessions: PersistedCliSession[];
  updatedAt: number;
}

function printHelp() {
  console.log(`Usage: td [options]
       td <cmd> [args]
       termdock [options]

Options:
  --host <host>      Host to bind to (default: ${DEFAULT_HOST})
  --port <port>      Port to listen on (default: ${PORT.backend})
  --https-cert <p>   HTTPS certificate path for local access
  --https-key <p>    HTTPS private key path for local access
  --https-ca <p>     CA certificate path exposed through a temporary mobile setup server
  --setup-local-https
                     Generate and trust local HTTPS certs with mkcert
  --foreground       Run in the foreground
  --status           Show background server status
  --stop             Stop the background server
  --set-password     Set or update the access password (interactive prompt)
  --clear-password   Remove the access password and disable authentication
  --tls              List termdock-managed tmux sessions (reads tmux directly,
                     no server connection required)
  -a, --all          With --tls/--attach-tmux: include tmux sessions not stamped by termdock
  --json             With --tls: emit JSON instead of a table
  --attach-tmux [n]  Attach to a termdock-managed tmux session.
                     With no name: interactive picker.
                     With name: attach directly (e.g. --attach-tmux wt-foo).
                     Add --all to include unmanaged tmux sessions in matching.
  --new-tmux [name]  Create (or ensure) and attach to a tmux session for termdock.
                     New sessions start in the directory where td was invoked.
                     With no name: auto-generate a wt-* name and enter it directly.
                     Use --tls to inspect sessions without attaching.
  --new-tmux-detached [name]
                     Create (or ensure) a tmux session and leave it detached.
  --inject-change-audit [file]
                     Inject AI-generated hunk explanations into the running
                     Termdock server. Reads JSON from file or stdin.
  --inject-branch-audit [file]
                     Inject AI-generated branch hunk explanations into the
                     running Termdock server. Reads JSON from file or stdin.
  --branch-audit-export <base> [cwd]
                     Export branch-vs-base diff hunks for branch audit.
  --change-audit-list [cwd]
                     List current Git diff hunks with stable Termdock hunk IDs.
  --change-audit-export [cwd]
                     Export current Git diff hunks with full diff text for one-pass review.
  --change-audit-show <id> [cwd]
                     Print one hunk's diff/context by Termdock hunk ID.
  --change-audit-explain <id> [cwd]
                     Read a natural-language explanation from stdin and inject
                     it for the specified Termdock hunk ID.
  -h, --help         Show this help message

Short commands:
  s                  Same as --status
  st                 Same as --status
  x                  Same as --stop
  stop               Same as --stop
  l                  Same as --tls
  ls                 Same as --tls
  la                 Same as --tls --all
  a [name]           Same as --attach-tmux [name]
  at [name]          Same as --attach-tmux [name]
  n [name]           Same as --new-tmux [name]
  nt [name]          Same as --new-tmux [name]
  nd [name]          Same as --new-tmux-detached [name]
  audit [file]       Same as --inject-change-audit [file]
  branch-audit [file]
                     Same as --inject-branch-audit [file]
  branch-audit-export <base> [cwd]
                     Same as --branch-audit-export <base> [cwd]
  audit-list [cwd]   Same as --change-audit-list [cwd]
  audit-export [cwd] Same as --change-audit-export [cwd]
  audit-show <id> [cwd]
                     Same as --change-audit-show <id> [cwd]
  audit-explain <id> [cwd]
                     Same as --change-audit-explain <id> [cwd]
  p                  Same as --set-password
  pw                 Same as --set-password
  pc                 Same as --clear-password
  pwc                Same as --clear-password
  https              Same as --setup-local-https

Password examples:
  ${c.dim('# Set password interactively (recommended)')}
  td --set-password

  ${c.dim('# Pipe a password from stdin (CI / scripted setup)')}
  echo "my-secret" | td --set-password

  ${c.dim('# Disable authentication entirely')}
  td --clear-password

Auth state lives in ${c.cyan(path.join('~', '.termdock', 'auth.json'))} (mode 0600).`);
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as ServerState;
  } catch {
    return null;
  }
}

function removeStateFile() {
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {
    // ignore cleanup errors
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRunningState(): ServerState | null {
  const state = readState();
  if (!state) {
    return null;
  }

  if (!isProcessRunning(state.pid)) {
    removeStateFile();
    return null;
  }

  return state;
}

function writeState(state: ServerState) {
  ensureStateDir();
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

function getOrCreateLocalApiToken(): string {
  ensureStateDir();
  try {
    const existing = fs.readFileSync(localApiTokenPath, 'utf8').trim();
    if (existing.length >= 24) return existing;
  } catch {
    // Create a token below.
  }
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  fs.writeFileSync(localApiTokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function buildServerState(params: {
  pid: number;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  localApiToken?: string;
  localAccessReason?: string | null;
}): ServerState {
  return {
    pid: params.pid,
    host: params.host,
    port: params.port,
    scheme: params.scheme,
    localUrl: `${params.scheme}://${params.host === '0.0.0.0' ? 'localhost' : params.host}:${params.port}`,
    localAccessReason: params.localAccessReason,
    logFile: logFilePath,
    startedAt: new Date().toISOString(),
    localApiToken: params.localApiToken,
  };
}

function fileExists(filePath: string | undefined): filePath is string {
  return typeof filePath === 'string' && filePath.length > 0 && fs.existsSync(filePath);
}

function resolveHttpsOptions(options: Pick<CliOptions, 'httpsCert' | 'httpsKey' | 'httpsCa'>): { cert?: string; key?: string; ca?: string; source: 'explicit' | 'default' | 'none' } {
  if (options.httpsCert || options.httpsKey || options.httpsCa) {
    return {
      cert: options.httpsCert,
      key: options.httpsKey,
      ca: options.httpsCa,
      source: options.httpsCert && options.httpsKey ? 'explicit' : 'none',
    };
  }
  if (fileExists(defaultHttpsCertPath) && fileExists(defaultHttpsKeyPath)) {
    return {
      cert: defaultHttpsCertPath,
      key: defaultHttpsKeyPath,
      ca: fileExists(defaultHttpsCaPath) ? defaultHttpsCaPath : undefined,
      source: 'default',
    };
  }
  return { source: 'none' };
}

const EXTRA_EXECUTABLE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function executableCandidates(command: string): string[] {
  if (command.includes(path.sep)) return [command];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_EXECUTABLE_DIRS].filter(Boolean);
  const seen = new Set<string>();
  return dirs
    .map((dir) => path.join(dir, command))
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

async function findExecutable(command: string): Promise<string | null> {
  for (const candidate of executableCandidates(command)) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5000, maxBuffer: 128 * 1024 });
      return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}

async function ensureMkcertInstalled(): Promise<string> {
  const existing = await findExecutable('mkcert');
  if (existing) return existing;

  const brew = await findExecutable('brew');
  if (!brew) {
    throw new Error(`${ICON.err} ${c.red('mkcert is required for local HTTPS setup, and Homebrew was not found.')}\n  ${c.dim('Install Homebrew first, or manually install:')} ${c.cyan('brew install mkcert')}`);
  }

  console.log(`${ICON.info} ${c.dim('mkcert is not installed. Installing with Homebrew...')}`);
  try {
    await execFileAsync(brew, ['install', 'mkcert'], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`${ICON.err} ${c.red('Failed to install mkcert with Homebrew.')}${detail ? `\n${detail}` : ''}`);
  }

  const installed = await findExecutable('mkcert');
  if (!installed) {
    throw new Error(`${ICON.err} ${c.red('mkcert installation completed, but mkcert was not found on PATH.')}`);
  }
  return installed;
}

function getRequiredLocalHttpsNames(): string[] {
  const localName = getLocalAccessSetting().name;
  return [
    '*.termdock.local',
    `${localName}.termdock.local`,
    ...getLanIPv4Addresses(),
    'localhost',
    '127.0.0.1',
    '::1',
  ];
}

async function readCertificateSans(certPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sanMatches(required: string, sans: string[]): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(required) || required.includes(':')) {
    return sans.some((san) => san === `IP Address:${required}` || san === `IP:${required}`);
  }
  return sans.some((san) => san === `DNS:${required}`);
}

async function defaultCertificateNeedsRefresh(): Promise<boolean> {
  if (!fileExists(defaultHttpsCertPath) || !fileExists(defaultHttpsKeyPath)) return false;
  const sans = await readCertificateSans(defaultHttpsCertPath);
  if (sans.length === 0) return true;
  return getRequiredLocalHttpsNames().some((name) => !sanMatches(name, sans));
}

async function ensureDefaultHttpsCertificateFresh(): Promise<boolean> {
  if (!(await defaultCertificateNeedsRefresh())) return false;
  console.log(`${ICON.info} ${c.dim('Local HTTPS certificate is missing current domain/IP SANs; regenerating...')}`);
  await runSetupLocalHttps({ quietRestartHint: true });
  return true;
}

async function runSetupLocalHttps(options: { quietRestartHint?: boolean } = {}): Promise<void> {
  const mkcert = await ensureMkcertInstalled();

  ensureStateDir();
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

  console.log(`${ICON.info} ${c.dim('Installing local CA into this computer trust store...')}`);
  await execFileAsync(mkcert, ['-install'], { timeout: 120000, maxBuffer: 1024 * 1024 });

  console.log(`${ICON.info} ${c.dim('Generating local certificate for Termdock domains...')}`);
  await execFileAsync(mkcert, [
    '-cert-file', defaultHttpsCertPath,
    '-key-file', defaultHttpsKeyPath,
    ...getRequiredLocalHttpsNames(),
  ], { cwd: certDir, timeout: 120000, maxBuffer: 1024 * 1024 });

  try {
    const { stdout } = await execFileAsync(mkcert, ['-CAROOT'], { timeout: 5000, maxBuffer: 64 * 1024 });
    const rootCA = path.join(stdout.trim(), 'rootCA.pem');
    if (fs.existsSync(rootCA)) {
      fs.copyFileSync(rootCA, defaultHttpsCaPath);
      try { fs.chmodSync(defaultHttpsCaPath, 0o600); } catch { /* ignore */ }
    }
  } catch { /* CA download is optional but recommended */ }

  try { fs.chmodSync(defaultHttpsCertPath, 0o600); } catch { /* ignore */ }
  try { fs.chmodSync(defaultHttpsKeyPath, 0o600); } catch { /* ignore */ }

  console.log(`${ICON.ok} ${c.green('Local HTTPS certificates are ready.')}`);
  console.log(`  ${c.dim('Cert:')} ${c.cyan(defaultHttpsCertPath)}`);
  console.log(`  ${c.dim('Key:')}  ${c.cyan(defaultHttpsKeyPath)}`);
  if (fs.existsSync(defaultHttpsCaPath)) {
    console.log(`  ${c.dim('CA:')}   ${c.cyan(defaultHttpsCaPath)} ${c.dim('(served on mobile setup page)')}`);
  }
  console.log('');
  if (!options.quietRestartHint) {
    console.log(`${ICON.info} ${c.dim('Restart Termdock to use HTTPS:')} ${c.cyan('td --stop && td')}`);
  }
}

function printRunningState(state: ServerState) {
  const displayHost = state.host === '0.0.0.0' ? 'localhost' : state.host;
  const authLine = isAuthEnabled()
    ? `${c.green('enabled')} ${c.dim('(password required)')}`
    : `${c.red('disabled')} ${c.dim('(no password — anyone on the LAN can connect)')}`;
  console.log(`${ICON.ok} ${c.green('Termdock is running in background.')}`);
  console.log(`  ${c.dim('PID:')}  ${state.pid}`);
  console.log(`  ${c.dim('URL:')}  ${c.cyan(state.localUrl ?? `http://${displayHost}:${state.port}`)}`);
  if (state.lanUrl) console.log(`  ${c.dim('LAN:')}  ${c.cyan(state.lanUrl)} ${state.localAccessStatus ? c.dim(`(${state.localAccessStatus})`) : ''}`);
  if (state.onboardingUrl) console.log(`  ${c.dim('Setup:')} ${c.cyan(state.onboardingUrl)} ${c.dim('(open this on your phone to download the CA certificate)')}`);
  if (state.localAccessReason) console.log(`  ${c.dim('LAN note:')} ${state.localAccessReason}`);
  console.log(`  ${c.dim('Log:')}  ${state.logFile}`);
  console.log(`  ${c.dim('Auth:')} ${authLine}`);
}

function parseArgs(argv: string[]): CliOptions {
  let host: string | undefined;
  let port: number | undefined;
  let httpsCert: string | undefined;
  let httpsKey: string | undefined;
  let httpsCa: string | undefined;
  let setupLocalHttps = false;
  let foreground = false;
  let status = false;
  let stop = false;
  let setPassword = false;
  let clearPassword = false;
  let tls = false;
  let tlsAll = false;
  let tlsJson = false;
  let attachTmux = false;
  let attachTmuxName: string | undefined;
  let newTmux = false;
  let newTmuxName: string | undefined;
  let newTmuxAttach = true;
  let injectChangeAudit: string | true | undefined;
  let injectBranchAudit: string | true | undefined;
  let branchAuditExport: { base: string; cwd?: string } | undefined;
  let changeAuditExport: string | true | undefined;
  let changeAuditList: string | true | undefined;
  let changeAuditShow: { id: string; cwd?: string } | undefined;
  let injectChangeAuditHunk: { id: string; cwd?: string } | undefined;

  // Short command aliases for the common path. Keep these positional-only so
  // long-form flags remain the single source of truth for option semantics.
  if (argv[0] && !argv[0].startsWith('-')) {
    const command = argv[0];
    const next = argv[1];
    if (command === 'tls' || command === 'l' || command === 'ls') {
      tls = true;
      argv = argv.slice(1);
    } else if (command === 'la') {
      tls = true;
      tlsAll = true;
      argv = argv.slice(1);
    } else if (command === 's' || command === 'st') {
      status = true;
      argv = argv.slice(1);
    } else if (command === 'x' || command === 'stop') {
      stop = true;
      argv = argv.slice(1);
    } else if (command === 'p' || command === 'pw') {
      setPassword = true;
      argv = argv.slice(1);
    } else if (command === 'pc' || command === 'pwc') {
      clearPassword = true;
      argv = argv.slice(1);
    } else if (command === 'https') {
      setupLocalHttps = true;
      argv = argv.slice(1);
    } else if (command === 'a' || command === 'at') {
      attachTmux = true;
      if (next && !next.startsWith('-')) {
        attachTmuxName = next;
        argv = argv.slice(2);
      } else {
        argv = argv.slice(1);
      }
    } else if (command === 'n' || command === 'nt') {
      newTmux = true;
      newTmuxAttach = true;
      if (next && !next.startsWith('-')) {
        newTmuxName = next;
        argv = argv.slice(2);
      } else {
        argv = argv.slice(1);
      }
    } else if (command === 'nd') {
      newTmux = true;
      newTmuxAttach = false;
      if (next && !next.startsWith('-')) {
        newTmuxName = next;
        argv = argv.slice(2);
      } else {
        argv = argv.slice(1);
      }
    } else if (command === 'audit') {
      injectChangeAudit = next && !next.startsWith('-') ? next : true;
      argv = argv.slice(injectChangeAudit === true ? 1 : 2);
    } else if (command === 'branch-audit') {
      injectBranchAudit = next && !next.startsWith('-') ? next : true;
      argv = argv.slice(injectBranchAudit === true ? 1 : 2);
    } else if (command === 'branch-audit-export' && next && !next.startsWith('-')) {
      const cwd = argv[2] && !argv[2].startsWith('-') ? argv[2] : undefined;
      branchAuditExport = { base: next, cwd };
      argv = argv.slice(cwd ? 3 : 2);
    } else if (command === 'audit-list') {
      changeAuditList = next && !next.startsWith('-') ? next : true;
      argv = argv.slice(changeAuditList === true ? 1 : 2);
    } else if (command === 'audit-export') {
      changeAuditExport = next && !next.startsWith('-') ? next : true;
      argv = argv.slice(changeAuditExport === true ? 1 : 2);
    } else if ((command === 'audit-show' || command === 'audit-explain') && next && !next.startsWith('-')) {
      const cwd = argv[2] && !argv[2].startsWith('-') ? argv[2] : undefined;
      if (command === 'audit-show') changeAuditShow = { id: next, cwd };
      else injectChangeAuditHunk = { id: next, cwd };
      argv = argv.slice(cwd ? 3 : 2);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--host') {
      host = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const nextValue = argv[index + 1];
      const parsedPort = Number(nextValue);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        console.error(`${ICON.err} ${c.red(`Invalid port: ${nextValue ?? ''}`)}`);
        process.exit(1);
      }
      port = parsedPort;
      index += 1;
      continue;
    }

    if (arg === '--https-cert') {
      httpsCert = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--https-key') {
      httpsKey = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--https-ca') {
      httpsCa = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--setup-local-https') {
      setupLocalHttps = true;
      continue;
    }

    if (arg === '--foreground') {
      foreground = true;
      continue;
    }

    if (arg === '--status') {
      status = true;
      continue;
    }

    if (arg === '--stop') {
      stop = true;
      continue;
    }

    if (arg === '--set-password') {
      setPassword = true;
      continue;
    }

    if (arg === '--clear-password') {
      clearPassword = true;
      continue;
    }

    if (arg === '--tls') {
      tls = true;
      continue;
    }

    if (arg === '-a' || arg === '--all') {
      tlsAll = true;
      continue;
    }

    if (arg === '--json') {
      tlsJson = true;
      continue;
    }

    if (arg === '--attach-tmux') {
      attachTmux = true;
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        attachTmuxName = next;
        index += 1;
      }
      continue;
    }

    if (arg === '--new-tmux') {
      newTmux = true;
      newTmuxAttach = true;
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        newTmuxName = next;
        index += 1;
      }
      continue;
    }

    if (arg === '--new-tmux-detached') {
      newTmux = true;
      newTmuxAttach = false;
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        newTmuxName = next;
        index += 1;
      }
      continue;
    }

    if (arg === '--inject-change-audit') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        injectChangeAudit = next;
        index += 1;
      } else {
        injectChangeAudit = true;
      }
      continue;
    }

    if (arg === '--inject-branch-audit') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        injectBranchAudit = next;
        index += 1;
      } else {
        injectBranchAudit = true;
      }
      continue;
    }

    if (arg === '--branch-audit-export') {
      const base = argv[index + 1];
      if (!base || base.startsWith('-')) {
        console.error(`${ICON.err} ${c.red('--branch-audit-export requires a base branch/ref')}`);
        process.exit(1);
      }
      const cwd = argv[index + 2] && !argv[index + 2].startsWith('-') ? argv[index + 2] : undefined;
      branchAuditExport = { base, cwd };
      index += cwd ? 2 : 1;
      continue;
    }

    if (arg === '--change-audit-list') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        changeAuditList = next;
        index += 1;
      } else {
        changeAuditList = true;
      }
      continue;
    }

    if (arg === '--change-audit-export') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        changeAuditExport = next;
        index += 1;
      } else {
        changeAuditExport = true;
      }
      continue;
    }

    if (arg === '--change-audit-show' || arg === '--change-audit-explain') {
      const id = argv[index + 1];
      if (!id || id.startsWith('-')) {
        console.error(`${ICON.err} ${c.red(`${arg} requires a hunk id`)}`);
        process.exit(1);
      }
      const cwd = argv[index + 2] && !argv[index + 2].startsWith('-') ? argv[index + 2] : undefined;
      if (arg === '--change-audit-show') changeAuditShow = { id, cwd };
      else injectChangeAuditHunk = { id, cwd };
      index += cwd ? 2 : 1;
      continue;
    }

    if (!arg.startsWith('-')) {
      if (attachTmux && !attachTmuxName) {
        attachTmuxName = arg;
        continue;
      }
      if (newTmux && !newTmuxName) {
        newTmuxName = arg;
        continue;
      }
    }

    console.error(`${ICON.err} ${c.red(`Unknown argument: ${arg}`)}`);
    printHelp();
    process.exit(1);
  }

  return {
    host,
    port,
    httpsCert,
    httpsKey,
    httpsCa,
    setupLocalHttps,
    foreground,
    status,
    stop,
    setPassword,
    clearPassword,
    tls,
    tlsAll,
    tlsJson,
    attachTmux,
    attachTmuxName,
    newTmux,
    newTmuxName,
    newTmuxAttach,
    injectChangeAudit,
    injectBranchAudit,
    branchAuditExport,
    changeAuditExport,
    changeAuditList,
    changeAuditShow,
    injectChangeAuditHunk,
  };
}

// Reads a single line from stdin without echoing keystrokes. Used for password
// entry. Falls back to plain readline (with echo) if stdin is not a TTY, e.g.
// when piping a password in via `echo ... | td --set-password`.
async function promptHidden(prompt: string): Promise<string> {
  const isTty = Boolean((process.stdin as NodeJS.ReadStream).isTTY);

  if (!isTty) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  process.stdout.write(prompt);

  return new Promise((resolve) => {
    // Mute stdout so the typed password is not echoed.
    let muted = true;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout as unknown as NodeJS.WritableStream,
      terminal: true,
    });

    // Allow newline once the user finishes typing.
    rl.once('line', (line) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(line);
    });
  });
}

async function runSetPassword(): Promise<void> {
  const isTty = Boolean((process.stdin as NodeJS.ReadStream).isTTY);
  const wasEnabled = isAuthEnabled();

  if (isTty) {
    console.log(`${ICON.lock} ${c.bold('Termdock — set access password')}`);
    console.log(c.dim('  Password must be at least 6 characters. Input is hidden.'));
    console.log('');
  }

  const password = await promptHidden('  New password: ');
  if (!password) {
    console.error(`\n${ICON.err} ${c.red('Password cannot be empty.')}`);
    process.exit(1);
  }

  if (password.length < 6) {
    console.error(`\n${ICON.err} ${c.red('Password must be at least 6 characters.')}`);
    process.exit(1);
  }

  if (isTty) {
    const confirm = await promptHidden('  Confirm password: ');
    if (confirm !== password) {
      console.error(`\n${ICON.err} ${c.red('Passwords do not match. Try again.')}`);
      process.exit(1);
    }
  }

  const hash = hashPassword(password);
  writeAuthFile(hash);
  // Changing the password invalidates all existing sessions so old clients
  // are forced to re-authenticate.
  destroyAllSessions();

  console.log('');
  console.log(`${ICON.ok} ${c.green(wasEnabled ? 'Password updated.' : 'Password set. Authentication enabled.')}`);
  console.log(`  ${c.dim('Stored at:')}      ${c.cyan(path.join('~', '.termdock', 'auth.json'))} ${c.dim('(mode 0600, scrypt hash)')}`);
  console.log(`  ${c.dim('Sessions:')}       ${c.dim('all existing browsers were signed out')}`);
  if (isEnvPasswordSet()) {
    console.log(`${ICON.warn} ${c.yellow('TERMDOCK_PASSWORD is set in the environment — it takes precedence over the stored password.')}`);
  }

  // If the server is running, nudge the user to restart so the in-memory
  // auth state reloads from disk.
  const running = getRunningState();
  if (running) {
    console.log('');
    console.log(`${ICON.info} ${c.yellow('Termdock is currently running — restart it so the change takes effect:')}`);
    console.log(`     ${c.cyan('td --stop && td')}`);
  } else {
    console.log('');
    console.log(`${ICON.info} ${c.dim('Start Termdock with:')} ${c.cyan('td')}`);
  }
}

function runClearPassword(): void {
  if (!isAuthEnabled()) {
    console.log(`${ICON.info} ${c.dim('Authentication is already disabled — nothing to clear.')}`);
    process.exit(0);
  }

  clearAuthFile();
  destroyAllSessions();

  if (isEnvPasswordSet()) {
    console.log(`${ICON.ok} ${c.green('Stored password cleared.')}`);
    console.log(`  ${c.dim('All existing sessions have been invalidated.')}`);
    console.log('');
    console.log(`${ICON.info} ${c.yellow('TERMDOCK_PASSWORD is set in the environment — authentication stays enabled.')}`);
    console.log(`  ${c.dim('Unset the variable to fully disable authentication.')}`);
  } else {
    console.log(`${ICON.ok} ${c.green('Password cleared. Authentication is now disabled.')}`);
    console.log(`  ${c.dim('All existing sessions have been invalidated.')}`);
    console.log('');
    console.log(`${ICON.warn} ${c.yellow('Warning:')} ${c.dim('the server is now reachable by anyone who can reach the host/port.')}`);
    console.log(`  ${c.dim('Re-enable auth at any time with:')} ${c.cyan('td --set-password')}`);
  }

  const running = getRunningState();
  if (running) {
    console.log('');
    console.log(`${ICON.info} ${c.yellow('Termdock is currently running — restart it so the change takes effect:')}`);
    console.log(`     ${c.cyan('td --stop && td')}`);
  }
}

async function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

async function postLocalJson(baseUrl: string, token: string, endpoint: string, payload: unknown): Promise<{ statusCode: number; body: string }> {
  const url = new URL(endpoint, baseUrl);
  const body = JSON.stringify(payload);
  const isHttps = url.protocol === 'https:';
  const requestImpl = isHttps ? https.request : http.request;
  const ca = isHttps && fs.existsSync(defaultHttpsCaPath) ? fs.readFileSync(defaultHttpsCaPath) : undefined;

  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      ca,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Termdock-Local-Token': token,
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runInjectChangeAudit(source: string | true): Promise<void> {
  const raw = source === true
    ? await readStdinText()
    : fs.readFileSync(path.resolve(source), 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${ICON.err} ${c.red(`Invalid change audit JSON: ${message}`)}`);
    process.exit(1);
  }

  await postChangeAuditPayload(payload);
}

async function postChangeAuditPayload(payload: unknown): Promise<void> {
  const runningState = getRunningState();
  if (!runningState) {
    console.error(`${ICON.err} ${c.red('Termdock is not running. Start it before injecting change audit explanations.')}`);
    process.exit(1);
  }
  const token = runningState.localApiToken;
  if (!token) {
    console.error(`${ICON.err} ${c.red('Running Termdock server does not expose a local injection token. Restart Termdock first.')}`);
    process.exit(1);
  }

  const baseUrl = runningState.localUrl ?? `${runningState.scheme ?? 'http'}://${runningState.host === '0.0.0.0' ? 'localhost' : runningState.host}:${runningState.port}`;
  const response = await postLocalJson(baseUrl, token, '/api/local/change-audit', payload);
  const body = JSON.parse(response.body || '{}') as { inserted?: number; total?: number; walkthroughs?: number; error?: string };
  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error(`${ICON.err} ${c.red(body.error || 'Failed to inject change audit explanations')}`);
    process.exit(1);
  }
  console.log(`${ICON.ok} ${c.green('Injected change audit explanations.')}`);
  console.log(`  ${c.dim('Inserted:')} ${body.inserted ?? 0}`);
  console.log(`  ${c.dim('Total:')}    ${body.total ?? 0}`);
  if (typeof body.walkthroughs === 'number') {
    console.log(`  ${c.dim('Walkthroughs:')} ${body.walkthroughs}`);
  }
}

async function runInjectBranchAudit(source: string | true): Promise<void> {
  const runningState = getRunningState();
  if (!runningState) {
    console.error(`${ICON.err} ${c.red('Termdock is not running. Start it before injecting branch explanations.')}`);
    process.exit(1);
  }
  const token = runningState.localApiToken;
  if (!token) {
    console.error(`${ICON.err} ${c.red('Running Termdock server does not expose a local injection token. Restart Termdock first.')}`);
    process.exit(1);
  }

  const raw = source === true
    ? await readStdinText()
    : fs.readFileSync(path.resolve(source), 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${ICON.err} ${c.red(`Invalid branch audit JSON: ${message}`)}`);
    process.exit(1);
  }

  const baseUrl = runningState.localUrl ?? `${runningState.scheme ?? 'http'}://${runningState.host === '0.0.0.0' ? 'localhost' : runningState.host}:${runningState.port}`;
  const response = await postLocalJson(baseUrl, token, '/api/local/branch-audit', payload);
  const body = JSON.parse(response.body || '{}') as { inserted?: number; total?: number; walkthroughs?: number; error?: string };
  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error(`${ICON.err} ${c.red(body.error || 'Failed to inject branch explanation')}`);
    process.exit(1);
  }
  console.log(`${ICON.ok} ${c.green('Injected branch explanation.')}`);
  console.log(`  ${c.dim('Inserted:')} ${body.inserted ?? 0}`);
  console.log(`  ${c.dim('Total:')}    ${body.total ?? 0}`);
  if (typeof body.walkthroughs === 'number') {
    console.log(`  ${c.dim('Walkthroughs:')} ${body.walkthroughs}`);
  }
}

interface ChangeAuditCliHunk {
  id: string;
  workspaceRoot: string;
  repoRoot: string;
  displayRoot: string;
  relativeRoot: string;
  filePath: string;
  displayPath: string;
  oldPath: string | null;
  newPath: string | null;
  hunkHeader: string;
  hunkIndex: number;
  fingerprint: string;
  additions: number;
  deletions: number;
  sections: ChangeAuditCliSection[];
  diff: string;
}

interface ChangeAuditCliSection {
  index: number;
  sectionFingerprint: string;
  additions: number;
  deletions: number;
  diff: string;
}

interface AuditRepositoryTarget {
  workspaceRoot: string;
  repoRoot: string;
  displayRoot: string;
  relativeRoot: string;
}

interface ChangeAuditCliSnapshot {
  version: 1;
  createdAt: number;
  sourceRoot: string;
  hunks: ChangeAuditCliHunk[];
}

interface ChangeAuditRepoCoverage {
  repoRoot: string;
  relativeRoot: string;
  trackedDiffBytes: number;
  untrackedFiles: string[];
  untrackedDiffBytes: number;
}

interface ChangeAuditHunksResult {
  hunks: ChangeAuditCliHunk[];
  coverage: ChangeAuditRepoCoverage[];
}

const CHANGE_AUDIT_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeDiffPath(value: string): string | null {
  if (!value || value === '/dev/null') return null;
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function buildHunkChangeFingerprint(lines: string[]): string {
  const changedLines = lines
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => `${line.startsWith('+') ? 'insert' : 'delete'}:${line.slice(1)}`);
  const text = changedLines.length > 0
    ? changedLines.join('\n')
    : lines.map((line) => line.slice(1)).join('\n');
  return fnv1a32(text);
}

function buildAuditSectionFingerprint(lines: string[]): string {
  const text = lines
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => `${line.startsWith('+') ? 'insert' : 'delete'}:${line.slice(1)}`)
    .join('\n');
  return fnv1a32(text);
}

function buildAuditSections(lines: string[], hunkHeader: string, contextSize = 2): ChangeAuditCliSection[] {
  const sections: ChangeAuditCliSection[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].startsWith('+') && !lines[cursor].startsWith('-')) cursor += 1;
    while (cursor < lines.length && (lines[cursor].startsWith('+++') || lines[cursor].startsWith('---'))) cursor += 1;
    if (cursor >= lines.length) break;
    const start = cursor;
    while (cursor < lines.length && (lines[cursor].startsWith('+') || lines[cursor].startsWith('-')) && !lines[cursor].startsWith('+++') && !lines[cursor].startsWith('---')) cursor += 1;
    const end = cursor;
    const contextBefore = lines.slice(Math.max(0, start - contextSize), start).filter((line) => line.startsWith(' '));
    const contextAfter = lines.slice(end, Math.min(lines.length, end + contextSize)).filter((line) => line.startsWith(' '));
    const changed = lines.slice(start, end);
    sections.push({
      index: sections.length,
      sectionFingerprint: buildAuditSectionFingerprint(changed),
      additions: changed.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: changed.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      diff: [hunkHeader, ...contextBefore, ...changed, ...contextAfter].join('\n'),
    });
  }
  return sections;
}

async function getGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function hasGitMetadata(candidate: string): Promise<boolean> {
  return fs.promises.stat(path.join(candidate, '.git')).then(() => true).catch(() => false);
}

async function getDirectoryTarget(candidate: string): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(candidate);
    if (stat.isDirectory()) return candidate;
    if (!stat.isSymbolicLink()) return null;
    const realPath = await fs.promises.realpath(candidate);
    return (await fs.promises.stat(realPath)).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

const AUDIT_NESTED_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.vite',
  '.turbo',
  '.cache',
  'coverage',
  'Pods',
  'DerivedData',
]);

async function discoverAuditRepositories(workspaceRoot: string): Promise<AuditRepositoryTarget[]> {
  const workspaceGitRoot = await getGitRoot(workspaceRoot);
  const targets: AuditRepositoryTarget[] = [{
    workspaceRoot,
    repoRoot: workspaceGitRoot,
    displayRoot: workspaceRoot,
    relativeRoot: '.',
  }];
  const seen = new Set([workspaceGitRoot]);
  const deadline = Date.now() + 1_000;

  async function visit(dir: string): Promise<void> {
    if (Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return;
      if (AUDIT_NESTED_IGNORED_NAMES.has(entry.name)) continue;
      const candidate = path.join(dir, entry.name);
      const target = await getDirectoryTarget(candidate);
      if (!target) continue;
      if (await hasGitMetadata(candidate) || await hasGitMetadata(target)) {
        const repoRoot = await getGitRoot(target).catch(() => null);
        if (repoRoot && !seen.has(repoRoot)) {
          seen.add(repoRoot);
          const relativeRoot = path.relative(workspaceRoot, candidate).split(path.sep).join('/') || '.';
          targets.push({ workspaceRoot, repoRoot, displayRoot: candidate, relativeRoot });
        }
        continue;
      }
      if (!entry.isSymbolicLink()) await visit(target);
    }
  }

  await visit(workspaceRoot);
  return targets.sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot));
}

async function readWorkingTreeDiff(repoRoot: string): Promise<{ diff: string; trackedDiffBytes: number; untrackedFiles: string[]; untrackedDiffBytes: number }> {
  const [cached, worktree, untracked] = await Promise.all([
    execFileAsync('git', ['diff', '-M', '--cached'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => ''),
    execFileAsync('git', ['diff', '-M'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => ''),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).then(async ({ stdout }) => {
      const pieces: string[] = [];
      const files = stdout.split('\0').filter(Boolean);
      for (const filePath of files) {
        try {
          const { stdout: diff } = await execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', filePath], {
            cwd: repoRoot,
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          if (diff) pieces.push(diff);
        } catch (error) {
          const maybe = error as { stdout?: string };
          if (maybe.stdout) pieces.push(maybe.stdout);
        }
      }
      const diff = pieces.join('\n');
      return { files, diff, bytes: Buffer.byteLength(diff, 'utf8') };
    }).catch(() => ({ files: [] as string[], diff: '', bytes: 0 })),
  ]);
  const trackedDiff = [cached, worktree].filter(Boolean).join('\n');
  return {
    diff: [trackedDiff, untracked.diff].filter(Boolean).join('\n'),
    trackedDiffBytes: Buffer.byteLength(trackedDiff, 'utf8'),
    untrackedFiles: untracked.files,
    untrackedDiffBytes: untracked.bytes,
  };
}

function parseAuditHunks(target: AuditRepositoryTarget, diffText: string): ChangeAuditCliHunk[] {
  const hunks: ChangeAuditCliHunk[] = [];
  const lines = diffText.split('\n');
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let currentHeader: string | null = null;
  let currentLines: string[] = [];
  let hunkIndexByFile = 0;

  const flush = () => {
    if (!currentHeader || (!oldPath && !newPath)) return;
    const filePath = newPath ?? oldPath ?? '';
    const displayPath = target.relativeRoot === '.' ? filePath : `${target.relativeRoot}/${filePath}`;
    const oldDiffPath = oldPath ? `a/${oldPath}` : '/dev/null';
    const newDiffPath = newPath ? `b/${newPath}` : '/dev/null';
    const hunkDiff = [
      `diff --git a/${oldPath ?? filePath} b/${newPath ?? filePath}`,
      `--- ${oldDiffPath}`,
      `+++ ${newDiffPath}`,
      currentHeader,
      ...currentLines,
    ].join('\n');
    const fingerprint = buildHunkChangeFingerprint(currentLines);
    const id = createHash('sha256')
      .update(`${target.repoRoot}\0${filePath}\0${currentHeader}\0${hunkIndexByFile}\0${fingerprint}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    hunks.push({
      id,
      workspaceRoot: target.workspaceRoot,
      repoRoot: target.repoRoot,
      displayRoot: target.displayRoot,
      relativeRoot: target.relativeRoot,
      filePath,
      displayPath,
      oldPath,
      newPath,
      hunkHeader: currentHeader,
      hunkIndex: hunkIndexByFile,
      fingerprint,
      additions: currentLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: currentLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      sections: buildAuditSections(currentLines, currentHeader),
      diff: hunkDiff,
    });
    hunkIndexByFile += 1;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentHeader = null;
      currentLines = [];
      hunkIndexByFile = 0;
      const match = /^diff --git (.+) (.+)$/.exec(line);
      oldPath = normalizeDiffPath(match?.[1] ?? '');
      newPath = normalizeDiffPath(match?.[2] ?? '');
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@ ')) {
      flush();
      currentHeader = line;
      currentLines = [];
      continue;
    }
    if (currentHeader) currentLines.push(line);
  }
  flush();
  return hunks;
}

async function getAuditHunksWithCoverage(cwdInput?: string | true): Promise<ChangeAuditHunksResult> {
  const workspaceRoot = typeof cwdInput === 'string' ? path.resolve(cwdInput) : process.cwd();
  const targets = await discoverAuditRepositories(workspaceRoot);
  const byRepo = await Promise.all(targets.map(async (target) => {
    const result = await readWorkingTreeDiff(target.repoRoot).catch(() => ({
      diff: '',
      trackedDiffBytes: 0,
      untrackedFiles: [] as string[],
      untrackedDiffBytes: 0,
    }));
    return {
      hunks: parseAuditHunks(target, result.diff),
      coverage: {
        repoRoot: target.repoRoot,
        relativeRoot: target.relativeRoot,
        trackedDiffBytes: result.trackedDiffBytes,
        untrackedFiles: result.untrackedFiles,
        untrackedDiffBytes: result.untrackedDiffBytes,
      },
    };
  }));
  return {
    hunks: byRepo.flatMap((entry) => entry.hunks),
    coverage: byRepo.map((entry) => entry.coverage),
  };
}

async function getAuditHunks(cwdInput?: string | true): Promise<ChangeAuditCliHunk[]> {
  return (await getAuditHunksWithCoverage(cwdInput)).hunks;
}

function normalizeAuditSourceRoot(cwdInput?: string | true): string {
  return typeof cwdInput === 'string' ? path.resolve(cwdInput) : process.cwd();
}

function isChangeAuditCliHunk(value: unknown): value is ChangeAuditCliHunk {
  if (!value || typeof value !== 'object') return false;
  const hunk = value as Partial<ChangeAuditCliHunk>;
  return typeof hunk.id === 'string'
    && typeof hunk.workspaceRoot === 'string'
    && typeof hunk.repoRoot === 'string'
    && typeof hunk.filePath === 'string'
    && typeof hunk.hunkHeader === 'string'
    && typeof hunk.fingerprint === 'string';
}

function readChangeAuditSnapshot(source: string | true | undefined): ChangeAuditCliSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(changeAuditSnapshotPath, 'utf8')) as Partial<ChangeAuditCliSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.hunks) || typeof parsed.createdAt !== 'number') return null;
    if (Date.now() - parsed.createdAt > CHANGE_AUDIT_SNAPSHOT_MAX_AGE_MS) return null;
    const sourceRoot = normalizeAuditSourceRoot(source);
    if (typeof parsed.sourceRoot !== 'string' || path.resolve(parsed.sourceRoot) !== sourceRoot) return null;
    const hunks = parsed.hunks.filter(isChangeAuditCliHunk);
    return { version: 1, createdAt: parsed.createdAt, sourceRoot: parsed.sourceRoot, hunks };
  } catch {
    return null;
  }
}

function writeChangeAuditSnapshot(source: string | true | undefined, hunks: ChangeAuditCliHunk[]): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const payload: ChangeAuditCliSnapshot = {
      version: 1,
      createdAt: Date.now(),
      sourceRoot: normalizeAuditSourceRoot(source),
      hunks,
    };
    fs.writeFileSync(changeAuditSnapshotPath, JSON.stringify(payload), { mode: 0o600 });
  } catch {
    // Snapshot writes are best-effort; the CLI can always fall back to live git diff.
  }
}

async function getAuditHunkById(id: string, cwdInput?: string): Promise<ChangeAuditCliHunk | null> {
  const snapshot = readChangeAuditSnapshot(cwdInput);
  const cached = snapshot?.hunks.find((candidate) => candidate.id === id);
  if (cached) return cached;
  return (await getAuditHunks(cwdInput)).find((candidate) => candidate.id === id) ?? null;
}

async function readBranchDiff(repoRoot: string, baseInput: string): Promise<{ baseRef: string; branchName: string | null; headRef: string | null; diff: string; diffFingerprint: string }> {
  const base = baseInput.trim();
  let baseRef = base.includes('/') ? base : `origin/${base}`;
  if (base.includes('/')) {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', baseRef], { cwd: repoRoot, timeout: 10_000, maxBuffer: 128 * 1024 });
  } else {
    try {
      await execFileAsync('git', ['fetch', 'origin', base, '--no-tags'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 512 * 1024 });
    } catch {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', base], { cwd: repoRoot, timeout: 10_000, maxBuffer: 128 * 1024 });
      baseRef = base;
    }
  }
  const [branchName, headRef, branchDiff, workingDiff, untrackedDiff] = await Promise.all([
    execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, timeout: 10_000, maxBuffer: 128 * 1024 }).then((r) => r.stdout.trim() || null).catch(() => null),
    execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, timeout: 10_000, maxBuffer: 128 * 1024 }).then((r) => r.stdout.trim() || null).catch(() => null),
    execFileAsync('git', ['diff', `${baseRef}...HEAD`], { cwd: repoRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => ''),
    execFileAsync('git', ['diff', 'HEAD'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => ''),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).then(async ({ stdout }) => {
      const pieces: string[] = [];
      for (const filePath of stdout.split('\0').filter(Boolean)) {
        try {
          const { stdout: diff } = await execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', filePath], {
            cwd: repoRoot,
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          if (diff) pieces.push(diff);
        } catch (error) {
          const maybe = error as { stdout?: string };
          if (maybe.stdout) pieces.push(maybe.stdout);
        }
      }
      return pieces.join('\n');
    }).catch(() => ''),
  ]);
  const diff = [branchDiff, workingDiff, untrackedDiff].filter(Boolean).join('\n');
  const diffFingerprint = createHash('sha256').update([repoRoot, baseRef, branchName ?? '', headRef ?? '', diff].join('\n'), 'utf8').digest('hex').slice(0, 16);
  return { baseRef, branchName, headRef, diff, diffFingerprint };
}

async function runBranchAuditExport(request: { base: string; cwd?: string }): Promise<void> {
  const workspaceRoot = path.resolve(request.cwd ?? process.cwd());
  const repoRoot = await getGitRoot(workspaceRoot);
  const target: AuditRepositoryTarget = {
    workspaceRoot,
    repoRoot,
    displayRoot: workspaceRoot,
    relativeRoot: '.',
  };
  const branchDiff = await readBranchDiff(repoRoot, request.base);
  const hunks = parseAuditHunks(target, branchDiff.diff);
  console.log(JSON.stringify({
    version: 1,
    scope: 'branch',
    workspaceRoot,
    repoRoot,
    baseRef: branchDiff.baseRef,
    branchName: branchDiff.branchName,
    headRef: branchDiff.headRef,
    diffFingerprint: branchDiff.diffFingerprint,
    count: hunks.length,
    hunks,
  }, null, 2));
}

async function runChangeAuditList(source: string | true | undefined): Promise<void> {
  const hunks = await getAuditHunks(source);
  writeChangeAuditSnapshot(source, hunks);
  console.log(JSON.stringify({
    version: 1,
    count: hunks.length,
    hunks: hunks.map(({ diff, ...hunk }) => hunk),
  }, null, 2));
}

async function runChangeAuditExport(source: string | true | undefined): Promise<void> {
  const { hunks, coverage } = await getAuditHunksWithCoverage(source);
  writeChangeAuditSnapshot(source, hunks);
  console.log(JSON.stringify({
    version: 1,
    count: hunks.length,
    coverage,
    hunks,
  }, null, 2));
}

async function runChangeAuditShow(request: { id: string; cwd?: string }): Promise<void> {
  const hunk = await getAuditHunkById(request.id, request.cwd);
  if (!hunk) {
    console.error(`${ICON.err} ${c.red(`No current diff hunk found for id ${request.id}`)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(hunk, null, 2));
}

async function runInjectChangeAuditHunk(request: { id: string; cwd?: string }): Promise<void> {
  const explanation = (await readStdinText()).trim();
  if (!explanation) {
    console.error(`${ICON.err} ${c.red('Explanation is empty. Pipe explanation text into this command.')}`);
    process.exit(1);
  }
  const hunk = await getAuditHunkById(request.id, request.cwd);
  if (!hunk) {
    console.error(`${ICON.err} ${c.red(`No current diff hunk found for id ${request.id}`)}`);
    process.exit(1);
  }
  const payload = {
    workspaceRoot: hunk.workspaceRoot,
    repoRoot: hunk.repoRoot,
    generatedBy: 'ai-cli',
    records: [{
      repoRoot: hunk.repoRoot,
      filePath: hunk.filePath,
      oldPath: hunk.oldPath,
      newPath: hunk.newPath,
      hunkHeader: hunk.hunkHeader,
      hunkIndex: hunk.hunkIndex,
      fingerprint: hunk.fingerprint,
      summary: explanation.split('\n')[0]?.slice(0, 120) || null,
      explanation,
    }],
  };
  await postChangeAuditPayload(payload);
}

const options = parseArgs(process.argv.slice(2));

if (options.setPassword && options.clearPassword) {
  console.error(`${ICON.err} ${c.red('Cannot use --set-password and --clear-password together.')}`);
  process.exit(1);
}

// Print a clear, attention-grabbing warning whenever the server starts without
// a password set. Easy to miss otherwise — and the security implications
// (anyone on the LAN can drive your shell) are real.
function warnIfAuthDisabled(host: string): void {
  if (isAuthEnabled()) return;
  const exposedToLan = host === '0.0.0.0' || (host !== '127.0.0.1' && host !== 'localhost');
  console.log('');
  console.log(c.yellow('  ╭─────────────────────────────────────────────────────────────╮'));
  console.log(c.yellow('  │ ') + ICON.warn + c.bold(c.yellow(' Authentication is DISABLED'))
    + c.yellow('                                  │'));
  console.log(c.yellow('  │   ') + c.dim('Anyone who can reach this server can run shell commands.')
    + c.yellow('  │'));
  if (exposedToLan) {
    console.log(c.yellow('  │   ') + c.dim('The server is bound to ') + c.red(host)
      + c.dim(' — reachable from the LAN.') + c.yellow('     │'));
  }
  console.log(c.yellow('  │   ') + c.dim('Set a password with: ') + c.cyan('td --set-password')
    + c.yellow('             │'));
  console.log(c.yellow('  ╰─────────────────────────────────────────────────────────────╯'));
  console.log('');
}

// ── `td --tls` (a.k.a `td l` / `td ls` / `termdock --tls`) ──
// Reads termdock metadata directly out of tmux user options. Does not contact
// the termdock server, so it works over plain ssh on any machine that has
// termdock-managed tmux sessions on it (even if the termdock daemon is down).

interface TlsRow {
  name: string;
  attachedCount: string;
  friendlyName: string;
  program: string;
  cwd: string;
  label: string;
  clientCount: string;
  host: string;
  pid: string;
  version: string;
  createdAt: string;
  lastActiveAt: string;
}

function normalizeTmuxSessionName(input: unknown): string {
  if (typeof input !== 'string') {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `wt-${timePart}${randomPart}`;
  }
  const normalized = input.trim();
  if (normalized.length > 0) return normalized;
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `wt-${timePart}${randomPart}`;
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', sessionName], { timeout: 5000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function setTmuxOption(sessionName: string, key: string, value: string): Promise<void> {
  await execFileAsync('tmux', ['set-option', '-t', sessionName, key, value], {
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
}

async function ensureTmuxFocusEvents(): Promise<void> {
  const { stdout } = await execFileAsync('tmux', ['show-options', '-gqv', 'focus-events'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (stdout.trim() === 'on') return;
  await execFileAsync('tmux', ['set-option', '-g', 'focus-events', 'on'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
}

async function ensureTmuxScrollbackProfile(sessionName: string): Promise<void> {
  await execFileAsync('tmux', ['set-option', '-g', 'history-limit', String(TERMDOCK_TMUX_HISTORY_LIMIT)], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'history-limit', String(TERMDOCK_TMUX_HISTORY_LIMIT)], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  try {
    await execFileAsync('tmux', ['set-option', '-gw', 'scroll-on-clear', 'off'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_id}'], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const windowIds = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const windowId of windowIds) {
      await execFileAsync('tmux', ['set-option', '-w', '-t', windowId, 'scroll-on-clear', 'off'], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    }
  } catch {
    // Older tmux versions do not have scroll-on-clear; keep CLI session creation working.
  }
}

async function ensureTmuxCliSessionOptions(sessionName: string): Promise<void> {
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'status', 'off'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'mouse', 'on'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  await ensureTmuxScrollbackProfile(sessionName);
}

async function ensureTmuxColorEnvironment(sessionName?: string): Promise<void> {
  const forceColor = process.env.TERMDOCK_FORCE_COLOR === '1';
  await execFileAsync('tmux', ['set-environment', '-g', 'COLORTERM', 'truecolor'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (forceColor) {
    await execFileAsync('tmux', ['set-environment', '-g', 'FORCE_COLOR', '1'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    await execFileAsync('tmux', ['set-environment', '-g', '-u', 'NO_COLOR'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } else {
    await execFileAsync('tmux', ['set-environment', '-g', '-u', 'FORCE_COLOR'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  }
  if (!sessionName) return;
  await execFileAsync('tmux', ['set-environment', '-t', sessionName, 'COLORTERM', 'truecolor'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (forceColor) {
    await execFileAsync('tmux', ['set-environment', '-t', sessionName, 'FORCE_COLOR', '1'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    await execFileAsync('tmux', ['set-environment', '-t', sessionName, '-u', 'NO_COLOR'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } else {
    await execFileAsync('tmux', ['set-environment', '-t', sessionName, '-u', 'FORCE_COLOR'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  }
}

async function getTmuxOption(sessionName: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['show-option', '-vqt', sessionName, key], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function resolveInvocationCwd(): string {
  const fallback = process.cwd();
  const pwd = process.env.PWD;
  if (!pwd || !path.isAbsolute(pwd)) return fallback;

  try {
    const pwdStat = fs.statSync(pwd);
    const fallbackStat = fs.statSync(fallback);
    if (pwdStat.dev === fallbackStat.dev && pwdStat.ino === fallbackStat.ino && pwdStat.isDirectory()) {
      return pwd;
    }
  } catch {
    // Fall back to Node's cwd when the shell-provided PWD is stale.
  }

  return fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveUserShell(): string {
  const shell = process.env.SHELL;
  if (shell && path.isAbsolute(shell) && fs.existsSync(shell)) {
    return shell;
  }
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
}

async function ensureStampedTmuxSession(
  sessionName: string,
  cwd?: string,
): Promise<{ sessionName: string; created: boolean }> {
  const exists = await tmuxSessionExists(sessionName);
  if (!exists) {
    const args = ['new-session', '-d', '-s', sessionName, '-e', 'COLORTERM=truecolor'];
    if (process.env.TERMDOCK_FORCE_COLOR === '1') {
      args.push('-e', 'FORCE_COLOR=1');
    }
    if (cwd) {
      args.push('-c', cwd);
    }
    if (cwd && process.platform !== 'win32') {
      args.push(`cd ${shellQuote(cwd)} && exec ${shellQuote(resolveUserShell())}`);
    }
    await execFileAsync('tmux', args, {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
  }

  await ensureTmuxFocusEvents();
  await ensureTmuxColorEnvironment(sessionName);
  await ensureTmuxCliSessionOptions(sessionName);
  await setTmuxOption(sessionName, '@termdock-version', TERMDOCK_VERSION);
  await setTmuxOption(sessionName, '@termdock-host', TERMDOCK_HOST);
  await setTmuxOption(sessionName, '@termdock-pid', TERMDOCK_PID);
  const existingCreatedAt = await getTmuxOption(sessionName, '@termdock-created-at');
  if (!existingCreatedAt) {
    await setTmuxOption(sessionName, '@termdock-created-at', String(Date.now()));
  }
  if (!exists && cwd) {
    await setTmuxOption(sessionName, '@termdock-cwd', cwd);
    await setTmuxOption(sessionName, '@termdock-label', getCwdLeafName(cwd));
  }

  return { sessionName, created: !exists };
}

const TLS_FIELDS: Array<keyof TlsRow | 'name'> = [
  'name',
  'attachedCount',
  'friendlyName',
  'program',
  'cwd',
  'label',
  'clientCount',
  'host',
  'pid',
  'version',
  'createdAt',
  'lastActiveAt',
];

const TLS_FORMAT = [
  '#{session_name}',
  '#{session_attached}',
  '#{@termdock-friendly-name}',
  '#{@termdock-program}',
  '#{@termdock-cwd}',
  '#{@termdock-label}',
  '#{@termdock-client-count}',
  '#{@termdock-host}',
  '#{@termdock-pid}',
  '#{@termdock-version}',
  '#{@termdock-created-at}',
  '#{@termdock-last-active-at}',
].join('\t');

function formatIdle(lastActiveAtRaw: string): string {
  const ts = Number(lastActiveAtRaw);
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return '0s';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

function getCwdLeafName(cwd: string): string {
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

function buildTmuxFolderGroups(rows: TlsRow[]): Array<{ key: string; label: string; sessions: TlsRow[] }> {
  const groups: Array<{ key: string; label: string; sessions: TlsRow[] }> = [];
  const byKey = new Map<string, { key: string; label: string; sessions: TlsRow[] }>();

  for (const row of rows) {
    const key = row.cwd.trim().length > 0 ? row.cwd.trim() : '';
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: key ? getCwdLeafName(key) : 'Other',
        sessions: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(row);
  }

  return groups.sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0));
}

function normalizePersistedCliSession(input: unknown): PersistedCliSession | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<PersistedCliSession>;
  if (typeof candidate.sessionId !== 'string' || typeof candidate.name !== 'string') {
    return null;
  }
  return {
    sessionId: candidate.sessionId,
    name: candidate.name,
    customName: candidate.customName === true ? true : undefined,
    backendSessionId: typeof candidate.backendSessionId === 'string' && candidate.backendSessionId.trim().length > 0
      ? candidate.backendSessionId
      : null,
    mode: candidate.mode === 'tmux' ? 'tmux' : 'shell',
    tmuxSessionName: typeof candidate.tmuxSessionName === 'string' && candidate.tmuxSessionName.trim().length > 0
      ? candidate.tmuxSessionName
      : null,
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? Math.floor(candidate.createdAt)
      : Date.now(),
    lastActivity: typeof candidate.lastActivity === 'number' && Number.isFinite(candidate.lastActivity)
      ? Math.floor(candidate.lastActivity)
      : Date.now(),
  };
}

function readGlobalCliSessionState(): GlobalCliSessionState {
  try {
    if (!fs.existsSync(globalSessionStateFilePath)) {
      return { sessions: [], updatedAt: Date.now() };
    }
    const raw = fs.readFileSync(globalSessionStateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GlobalCliSessionState> & { sessions?: unknown[] };
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
        .map((session) => normalizePersistedCliSession(session))
        .filter((session): session is PersistedCliSession => session !== null)
      : [];
    return {
      sessions,
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? Math.floor(parsed.updatedAt)
        : Date.now(),
    };
  } catch {
    return { sessions: [], updatedAt: Date.now() };
  }
}

function writeGlobalCliSessionState(state: GlobalCliSessionState): void {
  ensureStateDir();
  fs.writeFileSync(globalSessionStateFilePath, JSON.stringify(state, null, 2));
}

function registerGuiTmuxSession(sessionName: string): void {
  const now = Date.now();
  const state = readGlobalCliSessionState();
  const nextRecord: PersistedCliSession = {
    sessionId: randomUUID(),
    name: `tmux:${sessionName}`,
    backendSessionId: null,
    mode: 'tmux',
    tmuxSessionName: sessionName,
    createdAt: now,
    lastActivity: now,
  };

  const nextSessions: PersistedCliSession[] = [];
  let replaced = false;
  for (const session of state.sessions) {
    if (session.mode === 'tmux' && session.tmuxSessionName === sessionName) {
      nextSessions.push({
        ...session,
        lastActivity: now,
      });
      replaced = true;
      continue;
    }
    nextSessions.push(session);
  }
  if (!replaced) {
    nextSessions.push(nextRecord);
  }

  writeGlobalCliSessionState({
    sessions: nextSessions,
    updatedAt: now,
  });
}

function toSortableTs(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function compareTmuxRowsByCreation(a: TlsRow, b: TlsRow): number {
  const byCreatedAt = toSortableTs(a.createdAt) - toSortableTs(b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return a.name.localeCompare(b.name);
}

function readPersistedTmuxOrder(): Map<string, number> {
  try {
    const raw = fs.readFileSync(globalSessionStateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: unknown[] };
    const order = new Map<string, number>();
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    sessions.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const session = entry as { mode?: unknown; tmuxSessionName?: unknown };
      if (session.mode !== 'tmux') return;
      if (typeof session.tmuxSessionName !== 'string' || session.tmuxSessionName.trim().length === 0) return;
      if (!order.has(session.tmuxSessionName)) {
        order.set(session.tmuxSessionName, index);
      }
    });
    return order;
  } catch {
    return new Map();
  }
}

function compareTmuxRowsByPersistedOrder(order: Map<string, number>): (a: TlsRow, b: TlsRow) => number {
  return (a, b) => {
    const aRank = order.get(a.name) ?? Number.POSITIVE_INFINITY;
    const bRank = order.get(b.name) ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;
    return compareTmuxRowsByCreation(a, b);
  };
}

function getTmuxDisplayTitle(row: TlsRow): string {
  return row.friendlyName || row.label || row.name || '(unnamed)';
}

function getTmuxDisplaySubtitle(row: TlsRow): string | null {
  if (!row.friendlyName && !row.label) return null;
  return `tmux:${row.name}`;
}

function formatTmuxConnectionLabels(row: TlsRow): string[] {
  const labels: string[] = [];
  if (row.clientCount && row.clientCount !== '0') {
    labels.push(`Web clients ${row.clientCount}`);
  }
  if (row.attachedCount && row.attachedCount !== '0') {
    labels.push(`Native tmux ${row.attachedCount}`);
  }
  return labels;
}

function normalizeMatchText(value: string): string {
  return value.trim().toLowerCase();
}

function tmuxRowAliases(row: TlsRow): string[] {
  return [row.name, row.friendlyName, row.label]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function currentCwdTmuxRows(rows: TlsRow[]): TlsRow[] {
  const cwd = resolveInvocationCwd();
  return rows.filter((row) => row.cwd === cwd);
}

function resolveTmuxAttachTarget(input: string, candidates: TlsRow[]): {
  row: TlsRow | null;
  ambiguous: TlsRow[];
  suggestions: TlsRow[];
} {
  const query = normalizeMatchText(input);
  if (!query) return { row: null, ambiguous: [], suggestions: [] };

  if (input.trim() === '.') {
    const cwdMatches = currentCwdTmuxRows(candidates);
    if (cwdMatches.length === 1) {
      return { row: cwdMatches[0], ambiguous: [], suggestions: [] };
    }
    if (cwdMatches.length > 1) {
      return { row: null, ambiguous: cwdMatches, suggestions: [] };
    }
  }

  const exactMatches = candidates.filter((row) =>
    tmuxRowAliases(row).some((alias) => normalizeMatchText(alias) === query),
  );
  if (exactMatches.length === 1) {
    return { row: exactMatches[0], ambiguous: [], suggestions: [] };
  }
  if (exactMatches.length > 1) {
    return { row: null, ambiguous: exactMatches, suggestions: [] };
  }

  const partialMatches = candidates.filter((row) =>
    tmuxRowAliases(row).some((alias) => normalizeMatchText(alias).includes(query)),
  );
  if (partialMatches.length === 1) {
    return { row: partialMatches[0], ambiguous: [], suggestions: [] };
  }
  if (partialMatches.length > 1) {
    return { row: null, ambiguous: partialMatches, suggestions: [] };
  }

  return { row: null, ambiguous: [], suggestions: candidates.slice(0, 6) };
}

function buildAttachCandidates(rows: TlsRow[], includeAll: boolean): TlsRow[] {
  const managed = rows.filter((row) => row.version.length > 0);
  const selected = includeAll || managed.length === 0 ? rows : managed;
  const tmuxOrder = readPersistedTmuxOrder();
  return selected.slice().sort(compareTmuxRowsByPersistedOrder(tmuxOrder));
}

function renderBlocks(rows: TlsRow[]): string {
  const blocks: string[] = [];
  for (const row of rows) {
    const heading = getTmuxDisplayTitle(row);
    const subtitle = getTmuxDisplaySubtitle(row);
    const lines: string[] = [];
    lines.push(`${c.bold(c.cyan('●'))} ${c.bold(heading)}${subtitle ? `  ${c.dim(`(${subtitle})`)}` : ''}`);

    const kv: Array<[string, string]> = [];
    if (row.program) kv.push(['Program', row.program]);
    if (row.cwd) kv.push(['CWD', row.cwd]);
    const meta: string[] = [];
    meta.push(...formatTmuxConnectionLabels(row));
    meta.push(`idle=${formatIdle(row.lastActiveAt)}`);
    if (row.host) meta.push(`host=${row.host}`);
    if (row.version) meta.push(`v${row.version}`);
    kv.push(['Status', meta.join('  ')]);

    const keyWidth = Math.max(...kv.map(([k]) => k.length));
    for (const [k, v] of kv) {
      lines.push(`  ${c.dim(k.padEnd(keyWidth))}  ${v}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function renderCompactTmuxRows(rows: TlsRow[], indent = '  '): string {
  return rows.map((row) => {
    const title = getTmuxDisplayTitle(row);
    const subtitle = getTmuxDisplaySubtitle(row);
    const bits: string[] = [];
    if (row.cwd) bits.push(row.cwd);
    bits.push(...formatTmuxConnectionLabels(row));
    const suffix = bits.length > 0 ? c.dim(`  ${bits.join(' · ')}`) : '';
    return `${indent}${c.cyan(row.name)}${title !== row.name ? ` ${c.dim(`(${title})`)}` : ''}${subtitle && title === row.name ? ` ${c.dim(`(${subtitle})`)}` : ''}${suffix}`;
  }).join('\n');
}

// Fetch tmux sessions with termdock metadata. Returns null if tmux is not
// running (so callers can decide to print a friendly message and exit).
// Hard errors (tmux missing, query failure) `process.exit(1)` directly.
async function fetchTlsRows(): Promise<TlsRow[] | null> {
  let stdout: string;
  try {
    const result = await execFileAsync('tmux', ['list-sessions', '-F', TLS_FORMAT], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err?.code === 'ENOENT') {
      console.error(`${ICON.err} ${c.red('tmux is not installed or not on PATH.')}`);
      process.exit(1);
    }
    const stderr = (err?.stderr || '').toString().trim();
    if (stderr.includes('no server running') || stderr.includes('no current session')) {
      return null;
    }
    console.error(`${ICON.err} ${c.red('Failed to query tmux:')} ${stderr || (err?.message ?? String(err))}`);
    process.exit(1);
  }

  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cols = line.split('\t');
      const row = {} as TlsRow;
      TLS_FIELDS.forEach((field, idx) => {
        (row as unknown as Record<string, string>)[field] = cols[idx] ?? '';
      });
      return row;
    });
}

async function runTls(opts: { all: boolean; json: boolean }): Promise<void> {
  const allRows = await fetchTlsRows();
  if (allRows === null) {
    if (opts.json) {
      process.stdout.write('[]\n');
      return;
    }
    console.log(`${ICON.info} ${c.dim('No tmux server running on this host.')}`);
    return;
  }

  const tmuxOrder = readPersistedTmuxOrder();
  const rows = (opts.all ? allRows : allRows.filter((row) => row.version.length > 0))
    .slice()
    .sort(compareTmuxRowsByPersistedOrder(tmuxOrder));

  if (opts.json) {
    const json = rows.map((row) => ({
      sessionName: row.name,
      attachedCount: row.attachedCount ? Number(row.attachedCount) : null,
      friendlyName: row.friendlyName || null,
      program: row.program || null,
      cwd: row.cwd || null,
      label: row.label || null,
      clientCount: row.clientCount ? Number(row.clientCount) : null,
      host: row.host || null,
      pid: row.pid ? Number(row.pid) : null,
      version: row.version || null,
      createdAt: row.createdAt ? Number(row.createdAt) : null,
      lastActiveAt: row.lastActiveAt ? Number(row.lastActiveAt) : null,
    }));
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }

  if (rows.length === 0) {
    if (opts.all) {
      console.log(`${ICON.info} ${c.dim('No tmux sessions on this host.')}`);
    } else {
      console.log(`${ICON.info} ${c.dim('No termdock-managed tmux sessions on this host.')}`);
      console.log(`  ${c.dim('Use')} ${c.cyan('td la')} ${c.dim('to include all tmux sessions.')}`);
    }
    return;
  }

  console.log(renderBlocks(rows));
}

// ── end --tls ──

// ── `td --attach-tmux [name]` / `td a [name]` / `td at [name]` ──
//
// Attach to a termdock-managed tmux session. If `name` is provided, attach
// directly. Otherwise show an interactive picker that lists termdock sessions
// (with -a, all tmux sessions). Replaces the current process with `tmux
// attach -t <name>` so the user gets a normal tmux experience.

function execTmuxAttach(sessionName: string): never {
  // Use spawn with `stdio: 'inherit'` (not exec) so tmux owns the tty.
  // Don't `process.exit(0)` — wait for tmux to detach, then propagate code.
  const child = spawn('tmux', ['attach', '-t', sessionName], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the signal so the parent shell sees it.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on('error', (error) => {
    console.error(`${ICON.err} ${c.red('Failed to spawn tmux:')} ${getMessage(error)}`);
    process.exit(1);
  });
  // Make TypeScript happy — we never actually return.
  return undefined as never;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function pickTmuxSession(rows: TlsRow[]): Promise<string | null> {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const only = rows[0];
    console.log(`${ICON.info} ${c.dim('Only one session — attaching:')} ${c.cyan(only.name)}`);
    return only.name;
  }

  if (!process.stdin.isTTY) {
    console.error(`${ICON.err} ${c.red('No TTY — pass a session name explicitly: td --attach-tmux <name>')}`);
    return null;
  }

  console.log(c.bold('Select a tmux session to attach:'));
  const indexWidth = String(rows.length).length;
  const groups = buildTmuxFolderGroups(rows);
  const orderedRows = groups.flatMap((group) => group.sessions);
  let optionIndex = 0;
  for (const group of groups) {
    const groupTitle = group.key ? `${group.label} ${c.dim(`(${group.key})`)}` : `${group.label} ${c.dim('(no cwd)')}`;
    console.log(`  ${c.bold(groupTitle)}`);
    for (const row of group.sessions) {
      optionIndex += 1;
      const num = c.cyan(String(optionIndex).padStart(indexWidth));
      const heading = getTmuxDisplayTitle(row);
      const subtitle = getTmuxDisplaySubtitle(row);
      const meta: string[] = [];
      if (row.cwd) meta.push(row.cwd);
      meta.push(...formatTmuxConnectionLabels(row));
      const tail = meta.length > 0 ? c.dim(`  ${meta.join(' · ')}`) : '';
      console.log(`    ${num}. ${heading}${subtitle ? ` ${c.dim(`(${subtitle})`)}` : ''}${tail}`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Choice [1-${rows.length}, q to quit]: `, (input) => {
      rl.close();
      resolve(input.trim());
    });
  });

  if (!answer || answer.toLowerCase() === 'q') return null;
  const choice = Number(answer);
  if (!Number.isInteger(choice) || choice < 1 || choice > orderedRows.length) {
    console.error(`${ICON.err} ${c.red(`Invalid choice: ${answer}`)}`);
    return null;
  }
  return orderedRows[choice - 1]?.name ?? null;
}

async function runAttachTmux(opts: { name?: string; all?: boolean }): Promise<void> {
  const allRows = await fetchTlsRows();
  if (allRows === null) {
    console.log(`${ICON.info} ${c.dim('No tmux server running on this host.')}`);
    process.exit(0);
  }

  const candidates = buildAttachCandidates(allRows, opts.all === true);

  // Direct attach when caller already knows the name.
  if (opts.name) {
    const exactRaw = allRows.find((row) => row.name === opts.name);
    const target = exactRaw ?? resolveTmuxAttachTarget(opts.name, candidates).row;
    if (!target) {
      const resolved = resolveTmuxAttachTarget(opts.name, candidates);
      if (resolved.ambiguous.length > 0) {
        console.error(`${ICON.err} ${c.red(`Ambiguous tmux session: ${opts.name}`)}`);
        console.error(renderCompactTmuxRows(resolved.ambiguous));
        console.error(`  ${c.dim('Use the raw tmux session name, or run')} ${c.cyan(opts.all ? 'td a --all' : 'td a')} ${c.dim('for the picker.')}`);
        process.exit(1);
      }
      console.error(`${ICON.err} ${c.red(`No matching tmux session: ${opts.name}`)}`);
      if (!opts.all && allRows.some((row) => row.version.length === 0)) {
        console.error(`  ${c.dim('Use')} ${c.cyan('td a --all')} ${c.dim('to include unmanaged tmux sessions.')}`);
      }
      const suggestions = resolved.suggestions.length > 0 ? resolved.suggestions : candidates.slice(0, 6);
      if (suggestions.length > 0) {
        console.error(`  ${c.dim('Available sessions:')}`);
        console.error(renderCompactTmuxRows(suggestions, '    '));
      }
      process.exit(1);
    }
    await ensureTmuxFocusEvents();
    if (target.version.length > 0) {
      registerGuiTmuxSession(target.name);
    }
    execTmuxAttach(target.name);
    return;
  }

  if (candidates.length === 0) {
    console.log(`${ICON.info} ${c.dim(opts.all ? 'No tmux sessions on this host.' : 'No termdock-managed tmux sessions on this host.')}`);
    if (!opts.all) {
      console.log(`  ${c.dim('Use')} ${c.cyan('td a --all')} ${c.dim('to include unmanaged tmux sessions.')}`);
    }
    process.exit(0);
  }

  const picked = await pickTmuxSession(candidates);
  if (!picked) {
    console.log(`${ICON.info} ${c.dim('Cancelled.')}`);
    process.exit(0);
  }

  await ensureTmuxFocusEvents();
  const pickedRow = candidates.find((row) => row.name === picked);
  if (pickedRow?.version) {
    registerGuiTmuxSession(pickedRow.name);
  }
  execTmuxAttach(picked);
}

async function runNewTmux(opts: { name?: string; attach?: boolean }): Promise<void> {
  const sessionName = normalizeTmuxSessionName(opts.name);
  const cwd = resolveInvocationCwd();
  const result = await ensureStampedTmuxSession(sessionName, cwd);
  registerGuiTmuxSession(result.sessionName);
  const verb = result.created ? 'Created' : 'Reused';
  console.log(`${ICON.ok} ${c.green(`${verb} tmux session:`)} ${c.cyan(result.sessionName)}`);
  if (result.created) {
    console.log(`  ${c.dim('Directory:')} ${c.cyan(cwd)}`);
  }
  if (opts.attach === false) {
    console.log(`  ${c.dim('Tip: attach with')} ${c.cyan(`td --attach-tmux ${result.sessionName}`)}`);
    return;
  }
  console.log(`${ICON.info} ${c.dim('Attaching...')}`);
  execTmuxAttach(result.sessionName);
}

// ── end --attach-tmux / --new-tmux ──

async function promptLine(prompt: string): Promise<string> {
  if (!(process.stdin as NodeJS.ReadStream).isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runFirstRunWizard(): Promise<void> {
  if (!(process.stdin as NodeJS.ReadStream).isTTY || isFirstRunCompleted()) return;
  console.log(`${ICON.info} ${c.bold('Termdock first-time local access setup')}`);
  const prefix = await promptLine('  Choose your .termdock.local prefix (e.g. jovn): ');
  const normalized = normalizeLocalAccessName(prefix);
  if (normalized) {
    setLocalAccessSetting({ name: normalized, source: 'manual' });
    console.log(`  ${ICON.ok} ${c.dim('Local URL prefix:')} ${c.cyan(`${normalized}.termdock.local`)}`);
  } else {
    console.log(`  ${ICON.warn} ${c.yellow('No valid prefix entered; using generated default for now.')}`);
  }

    const enableHttps = (await promptLine('  Enable HTTPS automatically now? [Y/n] ')).toLowerCase();
  if (enableHttps !== 'n' && enableHttps !== 'no') {
    try {
      await runSetupLocalHttps();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      console.log(`  ${ICON.info} ${c.dim('You can enable HTTPS later with:')} ${c.cyan('td --setup-local-https')}`);
    }
  } else {
    console.log(`  ${ICON.info} ${c.dim('You can enable HTTPS later with:')} ${c.cyan('td --setup-local-https')}`);
  }
  markFirstRunCompleted();
  console.log('');
}

async function waitForServerMetadata(result: StartServerResult, fallbackPort: number): Promise<{ lanUrl?: string; onboardingUrl?: string | null; status?: string; reason?: string | null }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = result.getLocalAccessState();
    const onboardingUrl = result.getOnboardingUrl() ?? state.onboardingUrl;
    if (state.status !== 'disabled' || state.reason !== 'Local access has not started yet.') {
      return {
        lanUrl: state.url,
        onboardingUrl,
        status: state.status,
        reason: state.reason,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = result.getLocalAccessState();
  return {
    lanUrl: state.url || undefined,
    onboardingUrl: result.getOnboardingUrl() ?? state.onboardingUrl,
    status: state.status,
    reason: state.reason ?? `Metadata still initializing on port ${fallbackPort}.`,
  };
}

async function refreshDefaultHttpsCertificateSafely(): Promise<boolean> {
  try {
    return await ensureDefaultHttpsCertificateFresh();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return false;
  }
}

async function main(): Promise<void> {
  if (options.setupLocalHttps) {
    try {
      await runSetupLocalHttps();
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  if (options.tls) {
    await runTls({ all: options.tlsAll, json: options.tlsJson });
    process.exit(0);
  }

  if (options.newTmux) {
    await runNewTmux({ name: options.newTmuxName, attach: options.newTmuxAttach });
    return; // execTmuxAttach handles process exit when attach=true
  }

  if (options.attachTmux) {
    await runAttachTmux({ name: options.attachTmuxName, all: options.tlsAll });
    return; // execTmuxAttach handles process exit
  }

  if (options.injectChangeAudit) {
    await runInjectChangeAudit(options.injectChangeAudit);
    process.exit(0);
  }

  if (options.injectBranchAudit) {
    await runInjectBranchAudit(options.injectBranchAudit);
    process.exit(0);
  }

  if (options.branchAuditExport) {
    await runBranchAuditExport(options.branchAuditExport);
    process.exit(0);
  }

  if (options.changeAuditList) {
    await runChangeAuditList(options.changeAuditList);
    process.exit(0);
  }

  if (options.changeAuditExport) {
    await runChangeAuditExport(options.changeAuditExport);
    process.exit(0);
  }

  if (options.changeAuditShow) {
    await runChangeAuditShow(options.changeAuditShow);
    process.exit(0);
  }

  if (options.injectChangeAuditHunk) {
    await runInjectChangeAuditHunk(options.injectChangeAuditHunk);
    process.exit(0);
  }

  if (options.setPassword) {
    await runSetPassword();
    process.exit(0);
  }

  if (options.clearPassword) {
    runClearPassword();
    process.exit(0);
  }

  const localApiToken = getOrCreateLocalApiToken();
  const https = resolveHttpsOptions(options);
  const isManagedDefaultHttps = Boolean(https.cert === defaultHttpsCertPath && https.key === defaultHttpsKeyPath);

  if (options.status) {
    const runningState = getRunningState();
    if (!runningState) {
      console.log(`${ICON.info} ${c.dim('Termdock is not running.')}`);
      process.exit(0);
    }

    printRunningState(runningState);
    process.exit(0);
  }

  if (options.stop) {
    const runningState = getRunningState();
    if (!runningState) {
      console.log(`${ICON.info} ${c.dim('Termdock is not running.')}`);
      process.exit(0);
    }

    const bridgeCaffeinateStarted = startRestartBridgeCaffeinate();
    process.kill(runningState.pid, 'SIGTERM');
    removeStateFile();
    console.log(`${ICON.ok} ${c.green(`Stopped Termdock (PID ${runningState.pid}).`)}`);
    if (bridgeCaffeinateStarted) {
      console.log(`${ICON.info} ${c.dim(`Keeping macOS awake for up to ${restartBridgeCaffeinateSeconds}s while Termdock restarts.`)}`);
    }
    process.exit(0);
  }

  if (options.foreground) {
    // Boot check (marker prevents re-run if parent already completed)
    runBootChecks();
    warnIfAuthDisabled(options.host ?? DEFAULT_HOST);
    // Dynamic import keeps terminal.ts side-effects (loadClientStatesFromDisk
    // etc.) out of fast paths like `termdock --tls` / `--status`.
    const { startServer } = await import('./entry.js');
    const result = startServer({
      host: options.host,
      port: options.port,
      httpsCertPath: https.cert,
      httpsKeyPath: https.key,
      httpsCaPath: https.ca,
      localApiToken,
      onCertificateRefreshNeeded: isManagedDefaultHttps
        ? async (): Promise<CertificateRefreshResult> => {
            console.log(`${ICON.info} ${c.dim('Termdock detected network/certificate changes; regenerating certificate and reloading TLS context...')}`);
            const refreshed = await refreshDefaultHttpsCertificateSafely();
            if (!refreshed) return { reloaded: false };
            const state = await localAccessManager.start({
              host: options.host ?? DEFAULT_HOST,
              port: options.port ?? PORT.backend,
              scheme: result.scheme,
              caCertPath: https.ca,
              onboardingPort: options.port ?? PORT.backend,
            });
            writeState({
              pid: process.pid,
              host: options.host ?? DEFAULT_HOST,
              port: options.port ?? PORT.backend,
              scheme: result.scheme,
              localUrl: `${result.scheme}://${(options.host ?? DEFAULT_HOST) === '0.0.0.0' ? 'localhost' : (options.host ?? DEFAULT_HOST)}:${options.port ?? PORT.backend}`,
              lanUrl: state.url,
              onboardingUrl: result.getOnboardingUrl(),
              localAccessStatus: state.status,
              localAccessReason: state.reason,
              logFile: logFilePath,
              startedAt: new Date().toISOString(),
              localApiToken,
            });
            return { reloaded: false, localAccessState: state };
          }
        : () => {
            console.warn('[cert-watch] certificate is missing current domain/IP SANs; restart Termdock with an updated certificate.');
            return { reloaded: false };
          },
    });
    result.server.on('close', () => {
      const runningState = readState();
      if (runningState?.pid === process.pid) {
        removeStateFile();
      }
    });
    const metadata = await waitForServerMetadata(result, options.port ?? PORT.backend);
    writeState({
      pid: process.pid,
      host: options.host ?? DEFAULT_HOST,
      port: options.port ?? PORT.backend,
      scheme: result.scheme,
      localUrl: `${result.scheme}://${(options.host ?? DEFAULT_HOST) === '0.0.0.0' ? 'localhost' : (options.host ?? DEFAULT_HOST)}:${options.port ?? PORT.backend}`,
      lanUrl: metadata.lanUrl,
      onboardingUrl: metadata.onboardingUrl,
      localAccessStatus: metadata.status,
      localAccessReason: metadata.reason,
      logFile: logFilePath,
      startedAt: new Date().toISOString(),
      localApiToken,
    });
    return;
  }

  const runningState = getRunningState();
  if (runningState) {
    printRunningState(runningState);
    process.exit(0);
  }

  // —— Boot check: 确保原生模块和系统依赖可用 ——
  const bootChecks = runBootChecks();
  if (!bootChecks.nodePty.ok || !bootChecks.tmux.ok) {
    console.log(c.dim("Boot checks:"));
    for (const line of formatBootCheckReport(bootChecks, colorsEnabled)) {
      console.log(line);
    }
    console.log("");
  }

  await runFirstRunWizard();

  // HTTPS certs are only generated when user explicitly runs --setup-local-https
  const refreshedHttps = resolveHttpsOptions(options);
  const activeHttps = refreshedHttps;

  ensureStateDir();
  const childArgs = [path.resolve(process.argv[1]), '--foreground'];
  const childHost = options.host ?? DEFAULT_HOST;
  const childPort = options.port ?? PORT.backend;

  if (options.host) {
    childArgs.push('--host', options.host);
  }

  if (options.port) {
    childArgs.push('--port', String(options.port));
  }

  if (activeHttps.cert) {
    childArgs.push('--https-cert', activeHttps.cert);
  }

  if (activeHttps.key) {
    childArgs.push('--https-key', activeHttps.key);
  }

  if (activeHttps.ca) {
    childArgs.push('--https-ca', activeHttps.ca);
  }

  const scheme = activeHttps.cert && activeHttps.key ? 'https' : 'http';
  const localAccessReason = activeHttps.source === 'default'
    ? 'Using local HTTPS certificates from ~/.termdock/certs.'
    : null;

  const logFileFd = fs.openSync(logFilePath, 'a');
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFileFd, logFileFd],
  });
  fs.closeSync(logFileFd);
  child.unref();

  writeState(buildServerState({
    pid: child.pid!,
    host: childHost,
    port: childPort,
    scheme,
    localAccessReason,
    localApiToken,
  }));

  console.log(`${ICON.ok} ${c.green('Termdock started in background.')}`);
  console.log(`  ${c.dim('URL:')} ${c.cyan(`${scheme}://${childHost === '0.0.0.0' ? 'localhost' : childHost}:${childPort}`)}`);
  if (scheme === 'https') {
    console.log(`  ${c.dim('HTTPS:')} ${activeHttps.source === 'default' ? c.green('auto') : c.green('enabled')}`);
  } else {
    console.log(`  ${c.dim('HTTPS:')} ${c.dim('not configured — run td --setup-local-https')}`);
  }
  console.log(`  ${c.dim('PID:')} ${child.pid}`);
  console.log(`  ${c.dim('Log:')} ${logFilePath}`);
  warnIfAuthDisabled(childHost);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
