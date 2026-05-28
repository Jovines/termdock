#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { Writable } from 'stream';
import { startServer } from './entry.js';
import { PORT, DEFAULT_HOST } from './config.js';
import {
  clearAuthFile,
  destroyAllSessions,
  hashPassword,
  isAuthEnabled,
  writeAuthFile,
} from './utils/authProtection.js';

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

    console.error(`${ICON.err} ${c.red(`Unknown argument: ${arg}`)}`);
    printHelp();
    process.exit(1);
  }

  return { host, port, foreground, status, stop, setPassword, clearPassword };
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

async function main(): Promise<void> {
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
