import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const router: express.Router = express.Router();
const execFileAsync = promisify(execFile);

type TerminalMode = 'shell' | 'tmux';

interface TmuxPane {
  id: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  top: number;
  left: number;
  command: string;
  title: string;
}

interface TmuxWindow {
  id: string;
  name: string;
  index: number;
  active: boolean;
  panes: TmuxPane[];
}

interface TmuxLayout {
  sessionId: string;
  sessionName: string;
  windows: TmuxWindow[];
  activeWindowId: string;
  activePaneId: string;
  inCopyMode: boolean;
}

// PTY backend abstraction
interface PtyProvider {
  spawn(
    shell: string,
    args: string[],
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    }
  ): PtyProcess;
  backend: string;
}

interface PtyProcess {
  onData(handler: (data: string) => void): { dispose: () => void };
  onExit(handler: (event: { exitCode: number; signal: number | null }) => void): { dispose: () => void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause?(): void;
  resume?(): void;
  pid?: number;
}

interface TerminalSession {
  ptyProcess: PtyProcess;
  ptyBackend: string;
  cwd: string;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  lastActivity: number;
  clients: Map<string, express.Response>;
  createdAt: number;
  shouldPersist: boolean;
  keepAliveMs: number | null;
  lastDetachedAt: number | null;
  hasWrittenData: boolean;
  activeProgram: {
    command: string | null;
    source: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown';
    updatedAt: number;
  } | null;
  dataDisposable?: { dispose: () => void };
  exitDisposable?: { dispose: () => void };
}

interface PersistedClientSession {
  sessionId: string;
  name: string;
  backendSessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
  createdAt: number;
  lastActivity: number;
}

interface ClientTerminalState {
  sessions: PersistedClientSession[];
  activeSessionId: string | null;
  updatedAt: number;
}

const terminalSessions = new Map<string, TerminalSession>();
const clientTerminalStates = new Map<string, ClientTerminalState>();
const MAX_TERMINAL_SESSIONS = parseInt(process.env.MAX_TERMINAL_SESSIONS || '20', 10);

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '300000' : '1800000'), 10);
const CLEANUP_INTERVAL = isDevelopment ? 60 * 1000 : 5 * 60 * 1000;
const DEFAULT_KEEP_ALIVE_MS = parseInt(process.env.TERMINAL_DEFAULT_KEEPALIVE_MS || String(3 * 60 * 60 * 1000), 10);
const RECONNECT_SCROLLBACK = parseInt(process.env.TERMINAL_RECONNECT_SCROLLBACK || '200', 10);
const TMUX_POLL_INTERVAL = parseInt(process.env.TMUX_POLL_INTERVAL || '500', 10);
const ACTIVE_PROGRAM_POLL_INTERVAL = parseInt(process.env.TERMINAL_ACTIVE_PROGRAM_POLL_INTERVAL || '1200', 10);
const TMUX_DELIMITER = '\x1f';
// 输出历史缓冲区（限制大小）
const MAX_HISTORY_SIZE = 100 * 1024; // 100KB per session
const sessionHistory = new Map<string, { chunks: string[]; size: number }>();

function addToHistory(sessionId: string, data: string): void {
  const history = sessionHistory.get(sessionId);
  if (!history) {
    sessionHistory.set(sessionId, { chunks: [data], size: data.length });
    return;
  }

  history.chunks.push(data);
  history.size += data.length;

  // 超出限制时移除最旧的 chunk
  while (history.size > MAX_HISTORY_SIZE && history.chunks.length > 0) {
    const removed = history.chunks.shift();
    if (removed) {
      history.size -= removed.length;
    }
  }
}

function getHistory(sessionId: string): string[] {
  const history = sessionHistory.get(sessionId);
  return history ? [...history.chunks] : [];
}

function clearHistory(sessionId: string): void {
  sessionHistory.delete(sessionId);
}

function getReconnectionHistory(sessionId: string): string[] {
  const history = getHistory(sessionId);
  if (RECONNECT_SCROLLBACK <= 0 || history.length <= RECONNECT_SCROLLBACK) {
    return history;
  }
  return history.slice(-RECONNECT_SCROLLBACK);
}

function normalizeKeepAliveMs(input: unknown): number | null {
  if (input === null) {
    return null;
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_KEEP_ALIVE_MS;
  }

  if (input < 1000) {
    return 1000;
  }

  return Math.floor(input);
}

function normalizeMode(input: unknown): TerminalMode {
  return input === 'tmux' ? 'tmux' : 'shell';
}

function normalizePersistedClientSession(input: unknown): PersistedClientSession | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<PersistedClientSession>;
  if (typeof candidate.sessionId !== 'string' || typeof candidate.name !== 'string') {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    name: candidate.name,
    backendSessionId: typeof candidate.backendSessionId === 'string' && candidate.backendSessionId.trim().length > 0
      ? candidate.backendSessionId
      : null,
    mode: normalizeMode(candidate.mode),
    tmuxSessionName: typeof candidate.tmuxSessionName === 'string' && candidate.tmuxSessionName.trim().length > 0
      ? candidate.tmuxSessionName
      : null,
    keepAliveMs: normalizeKeepAliveMs(candidate.keepAliveMs),
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? Math.floor(candidate.createdAt)
      : Date.now(),
    lastActivity: typeof candidate.lastActivity === 'number' && Number.isFinite(candidate.lastActivity)
      ? Math.floor(candidate.lastActivity)
      : Date.now(),
  };
}

