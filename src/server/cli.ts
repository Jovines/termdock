#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { PORT, DEFAULT_HOST } from './config.js';
import {
  clearAuthFile,
  destroyAllSessions,
  hashPassword,
  isAuthEnabled,
  writeAuthFile,
} from './utils/authProtection.js';

const execFileAsync = promisify(execFile);

const stateDir = path.join(os.homedir(), '.termdock');
const stateFilePath = path.join(stateDir, 'server.json');
const logFilePath = path.join(stateDir, 'server.log');

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
}

interface ServerState {
  pid: number;
  host: string;
  port: number;
  logFile: string;
  startedAt: string;
}

function printHelp() {
  console.log(`Usage: termdock [options]

Options:
  --host <host>      Host to bind to (default: ${DEFAULT_HOST})
  --port <port>      Port to listen on (default: ${PORT.backend})
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
  -h, --help         Show this help message

Password examples:
  ${c.dim('# Set password interactively (recommended)')}
  termdock --set-password

  ${c.dim('# Pipe a password from stdin (CI / scripted setup)')}
  echo "my-secret" | termdock --set-password

  ${c.dim('# Disable authentication entirely')}
  termdock --clear-password

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

function printRunningState(state: ServerState) {
  const displayHost = state.host === '0.0.0.0' ? 'localhost' : state.host;
  const authLine = isAuthEnabled()
    ? `${c.green('enabled')} ${c.dim('(password required)')}`
    : `${c.red('disabled')} ${c.dim('(no password — anyone on the LAN can connect)')}`;
  console.log(`${ICON.ok} ${c.green('Termdock is running in background.')}`);
  console.log(`  ${c.dim('PID:')}  ${state.pid}`);
  console.log(`  ${c.dim('URL:')}  ${c.cyan(`http://${displayHost}:${state.port}`)}`);
  console.log(`  ${c.dim('Log:')}  ${state.logFile}`);
  console.log(`  ${c.dim('Auth:')} ${authLine}`);
}

function parseArgs(argv: string[]): CliOptions {
  let host: string | undefined;
  let port: number | undefined;
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

  // Allow `termdock tls` as shorthand for `termdock --tls`. Only honour the
  // bare token when it's the first argument so we don't accidentally swallow
  // a literal value somewhere down the line.
  if (argv[0] === 'tls') {
    tls = true;
    argv = argv.slice(1);
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

    console.error(`${ICON.err} ${c.red(`Unknown argument: ${arg}`)}`);
    printHelp();
    process.exit(1);
  }

  return { host, port, foreground, status, stop, setPassword, clearPassword, tls, tlsAll, tlsJson, attachTmux, attachTmuxName };
}

// Reads a single line from stdin without echoing keystrokes. Used for password
// entry. Falls back to plain readline (with echo) if stdin is not a TTY, e.g.
// when piping a password in via `echo ... | termdock --set-password`.
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
    console.log(`     ${c.cyan('termdock --stop && termdock')}`);
  } else {
    console.log('');
    console.log(`${ICON.info} ${c.dim('Start Termdock with:')} ${c.cyan('termdock')}`);
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
  console.log(`  ${c.dim('Re-enable auth at any time with:')} ${c.cyan('termdock --set-password')}`);

  const running = getRunningState();
  if (running) {
    console.log('');
    console.log(`${ICON.info} ${c.yellow('Termdock is currently running — restart it so the change takes effect:')}`);
    console.log(`     ${c.cyan('termdock --stop && termdock')}`);
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
  console.log(c.yellow('  │   ') + c.dim('Set a password with: ') + c.cyan('termdock --set-password')
    + c.yellow('             │'));
  console.log(c.yellow('  ╰─────────────────────────────────────────────────────────────╯'));
  console.log('');
}

// ── `termdock --tls` (a.k.a `termdock tls`) ──
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

  const rows = opts.all ? allRows : allRows.filter((row) => row.version.length > 0);

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
      console.log(`  ${c.dim('Use')} ${c.cyan('termdock --tls -a')} ${c.dim('to include all tmux sessions.')}`);
    }
    return;
  }

  console.log(renderBlocks(rows));
}

// ── end --tls ──

// ── `termdock --attach-tmux [name]` ──
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
    console.error(`${ICON.err} ${c.red('No TTY — pass a session name explicitly: termdock --attach-tmux <name>')}`);
    return null;
  }

  console.log(c.bold('Select a tmux session to attach:'));
  const indexWidth = String(rows.length).length;
  rows.forEach((row, idx) => {
    const num = c.cyan(String(idx + 1).padStart(indexWidth));
    const heading = row.label || row.friendlyName || row.name;
    const meta: string[] = [];
    if (row.cwd) meta.push(row.cwd);
    if (row.clientCount && row.clientCount !== '0') meta.push(`${row.clientCount} client(s)`);
    const tail = meta.length > 0 ? c.dim(`  ${meta.join(' · ')}`) : '';
    console.log(`  ${num}. ${heading} ${c.dim(`(${row.name})`)}${tail}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Choice [1-${rows.length}, q to quit]: `, (input) => {
      rl.close();
      resolve(input.trim());
    });
  });

  if (!answer || answer.toLowerCase() === 'q') return null;
  const choice = Number(answer);
  if (!Number.isInteger(choice) || choice < 1 || choice > rows.length) {
    console.error(`${ICON.err} ${c.red(`Invalid choice: ${answer}`)}`);
    return null;
  }
  return rows[choice - 1].name;
}

async function runAttachTmux(opts: { name?: string }): Promise<void> {
  // Direct attach when caller already knows the name.
  if (opts.name) {
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
  const candidates = managed.length > 0 ? managed : allRows;

  if (candidates.length === 0) {
    console.log(`${ICON.info} ${c.dim('No tmux sessions on this host.')}`);
    process.exit(0);
  }

  const picked = await pickTmuxSession(candidates);
  if (!picked) {
    console.log(`${ICON.info} ${c.dim('Cancelled.')}`);
    process.exit(0);
  }

  execTmuxAttach(picked);
}

// ── end --attach-tmux ──

async function main(): Promise<void> {
  if (options.tls) {
    await runTls({ all: options.tlsAll, json: options.tlsJson });
    process.exit(0);
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
    const server = startServer({ host: options.host, port: options.port });
    server.on('close', () => {
      const runningState = readState();
      if (runningState?.pid === process.pid) {
        removeStateFile();
      }
    });
    return;
  }

  const runningState = getRunningState();
  if (runningState) {
    printRunningState(runningState);
    process.exit(0);
  }

  ensureStateDir();
  const logFileFd = fs.openSync(logFilePath, 'a');
  const childArgs = [path.resolve(process.argv[1]), '--foreground'];
  const childHost = options.host ?? DEFAULT_HOST;
  const childPort = options.port ?? PORT.backend;

  if (options.host) {
    childArgs.push('--host', options.host);
  }

  if (options.port) {
    childArgs.push('--port', String(options.port));
  }

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFileFd, logFileFd],
  });

  child.unref();
  fs.closeSync(logFileFd);

  writeState({
    pid: child.pid!,
    host: childHost,
    port: childPort,
    logFile: logFilePath,
    startedAt: new Date().toISOString(),
  });

  console.log(`${ICON.ok} ${c.green('Termdock started in background.')}`);
  console.log(`  ${c.dim('URL:')} ${c.cyan(`http://${childHost === '0.0.0.0' ? 'localhost' : childHost}:${childPort}`)}`);
  console.log(`  ${c.dim('PID:')} ${child.pid}`);
  console.log(`  ${c.dim('Log:')} ${logFilePath}`);
  warnIfAuthDisabled(childHost);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
