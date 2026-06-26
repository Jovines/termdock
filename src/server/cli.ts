#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { randomUUID } from 'crypto';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { createRequire } from 'module';
import { PORT, DEFAULT_HOST } from './config.js';
import { isFirstRunCompleted, markFirstRunCompleted, normalizeLocalAccessName, setLocalAccessSetting, getLocalAccessSetting } from './utils/settings.js';
import { localAccessManager, getLanIPv4Addresses } from './utils/localAccess.js';
import type { CertificateRefreshResult, StartServerResult } from './entry.js';
import {
  clearAuthFile,
  destroyAllSessions,
  hashPassword,
  isAuthEnabled,
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

const stateDir = path.join(os.homedir(), '.termdock');
const stateFilePath = path.join(stateDir, 'server.json');
const logFilePath = path.join(stateDir, 'server.log');
const globalSessionStateFilePath = path.join(stateDir, 'global-session-state.json');
const certDir = path.join(stateDir, 'certs');
const defaultHttpsCertPath = path.join(certDir, 'termdock-local.pem');
const defaultHttpsKeyPath = path.join(certDir, 'termdock-local-key.pem');
const defaultHttpsCaPath = path.join(certDir, 'rootCA.pem');

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
  -a, --all          With --tls: include tmux sessions not stamped by termdock
  --json             With --tls: emit JSON instead of a table
  --attach-tmux [n]  Attach to a termdock-managed tmux session.
                     With no name: interactive picker.
                     With name: attach directly (e.g. --attach-tmux wt-foo).
  --new-tmux [name]  Create (or ensure) and attach to a tmux session for termdock.
                     New sessions start in the directory where td was invoked.
                     With no name: auto-generate a wt-* name and enter it directly.
                     Use --tls to inspect sessions without attaching.
  --new-tmux-detached [name]
                     Create (or ensure) a tmux session and leave it detached.
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

function buildServerState(params: {
  pid: number;
  host: string;
  port: number;
  scheme: 'http' | 'https';
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

  console.log(`${ICON.ok} ${c.green('Password cleared. Authentication is now disabled.')}`);
  console.log(`  ${c.dim('All existing sessions have been invalidated.')}`);
  console.log('');
  console.log(`${ICON.warn} ${c.yellow('Warning:')} ${c.dim('the server is now reachable by anyone who can reach the host/port.')}`);
  console.log(`  ${c.dim('Re-enable auth at any time with:')} ${c.cyan('td --set-password')}`);

  const running = getRunningState();
  if (running) {
    console.log('');
    console.log(`${ICON.info} ${c.yellow('Termdock is currently running — restart it so the change takes effect:')}`);
    console.log(`     ${c.cyan('td --stop && td')}`);
  }
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

async function ensureTmuxCliSessionOptions(sessionName: string): Promise<void> {
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'status', 'off'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'mouse', 'on'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
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
    const args = ['new-session', '-d', '-s', sessionName];
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

function renderBlocks(rows: TlsRow[]): string {
  const blocks: string[] = [];
  for (const row of rows) {
    const heading = row.label || row.friendlyName || row.name || '(unnamed)';
    const lines: string[] = [];
    lines.push(`${c.bold(c.cyan('●'))} ${c.bold(heading)}  ${c.dim(`(${row.name})`)}`);

    const kv: Array<[string, string]> = [];
    if (row.program) kv.push(['Program', row.program]);
    if (row.cwd) kv.push(['CWD', row.cwd]);
    const meta: string[] = [];
    meta.push(`clients=${row.clientCount || '0'}`);
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
      const heading = row.label || row.friendlyName || row.name;
      const meta: string[] = [];
      if (row.cwd) meta.push(row.cwd);
      if (row.clientCount && row.clientCount !== '0') meta.push(`${row.clientCount} client(s)`);
      const tail = meta.length > 0 ? c.dim(`  ${meta.join(' · ')}`) : '';
      console.log(`    ${num}. ${heading} ${c.dim(`(${row.name})`)}${tail}`);
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

async function runAttachTmux(opts: { name?: string }): Promise<void> {
  // Direct attach when caller already knows the name.
  if (opts.name) {
    await ensureTmuxFocusEvents();
    execTmuxAttach(opts.name);
    return;
  }

  const allRows = await fetchTlsRows();
  if (allRows === null) {
    console.log(`${ICON.info} ${c.dim('No tmux server running on this host.')}`);
    process.exit(0);
  }

  // Prefer termdock-managed sessions; fall back to all tmux sessions if
  // none are stamped (better than refusing to attach).
  const managed = allRows.filter((row) => row.version.length > 0);
  const tmuxOrder = readPersistedTmuxOrder();
  const candidates = (managed.length > 0 ? managed : allRows)
    .slice()
    .sort(compareTmuxRowsByPersistedOrder(tmuxOrder));

  if (candidates.length === 0) {
    console.log(`${ICON.info} ${c.dim('No tmux sessions on this host.')}`);
    process.exit(0);
  }

  const picked = await pickTmuxSession(candidates);
  if (!picked) {
    console.log(`${ICON.info} ${c.dim('Cancelled.')}`);
    process.exit(0);
  }

  await ensureTmuxFocusEvents();
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
    await runAttachTmux({ name: options.attachTmuxName });
    return; // execTmuxAttach handles process exit
  }

  if (options.setPassword) {
    await runSetPassword();
    process.exit(0);
  }

  if (options.clearPassword) {
    runClearPassword();
    process.exit(0);
  }

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

    process.kill(runningState.pid, 'SIGTERM');
    removeStateFile();
    console.log(`${ICON.ok} ${c.green(`Stopped Termdock (PID ${runningState.pid}).`)}`);
    process.exit(0);
  }

  if (options.foreground) {
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
    });
    return;
  }

  const runningState = getRunningState();
  if (runningState) {
    printRunningState(runningState);
    process.exit(0);
  }

  await runFirstRunWizard();

  await refreshDefaultHttpsCertificateSafely();
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