function normalizeClientTerminalState(input: unknown): ClientTerminalState {
  if (!input || typeof input !== 'object') {
    return { sessions: [], activeSessionId: null, updatedAt: Date.now() };
  }

  const candidate = input as Partial<ClientTerminalState> & { sessions?: unknown[] };
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
      .map((session) => normalizePersistedClientSession(session))
      .filter((session): session is PersistedClientSession => session !== null)
    : [];
  const activeSessionId = typeof candidate.activeSessionId === 'string' && candidate.activeSessionId.trim().length > 0
    ? candidate.activeSessionId
    : null;

  return {
    sessions,
    activeSessionId,
    updatedAt: Date.now(),
  };
}

function generateTmuxSessionName(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `wt-${timePart}${randomPart}`;
}

function normalizeTmuxSessionName(input: unknown): string {
  if (typeof input !== 'string') {
    return generateTmuxSessionName();
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : generateTmuxSessionName();
}

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

function isTmuxUnavailableMessage(errorMessage: string): boolean {
  return /no such file or directory|not found|enoent/i.test(errorMessage);
}

async function getTmuxStatus(): Promise<{ available: boolean; version: string | null; reason: string | null }> {
  try {
    const raw = await runTmux(['-V']);
    return {
      available: true,
      version: raw.trim() || null,
      reason: null,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (isTmuxUnavailableMessage(errorMessage)) {
      return {
        available: false,
        version: null,
        reason: 'tmux is not installed or not available in PATH.',
      };
    }

    return {
      available: false,
      version: null,
      reason: errorMessage || 'Failed to detect tmux availability',
    };
  }
}

async function enableTmuxMouse(sessionName: string): Promise<void> {
  let lastError: unknown;

  // A newly attached session can race briefly with the client startup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runTmux(['set-option', '-t', sessionName, 'mouse', 'on']);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function disableTmuxStatus(sessionName: string): Promise<void> {
  let lastError: unknown;

  // A newly attached session can race briefly with the client startup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runTmux(['set-option', '-t', sessionName, 'status', 'off']);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function captureTmuxPane(sessionName: string): Promise<string> {
  let lastError: unknown;

  // An attached session can briefly race with tmux pane availability.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const paneId = (await runTmux([
        'display-message',
        '-t',
        sessionName,
        '-p',
        '#{pane_id}',
      ])).trim();

      return await runTmux([
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-t',
        paneId || sessionName,
      ]);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function isTmuxPaneInMode(target: string): Promise<boolean> {
  const paneInModeRaw = (await runTmux([
    'display-message',
    '-t',
    target,
    '-p',
    '#{pane_in_mode}',
  ])).trim();

  return paneInModeRaw === '1';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyInCopyModeError(message: string): boolean {
  return /already in.*mode/i.test(message);
}

function isNotInCopyModeError(message: string): boolean {
  return /not in (a )?mode/i.test(message);
}

function parseDelimitedRow(line: string, expected: number): string[] | null {
  let normalizedLine = line;
  if (normalizedLine.includes('\\037')) {
    normalizedLine = normalizedLine.split('\\037').join(TMUX_DELIMITER);
  }
  if (normalizedLine.includes('\\x1f')) {
    normalizedLine = normalizedLine.split('\\x1f').join(TMUX_DELIMITER);
  }

  const parts = normalizedLine.split(TMUX_DELIMITER);
  if (parts.length < expected) {
    return null;
  }
  if (parts.length === expected) {
    return parts;
  }
  const merged = parts.slice(0, expected - 1);
  merged.push(parts.slice(expected - 1).join(TMUX_DELIMITER));
  return merged;
}

function getPtyProcessPid(ptyProcess: PtyProcess): number | null {
  if (typeof ptyProcess.pid === 'number' && Number.isFinite(ptyProcess.pid)) {
    return ptyProcess.pid;
  }
  return null;
}

function normalizeProgramName(command: string | null | undefined): string | null {
  if (typeof command !== 'string') {
    return null;
  }

  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  const lastSegment = normalized.split(/[\\/]/).pop()?.trim();
  return lastSegment && lastSegment.length > 0 ? lastSegment : normalized;
}

function getActiveProgramFromTmuxLayout(layout: TmuxLayout): { command: string | null; source: 'tmux-pane'; updatedAt: number } | null {
  const activeWindow = layout.windows.find((window) => window.id === layout.activeWindowId);
  const activePane = activeWindow?.panes.find((pane) => pane.id === layout.activePaneId);
  const command = normalizeProgramName(activePane?.command);

  if (!command) {
    return null;
  }

  return {
    command,
    source: 'tmux-pane',
    updatedAt: Date.now(),
  };
}

async function detectShellActiveProgram(session: TerminalSession): Promise<{
  command: string | null;
  source: 'shell-tty' | 'shell-pid' | 'unknown';
  updatedAt: number;
} | null> {
  const pid = getPtyProcessPid(session.ptyProcess);
  if (pid === null) {
    return null;
  }

  try {
    const ttyPath = await fs.promises.readlink(`/proc/${pid}/fd/0`);
    const ttyName = ttyPath.startsWith('/dev/') ? ttyPath.slice('/dev/'.length) : ttyPath;

    const { stdout } = await execFileAsync('ps', [
      '-t',
      ttyName,
      '-o',
      'pid=,ppid=,pgid=,tpgid=,stat=,comm=',
    ], {
      timeout: 3000,
      maxBuffer: 512 * 1024,
    });

    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
          return null;
        }

        return {
          pid: Number.parseInt(match[1] || '0', 10),
          pgid: Number.parseInt(match[3] || '0', 10),
          tpgid: Number.parseInt(match[4] || '0', 10),
          stat: match[5] || '',
          command: normalizeProgramName(match[6]),
        };
      })
      .filter((row): row is { pid: number; pgid: number; tpgid: number; stat: string; command: string | null } => row !== null);

    if (rows.length > 0) {
      const foregroundRows = rows.filter((row) => row.command && row.tpgid > 0 && row.pgid === row.tpgid && !row.stat.startsWith('Z'));
      const preferredForeground = foregroundRows.find((row) => row.pid !== pid) ?? foregroundRows[foregroundRows.length - 1];
      if (preferredForeground?.command) {
        return {
          command: preferredForeground.command,
          source: 'shell-tty',
          updatedAt: Date.now(),
        };
      }

      const shellRow = rows.find((row) => row.pid === pid && row.command);
      if (shellRow?.command) {
        return {
          command: shellRow.command,
          source: 'shell-pid',
          updatedAt: Date.now(),
        };
      }
    }
  } catch {
    // Fall through to shell fallback.
  }

  return {
    command: normalizeProgramName(process.env.SHELL || '/bin/sh'),
    source: 'unknown',
    updatedAt: Date.now(),
  };
}

