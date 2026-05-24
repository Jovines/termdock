#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { startServer } from './entry.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 9834;
const stateDir = path.join(os.homedir(), '.termdock');
const stateFilePath = path.join(stateDir, 'server.json');
const logFilePath = path.join(stateDir, 'server.log');

interface CliOptions {
  host?: string;
  port?: number;
  foreground: boolean;
  status: boolean;
  stop: boolean;
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
  --host <host>    Host to bind to (default: ${DEFAULT_HOST})
  --port <port>    Port to listen on (default: ${DEFAULT_PORT})
  --foreground     Run in the foreground
  --status         Show background server status
  --stop           Stop the background server
  -h, --help       Show this help message`);
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
  console.log(`Termdock is running in background.`);
  console.log(`PID: ${state.pid}`);
  console.log(`URL: http://${state.host}:${state.port}`);
  console.log(`Log: ${state.logFile}`);
}

function parseArgs(argv: string[]): CliOptions {
  let host: string | undefined;
  let port: number | undefined;
  let foreground = false;
  let status = false;
  let stop = false;

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
        console.error(`Invalid port: ${nextValue ?? ''}`);
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

    console.error(`Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  return { host, port, foreground, status, stop };
}

const options = parseArgs(process.argv.slice(2));

if (options.status) {
  const runningState = getRunningState();
  if (!runningState) {
    console.log('Termdock is not running.');
    process.exit(0);
  }

  printRunningState(runningState);
  process.exit(0);
}

if (options.stop) {
  const runningState = getRunningState();
  if (!runningState) {
    console.log('Termdock is not running.');
    process.exit(0);
  }

  process.kill(runningState.pid, 'SIGTERM');
  removeStateFile();
  console.log(`Stopped Termdock (PID ${runningState.pid}).`);
  process.exit(0);
}

if (options.foreground) {
  const server = startServer({ host: options.host, port: options.port });
  server.on('close', () => {
    const runningState = readState();
    if (runningState?.pid === process.pid) {
      removeStateFile();
    }
  });
} else {
  const runningState = getRunningState();
  if (runningState) {
    printRunningState(runningState);
    process.exit(0);
  }

  ensureStateDir();
  const logFileFd = fs.openSync(logFilePath, 'a');
  const childArgs = [path.resolve(process.argv[1]), '--foreground'];
  const childHost = options.host ?? DEFAULT_HOST;
  const childPort = options.port ?? DEFAULT_PORT;

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

  console.log('Termdock started in background.');
  console.log(`URL: http://${childHost}:${childPort}`);
  console.log(`PID: ${child.pid}`);
  console.log(`Log: ${logFilePath}`);
}