async function resolveTmuxClientTty(sessionName: string, preferredClientPid: number | null): Promise<string | null> {
  const clientsRaw = await runTmux([
    'list-clients',
    '-t',
    sessionName,
    '-F',
    `#{client_pid}${TMUX_DELIMITER}#{client_tty}`,
  ]);

  const rows = clientsRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseDelimitedRow(line, 2))
    .filter((row): row is string[] => row !== null);

  if (rows.length === 0) {
    return null;
  }

  if (preferredClientPid !== null) {
    const matched = rows.find(([clientPid]) => clientPid === String(preferredClientPid));
    if (matched?.[1]) {
      return matched[1];
    }
  }

  return rows[0][1] || null;
}

async function ensureTmuxSessionExists(sessionName: string): Promise<void> {
  try {
    await runTmux(['has-session', '-t', sessionName]);
    return;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (!/can't find session|no server running/i.test(errorMessage)) {
      throw error;
    }
  }

  await runTmux(['new-session', '-d', '-s', sessionName]);
}

async function getTmuxLayout(sessionName: string): Promise<TmuxLayout> {
  const sessionInfoRaw = (await runTmux([
    'display-message',
    '-t',
    sessionName,
    '-p',
    `#{session_id}${TMUX_DELIMITER}#{session_name}${TMUX_DELIMITER}#{window_id}${TMUX_DELIMITER}#{pane_id}${TMUX_DELIMITER}#{pane_in_mode}`,
  ])).trim();

  const sessionInfo = parseDelimitedRow(sessionInfoRaw, 5);
  if (!sessionInfo) {
    throw new Error(`Failed to parse tmux session info: ${sessionInfoRaw}`);
  }

  const [sessionId, resolvedSessionName, activeWindowId, activePaneId, paneInMode] = sessionInfo;

  const windowsRaw = await runTmux([
    'list-windows',
    '-t',
    sessionName,
    '-F',
    `#{window_id}${TMUX_DELIMITER}#{window_name}${TMUX_DELIMITER}#{window_index}${TMUX_DELIMITER}#{window_active}`,
  ]);

  const windows: TmuxWindow[] = [];

  for (const line of windowsRaw.trim().split('\n')) {
    if (!line) {
      continue;
    }

    const row = parseDelimitedRow(line, 4);
    if (!row) {
      continue;
    }

    const [windowId, windowName, windowIndexRaw, windowActiveRaw] = row;
    const panesRaw = await runTmux([
      'list-panes',
      '-t',
      windowId,
      '-F',
      `#{pane_id}${TMUX_DELIMITER}#{pane_index}${TMUX_DELIMITER}#{pane_active}${TMUX_DELIMITER}#{pane_width}${TMUX_DELIMITER}#{pane_height}${TMUX_DELIMITER}#{pane_top}${TMUX_DELIMITER}#{pane_left}${TMUX_DELIMITER}#{pane_current_command}${TMUX_DELIMITER}#{pane_title}`,
    ]);

    const panes: TmuxPane[] = panesRaw.trim().split('\n').filter(Boolean).map((paneLine) => {
      const paneRow = parseDelimitedRow(paneLine, 9);
      if (!paneRow) {
        return null;
      }

      const [paneId, paneIndexRaw, paneActiveRaw, widthRaw, heightRaw, topRaw, leftRaw, command, title] = paneRow;
      return {
        id: paneId,
        index: parseInt(paneIndexRaw || '0', 10),
        active: paneActiveRaw === '1',
        width: parseInt(widthRaw || '0', 10),
        height: parseInt(heightRaw || '0', 10),
        top: parseInt(topRaw || '0', 10),
        left: parseInt(leftRaw || '0', 10),
        command: command || '',
        title: title || '',
      } as TmuxPane;
    }).filter((pane): pane is TmuxPane => pane !== null);

    windows.push({
      id: windowId,
      name: windowName || '',
      index: parseInt(windowIndexRaw || '0', 10),
      active: windowActiveRaw === '1',
      panes,
    });
  }

  return {
    sessionId,
    sessionName: resolvedSessionName,
    windows,
    activeWindowId,
    activePaneId,
    inCopyMode: paneInMode === '1',
  };
}

async function getRestoreHistory(sessionId: string, session: TerminalSession): Promise<string[]> {
  // In tmux mode, scrollback belongs to tmux itself rather than the app layer,
  // so capture the active pane to rebuild the visible screen on refresh.
  if (session.mode === 'tmux') {
    if (!session.tmuxSessionName) {
      return [];
    }

    try {
      const snapshot = await captureTmuxPane(session.tmuxSessionName);
      return snapshot
        ? ['\u001b[H\u001b[2J\u001b[3J', snapshot]
        : [];
    } catch (error) {
      console.warn(`Failed to capture tmux pane for ${session.tmuxSessionName}: ${getErrorMessage(error)}`);
      return [];
    }
  }

  return getReconnectionHistory(sessionId);
}

function resolveWorkingDirectory(req: express.Request, inputCwd?: string): string {
  const requestedCwd = inputCwd || os.homedir();

  if (req.pathValidator) {
    return req.pathValidator.validate(requestedCwd);
  }

  if (!fs.existsSync(requestedCwd)) {
    throw new Error('Invalid working directory');
  }

  try {
    fs.accessSync(requestedCwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`Working directory is not accessible: ${requestedCwd}`);
  }

  return requestedCwd;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveShellCandidates(): string[] {
  const candidates: string[] = [];
  const configuredShell = process.env.SHELL;
  if (configuredShell && isExecutable(configuredShell)) {
    candidates.push(configuredShell);
  }

  const fallbackShells = [
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/zsh',
    '/usr/bin/zsh',
    '/bin/sh',
    '/usr/bin/sh',
  ];

  for (const candidate of fallbackShells) {
    if (isExecutable(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    throw new Error('No usable shell found. Set SHELL to an installed shell such as /bin/bash or /bin/sh.');
  }

  return candidates;
}

function shouldRetryShellSpawn(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return /posix_spawnp failed|ENOENT|EACCES/i.test(errorMessage);
}

function writeSse(res: express.Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeClient(session: TerminalSession, clientId: string): void {
  const client = session.clients.get(clientId);
  if (!client) {
    return;
  }

  session.clients.delete(clientId);
  if (session.clients.size === 0) {
    session.lastDetachedAt = Date.now();
  }

  try {
    client.end();
  } catch {
    // ignore
  }
}

function broadcastEvent(sessionId: string, payload: unknown): void {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return;
  }

  for (const [clientId, client] of session.clients.entries()) {
    try {
      writeSse(client, payload);
    } catch {
      closeClient(session, clientId);
    }
  }
}

function cleanupSession(sessionId: string, options: { killProcess: boolean; clearHistoryBuffer?: boolean }): void {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.dataDisposable?.dispose();
  session.exitDisposable?.dispose();

  if (options.killProcess) {
    try {
      session.ptyProcess.kill();
    } catch {
      // ignore
    }
  }

  for (const client of session.clients.values()) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }

  terminalSessions.delete(sessionId);

  if (options.clearHistoryBuffer !== false) {
    clearHistory(sessionId);
  }
}

function setupPtyHandlers(sessionId: string, session: TerminalSession): void {
  session.dataDisposable = session.ptyProcess.onData((data: string) => {
    session.lastActivity = Date.now();
    session.hasWrittenData = true;
    if (session.mode === 'shell') {
      addToHistory(sessionId, data);
    }
    broadcastEvent(sessionId, { type: 'data', data });
  });

  session.exitDisposable = session.ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
    broadcastEvent(sessionId, { type: 'exit', exitCode, signal });
    cleanupSession(sessionId, { killProcess: false });
  });
}

async function spawnTerminalSession(req: express.Request, input: {
  cwd?: string;
  cols?: number;
  rows?: number;
  mode?: TerminalMode;
  tmuxSessionName?: string;
  shouldPersist?: boolean;
  keepAliveMs?: number | null;
}): Promise<{ sessionId: string; session: TerminalSession; cols: number; rows: number }> {
  const cwd = resolveWorkingDirectory(req, input.cwd);
  const cols = input.cols || 80;
  const rows = input.rows || 24;
  const sessionId = Math.random().toString(36).substring(2, 15) +
                    Math.random().toString(36).substring(2, 15);
  const mode = normalizeMode(input.mode);
  const tmuxSessionName = mode === 'tmux' ? normalizeTmuxSessionName(input.tmuxSessionName) : null;

  const command = mode === 'tmux'
    ? (process.env.TMUX_BIN || 'tmux')
    : (process.platform === 'win32' ? 'powershell.exe' : resolveShellCandidates()[0]);
  const args = mode === 'tmux' && tmuxSessionName
    ? ['new-session', '-A', '-s', tmuxSessionName]
    : [];

  const envPath = buildAugmentedPath();
  const resolvedEnv = { ...process.env, PATH: envPath };

  const pty = await getPtyProvider();
  const spawnOptions = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...resolvedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  };

  let ptyProcess: PtyProcess;

  if (mode === 'shell' && process.platform !== 'win32') {
    const shellCandidates = resolveShellCandidates();
    let lastError: unknown = null;

    ptyProcess = (() => {
      for (const shellCandidate of shellCandidates) {
        try {
          return pty.spawn(shellCandidate, [], spawnOptions);
        } catch (error) {
          lastError = error;
          if (!shouldRetryShellSpawn(error)) {
            throw error;
          }
        }
      }

      throw lastError ?? new Error('Failed to start shell');
    })();
  } else {
    ptyProcess = pty.spawn(command, args, spawnOptions);
  }

  const session: TerminalSession = {
    ptyProcess,
    ptyBackend: pty.backend,
    cwd,
    mode,
    tmuxSessionName,
    lastActivity: Date.now(),
    clients: new Map(),
    createdAt: Date.now(),
    shouldPersist: input.shouldPersist !== false,
    keepAliveMs: normalizeKeepAliveMs(input.keepAliveMs),
    lastDetachedAt: null,
    hasWrittenData: false,
    activeProgram: null,
  };

  terminalSessions.set(sessionId, session);
  setupPtyHandlers(sessionId, session);

  if (mode === 'tmux' && tmuxSessionName) {
    try {
      await disableTmuxStatus(tmuxSessionName);
    } catch (error) {
      console.warn(`Failed to disable tmux status for ${tmuxSessionName}: ${getErrorMessage(error)}`);
    }

    try {
      await enableTmuxMouse(tmuxSessionName);
    } catch (error) {
      console.warn(`Failed to enable tmux mouse for ${tmuxSessionName}: ${getErrorMessage(error)}`);
    }
  }

  return { sessionId, session, cols, rows };
}

function buildAugmentedPath(): string {
  const pathEnv = process.env.PATH || '';
  const extraPaths = ['/usr/local/bin', '/usr/bin', '/bin'];
  const uniquePaths = new Set([...extraPaths, ...pathEnv.split(':').filter(Boolean)]);
  return Array.from(uniquePaths).join(':');
}

let ptyProviderPromise: Promise<PtyProvider> | null = null;

async function getPtyProvider(): Promise<PtyProvider> {
  if (ptyProviderPromise) {
    return ptyProviderPromise;
  }

  ptyProviderPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bunRuntime = (globalThis as any).Bun;

    if (bunRuntime) {
      try {
        const bunPty = await import('bun-pty');
        console.log('Using bun-pty for terminal sessions');
        return { spawn: bunPty.spawn, backend: 'bun-pty' } as PtyProvider;
      } catch (error) {
        console.warn('bun-pty unavailable, falling back to node-pty');
      }
    }

    try {
      const nodePty = await import('node-pty');
      console.log('Using node-pty for terminal sessions');
      return { spawn: nodePty.spawn, backend: 'node-pty' } as PtyProvider;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to load node-pty:', errorMessage);
      if (bunRuntime) {
        throw new Error('No PTY backend available. Install bun-pty or node-pty.');
      }
      throw new Error('node-pty is not available. Run: npm rebuild node-pty (or install Bun for bun-pty)');
    }
  })();

  return ptyProviderPromise;
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions.entries()) {
    const idleTooLong = now - session.lastActivity > TERMINAL_IDLE_TIMEOUT;
    const orphaned = session.clients.size === 0;
    const graceWindow = session.keepAliveMs;
    const graceExpired = orphaned
      && session.lastDetachedAt !== null
      && graceWindow !== null
      && now - session.lastDetachedAt > graceWindow;

    if (idleTooLong || (!session.shouldPersist && orphaned) || graceExpired) {
      console.log(`Cleaning up terminal session: ${sessionId}, idleTooLong=${idleTooLong}, orphaned=${orphaned}, graceExpired=${graceExpired}`);
      cleanupSession(sessionId, { killProcess: true });
    }
  }
}, CLEANUP_INTERVAL);

router.get('/processes', (_req, res) => {
  const processes = Array.from(terminalSessions.entries()).map(([sessionId, session]) => ({
    sessionId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    backend: session.ptyBackend,
    clients: session.clients.size,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    isOrphan: session.clients.size === 0,
    hasWrittenData: session.hasWrittenData,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  }));

  res.json({
    reconnect: {
      graceTime: DEFAULT_KEEP_ALIVE_MS,
      scrollback: RECONNECT_SCROLLBACK,
      idleTimeout: TERMINAL_IDLE_TIMEOUT,
    },
    processes,
  });
});

router.get('/tmux/sessions', async (_req, res) => {
  try {
    const raw = await runTmux([
      'list-sessions',
      '-F',
      `#{session_name}${TMUX_DELIMITER}#{session_windows}${TMUX_DELIMITER}#{session_attached}`,
    ]);

    const sessions = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseDelimitedRow(line, 3))
      .filter((row): row is string[] => row !== null)
      .map(([name, windowsRaw, attachedRaw]) => ({
        name,
        windows: Number.parseInt(windowsRaw || '0', 10) || 0,
        attached: Number.parseInt(attachedRaw || '0', 10) || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ sessions });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (/no server running/i.test(errorMessage)) {
      return res.json({ sessions: [] });
    }
    if (isTmuxUnavailableMessage(errorMessage)) {
      return res.json({ sessions: [], available: false, reason: 'tmux is not installed or not available in PATH.' });
    }
    return res.status(500).json({ error: errorMessage || 'Failed to list tmux sessions' });
  }
});

router.get('/tmux/status', async (_req, res) => {
  const status = await getTmuxStatus();
  res.json(status);
});

router.post('/serialize-state', async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? new Set((req.body.ids as unknown[]).filter((item): item is string => typeof item === 'string'))
    : null;

  const states = await Promise.all(
    Array.from(terminalSessions.entries())
      .filter(([sessionId, session]) => (ids ? ids.has(sessionId) : true) && session.shouldPersist)
      .map(async ([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        backend: session.ptyBackend,
        mode: session.mode,
        tmuxSessionName: session.tmuxSessionName,
        keepAliveMs: session.keepAliveMs,
        history: await getRestoreHistory(sessionId, session),
      }))
  );

  res.json({
    serialized: JSON.stringify({ version: 1, states }),
    states,
  });
});

router.get('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  const state = clientTerminalStates.get(clientId) ?? {
    sessions: [],
    updatedAt: Date.now(),
  };

  res.json(state);
});

router.put('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  const state = normalizeClientTerminalState(req.body);
  clientTerminalStates.set(clientId, state);
  res.json(state);
});

router.delete('/client-state', (req, res) => {
  const clientId = req.clientId;
  if (!clientId) {
    return res.status(500).json({ error: 'Client identity is not available' });
  }

  clientTerminalStates.delete(clientId);
  res.status(204).send();
});

router.post('/create', async (req, res) => {
  try {
    if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
      return res.status(429).json({ error: 'Maximum terminal sessions reached' });
    }

    const { cwd: inputCwd, cols, rows, mode, tmuxSessionName, shouldPersist, keepAliveMs } = req.body;
    const { sessionId, session } = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      mode,
      tmuxSessionName,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Created terminal session: ${sessionId} in ${session.cwd}, shouldPersist=${session.shouldPersist}, keepAliveMs=${session.keepAliveMs ?? 'never'}`);
    res.json({
      sessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      shouldPersist: session.shouldPersist,
      keepAliveMs: session.keepAliveMs,
      activeProgram: session.activeProgram?.command ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to create terminal session:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to create terminal session' });
  }
});

router.get('/:sessionId/stream', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const clientId = Math.random().toString(36).substring(7);
  session.clients.set(clientId, res);
  session.lastActivity = Date.now();
  session.lastDetachedAt = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime = (globalThis as any).Bun ? 'bun' : 'node';
  const ptyBackend = session.ptyBackend || 'unknown';
  writeSse(res, {
    type: 'connected',
    runtime,
    ptyBackend,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  });

  let tmuxInterval: ReturnType<typeof setInterval> | null = null;
  let activeProgramInterval: ReturnType<typeof setInterval> | null = null;
  let lastTmuxLayoutSnapshot = '';
  let lastActiveProgramSnapshot = JSON.stringify(session.activeProgram ?? null);

  const maybeWriteActiveProgram = (activeProgram: TerminalSession['activeProgram']) => {
    const snapshot = JSON.stringify(activeProgram ?? null);
    if (snapshot === lastActiveProgramSnapshot) {
      return;
    }

    lastActiveProgramSnapshot = snapshot;
    session.activeProgram = activeProgram;
    writeSse(res, {
      type: 'active-program',
      activeProgram: activeProgram?.command ?? null,
      activeProgramSource: activeProgram?.source ?? null,
    });
  };

  const sendTmuxLayout = async () => {
    if (session.mode !== 'tmux' || !session.tmuxSessionName) {
      return;
    }

    try {
      const layout = await getTmuxLayout(session.tmuxSessionName);
      maybeWriteActiveProgram(getActiveProgramFromTmuxLayout(layout));
      const snapshot = JSON.stringify(layout);
      if (snapshot === lastTmuxLayoutSnapshot) {
        return;
      }
      lastTmuxLayoutSnapshot = snapshot;
      writeSse(res, { type: 'tmux-layout', layout });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to fetch tmux layout for ${session.tmuxSessionName}: ${errorMessage}`);
    }
  };

  const sendShellActiveProgram = async () => {
    if (session.mode !== 'shell') {
      return;
    }

    try {
      maybeWriteActiveProgram(await detectShellActiveProgram(session));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to detect active shell program for ${sessionId}: ${errorMessage}`);
    }
  };

  if (session.mode === 'tmux' && session.tmuxSessionName) {
    void sendTmuxLayout();
    tmuxInterval = setInterval(() => {
      void sendTmuxLayout();
    }, TMUX_POLL_INTERVAL);
  } else {
    void sendShellActiveProgram();
    activeProgramInterval = setInterval(() => {
      void sendShellActiveProgram();
    }, ACTIVE_PROGRAM_POLL_INTERVAL);
  }

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (error) {
      console.error(`Heartbeat failed for client ${clientId}:`, error);
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  if (req.query.replay === '1') {
    if (session.mode === 'shell') {
      const replayChunks = getReconnectionHistory(sessionId);
      for (const chunk of replayChunks) {
        writeSse(res, { type: 'data', data: chunk, replay: true });
      }
    }
  }

  const cleanup = () => {
    clearInterval(heartbeatInterval);
    if (tmuxInterval) {
      clearInterval(tmuxInterval);
    }
    if (activeProgramInterval) {
      clearInterval(activeProgramInterval);
    }
    closeClient(session, clientId);
    console.log(`Client ${clientId} disconnected from terminal session ${sessionId}`);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  console.log(`Terminal connected: session=${sessionId} client=${clientId} runtime=${runtime} pty=${ptyBackend}`);
});

router.get('/:sessionId/health', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);
  
  if (!session) {
    console.log(`Health check: session ${sessionId} not found`);
    return res.status(404).json({ healthy: false, error: 'Session not found' });
  }
  
  console.log(`Health check: session ${sessionId} healthy, cwd=${session.cwd}, clients=${session.clients.size}, lastActivity=${Date.now() - session.lastActivity}ms ago`);
   res.json({ 
     healthy: true, 
     sessionId,
      cwd: session.cwd,
      clients: session.clients.size,
      lastActivity: session.lastActivity,
      backend: session.ptyBackend,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      activeProgram: session.activeProgram?.command ?? null,
      activeProgramSource: session.activeProgram?.source ?? null,
    });
 });

router.get('/:sessionId/attach', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lastDetachedAt = null;
  session.lastActivity = Date.now();

  const history = await getRestoreHistory(sessionId, session);

  res.json({
    sessionId,
    cwd: session.cwd,
    backend: session.ptyBackend,
    clients: session.clients.size,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    history,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    activeProgram: session.activeProgram?.command ?? null,
    activeProgramSource: session.activeProgram?.source ?? null,
  });
});

router.patch('/:sessionId/policy', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'shouldPersist')) {
    session.shouldPersist = req.body.shouldPersist !== false;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'keepAliveMs')) {
    session.keepAliveMs = normalizeKeepAliveMs(req.body.keepAliveMs);
  }

  if (session.clients.size === 0) {
    session.lastDetachedAt = Date.now();
  }

  return res.json({
    sessionId,
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    clients: session.clients.size,
  });
});

router.post('/:sessionId/detach', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.clients.size === 0) {
    session.lastDetachedAt = Date.now();
  }

  res.json({
    sessionId,
    detachedAt: session.lastDetachedAt,
    clients: session.clients.size,
    shouldPersist: session.shouldPersist,
  });
});

router.post('/:sessionId/input', express.text({ type: '*/*' }), (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const data = typeof req.body === 'string' ? req.body : '';

  try {
    session.ptyProcess.write(data);
    session.lastActivity = Date.now();
    res.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to write to terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to write to terminal' });
  }
});

router.post('/:sessionId/resize', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const { cols, rows } = req.body;
  if (!cols || !rows) {
    return res.status(400).json({ error: 'cols and rows are required' });
  }

  try {
    session.ptyProcess.resize(cols, rows);
    session.lastActivity = Date.now();
    res.json({ success: true, cols, rows });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to resize terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to resize terminal' });
  }
});

router.post('/:sessionId/tmux', async (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  if (session.mode !== 'tmux' || !session.tmuxSessionName) {
    return res.status(400).json({ error: 'Terminal session is not in tmux mode' });
  }

  const { action } = req.body ?? {};

  try {
    let shouldBroadcastLayout = true;
    let tmuxTarget = session.tmuxSessionName;

    switch (action) {
      case 'select-pane': {
        const paneId = typeof req.body?.paneId === 'string' ? req.body.paneId : '';
        if (!paneId) {
          return res.status(400).json({ error: 'paneId is required' });
        }
        await runTmux(['select-pane', '-t', paneId]);
        break;
      }
      case 'select-window': {
        const windowId = typeof req.body?.windowId === 'string' ? req.body.windowId : '';
        if (!windowId) {
          return res.status(400).json({ error: 'windowId is required' });
        }
        await runTmux(['select-window', '-t', windowId]);
        break;
      }
      case 'split-pane': {
        const direction = req.body?.direction === 'h' ? '-h' : '-v';
        await runTmux(['split-window', '-t', tmuxTarget, direction]);
        break;
      }
      case 'close-pane': {
        const paneId = typeof req.body?.paneId === 'string' ? req.body.paneId : '';
        if (!paneId) {
          return res.status(400).json({ error: 'paneId is required' });
        }
        await runTmux(['kill-pane', '-t', paneId]);
        break;
      }
      case 'copy-mode': {
        const enabled = req.body?.enabled !== false;
        if (enabled) {
          try {
            await runTmux(['copy-mode', '-t', tmuxTarget]);
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            if (!isAlreadyInCopyModeError(errorMessage)) {
              throw error;
            }
          }
        } else {
          try {
            await runTmux(['send-keys', '-t', tmuxTarget, '-X', 'cancel']);
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            if (!isNotInCopyModeError(errorMessage)) {
              throw error;
            }
          }
        }
        break;
      }
      case 'scroll': {
        const direction = req.body?.direction === 'down' ? 'down' : 'up';
        const lines = Math.max(1, Math.min(50, Math.floor(Number(req.body?.lines) || 1)));

        let inCopyMode = await isTmuxPaneInMode(tmuxTarget);

        if (!inCopyMode) {
          try {
            await runTmux(['copy-mode', '-t', tmuxTarget]);
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            if (!isAlreadyInCopyModeError(errorMessage)) {
              throw error;
            }
          }

          inCopyMode = await isTmuxPaneInMode(tmuxTarget);
        }

        if (!inCopyMode) {
          shouldBroadcastLayout = false;
          return res.json({ success: true, skipped: 'pane-not-in-copy-mode' });
        }

        const primaryCommand = direction === 'up' ? 'scroll-up' : 'scroll-down';
        const fallbackCommands = direction === 'up'
          ? ['up-line', 'cursor-up']
          : ['down-line', 'cursor-down'];

        let scrollSucceeded = false;
        let lastError: unknown = null;

        const tryCommand = async (command: string): Promise<boolean> => {
          try {
            await runTmux([
              'send-keys',
              '-t',
              tmuxTarget,
              '-X',
              '-N',
              String(lines),
              command,
            ]);
            return true;
          } catch (error) {
            lastError = error;
            return false;
          }
        };

        scrollSucceeded = await tryCommand(primaryCommand);
        if (!scrollSucceeded) {
          for (const fallback of fallbackCommands) {
            scrollSucceeded = await tryCommand(fallback);
            if (scrollSucceeded) {
              break;
            }
          }
        }

        if (!scrollSucceeded && lastError) {
          throw lastError;
        }

        shouldBroadcastLayout = false;
        break;
      }
      case 'new-window': {
        await runTmux(['new-window', '-t', tmuxTarget]);
        break;
      }
      case 'switch-session': {
        const targetSessionName = typeof req.body?.tmuxSessionName === 'string'
          ? req.body.tmuxSessionName.trim()
          : '';

        if (!targetSessionName) {
          return res.status(400).json({ error: 'tmuxSessionName is required' });
        }

        const preferredClientPid = getPtyProcessPid(session.ptyProcess);
        const clientTty = await resolveTmuxClientTty(tmuxTarget, preferredClientPid);

        if (!clientTty) {
          return res.status(500).json({ error: 'No tmux client available for current session' });
        }

        await ensureTmuxSessionExists(targetSessionName);
        await runTmux(['switch-client', '-c', clientTty, '-t', targetSessionName]);
        session.tmuxSessionName = targetSessionName;
        tmuxTarget = targetSessionName;
        break;
      }
      default:
        return res.status(400).json({ error: 'Unsupported tmux action' });
    }

    session.lastActivity = Date.now();

    if (shouldBroadcastLayout) {
      const layout = await getTmuxLayout(tmuxTarget);
      broadcastEvent(sessionId, { type: 'tmux-layout', layout });
      return res.json({ success: true, layout });
    }

    return res.json({ success: true });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`Failed to execute tmux action ${action}:`, errorMessage);
    return res.status(500).json({ error: errorMessage || 'Failed to execute tmux action' });
  }
});

router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  try {
    cleanupSession(sessionId, { killProcess: true });
    console.log(`Closed terminal session: ${sessionId}`);
    res.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to close terminal:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to close terminal' });
  }
});

router.post('/:sessionId/restart', async (req, res) => {
  const { sessionId } = req.params;
  const { cwd: inputCwd, cols, rows, mode, tmuxSessionName, shouldPersist, keepAliveMs } = req.body;

  const existingSession = terminalSessions.get(sessionId);
  if (existingSession) {
    cleanupSession(sessionId, { killProcess: true });
  }

  try {
    const { sessionId: newSessionId, session } = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      mode,
      tmuxSessionName,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${session.cwd}`);
    res.json({
      sessionId: newSessionId,
      cols: cols || 80,
      rows: rows || 24,
      mode: session.mode,
      tmuxSessionName: session.tmuxSessionName,
      shouldPersist: session.shouldPersist,
      keepAliveMs: session.keepAliveMs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to restart terminal session:', errorMessage);
    res.status(500).json({ error: errorMessage || 'Failed to restart terminal session' });
  }
});

router.post('/force-kill', (req, res) => {
  const { sessionId, cwd } = req.body;
  let killedCount = 0;

  if (sessionId) {
    const session = terminalSessions.get(sessionId);
    if (session) {
      cleanupSession(sessionId, { killProcess: true });
      killedCount++;
    }
  } else if (cwd) {
    for (const [id, session] of terminalSessions) {
      if (session.cwd === cwd) {
        cleanupSession(id, { killProcess: true });
        killedCount++;
      }
    }
  } else {
    for (const [id] of terminalSessions) {
      cleanupSession(id, { killProcess: true });
      killedCount++;
    }
  }

  console.log(`Force killed ${killedCount} terminal session(s)`);
  res.json({ success: true, killedCount });
});

export default router;
