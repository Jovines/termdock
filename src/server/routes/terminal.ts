import express from 'express';
import fs from 'fs';
import os from 'os';

const router = express.Router();

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
}

interface TerminalSession {
  ptyProcess: PtyProcess;
  ptyBackend: string;
  cwd: string;
  lastActivity: number;
  clients: Map<string, express.Response>;
  createdAt: number;
  shouldPersist: boolean;
  keepAliveMs: number | null;
  lastDetachedAt: number | null;
  hasWrittenData: boolean;
  dataDisposable?: { dispose: () => void };
  exitDisposable?: { dispose: () => void };
}

const terminalSessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_SESSIONS = parseInt(process.env.MAX_TERMINAL_SESSIONS || '20', 10);

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '300000' : '1800000'), 10);
const CLEANUP_INTERVAL = isDevelopment ? 60 * 1000 : 5 * 60 * 1000;
const DEFAULT_KEEP_ALIVE_MS = parseInt(process.env.TERMINAL_DEFAULT_KEEPALIVE_MS || String(3 * 60 * 60 * 1000), 10);
const RECONNECT_SCROLLBACK = parseInt(process.env.TERMINAL_RECONNECT_SCROLLBACK || '200', 10);

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

function resolveWorkingDirectory(req: express.Request, inputCwd?: string): string {
  const requestedCwd = inputCwd || os.homedir();

  if (req.pathValidator) {
    return req.pathValidator.validate(requestedCwd);
  }

  if (!fs.existsSync(requestedCwd)) {
    throw new Error('Invalid working directory');
  }

  return requestedCwd;
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
    addToHistory(sessionId, data);
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
  shouldPersist?: boolean;
  keepAliveMs?: number | null;
}): Promise<{ sessionId: string; session: TerminalSession; cols: number; rows: number }> {
  const cwd = resolveWorkingDirectory(req, input.cwd);
  const cols = input.cols || 80;
  const rows = input.rows || 24;

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  const sessionId = Math.random().toString(36).substring(2, 15) +
                    Math.random().toString(36).substring(2, 15);

  const envPath = buildAugmentedPath();
  const resolvedEnv = { ...process.env, PATH: envPath };

  const pty = await getPtyProvider();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...resolvedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  const session: TerminalSession = {
    ptyProcess,
    ptyBackend: pty.backend,
    cwd,
    lastActivity: Date.now(),
    clients: new Map(),
    createdAt: Date.now(),
    shouldPersist: input.shouldPersist !== false,
    keepAliveMs: normalizeKeepAliveMs(input.keepAliveMs),
    lastDetachedAt: null,
    hasWrittenData: false,
  };

  terminalSessions.set(sessionId, session);
  setupPtyHandlers(sessionId, session);

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
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
    isOrphan: session.clients.size === 0,
    hasWrittenData: session.hasWrittenData,
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

router.post('/serialize-state', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? new Set((req.body.ids as unknown[]).filter((item): item is string => typeof item === 'string'))
    : null;

  const states = Array.from(terminalSessions.entries())
    .filter(([sessionId, session]) => (ids ? ids.has(sessionId) : true) && session.shouldPersist)
    .map(([sessionId, session]) => ({
      sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      backend: session.ptyBackend,
      keepAliveMs: session.keepAliveMs,
      history: getReconnectionHistory(sessionId),
    }));

  res.json({
    serialized: JSON.stringify({ version: 1, states }),
    states,
  });
});

router.post('/create', async (req, res) => {
  try {
    if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
      return res.status(429).json({ error: 'Maximum terminal sessions reached' });
    }

    const { cwd: inputCwd, cols, rows, shouldPersist, keepAliveMs } = req.body;
    const { sessionId, session } = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Created terminal session: ${sessionId} in ${session.cwd}, shouldPersist=${session.shouldPersist}, keepAliveMs=${session.keepAliveMs ?? 'never'}`);
    res.json({ sessionId, cols: cols || 80, rows: rows || 24, shouldPersist: session.shouldPersist, keepAliveMs: session.keepAliveMs });
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
  res.write(`data: ${JSON.stringify({ type: 'connected', runtime, ptyBackend })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (error) {
      console.error(`Heartbeat failed for client ${clientId}:`, error);
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  if (req.query.replay === '1') {
    const replayChunks = getReconnectionHistory(sessionId);
    for (const chunk of replayChunks) {
      writeSse(res, { type: 'data', data: chunk, replay: true });
    }
  }

  const cleanup = () => {
    clearInterval(heartbeatInterval);
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
     backend: session.ptyBackend
   });
 });

router.get('/:sessionId/attach', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lastDetachedAt = null;
  session.lastActivity = Date.now();

  res.json({
    sessionId,
    cwd: session.cwd,
    backend: session.ptyBackend,
    clients: session.clients.size,
    history: getReconnectionHistory(sessionId),
    shouldPersist: session.shouldPersist,
    keepAliveMs: session.keepAliveMs,
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
  const { cwd: inputCwd, cols, rows, shouldPersist, keepAliveMs } = req.body;

  const existingSession = terminalSessions.get(sessionId);
  if (existingSession) {
    cleanupSession(sessionId, { killProcess: true });
  }

  try {
    const { sessionId: newSessionId, session } = await spawnTerminalSession(req, {
      cwd: inputCwd,
      cols,
      rows,
      shouldPersist,
      keepAliveMs,
    });

    console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${session.cwd}`);
    res.json({ sessionId: newSessionId, cols: cols || 80, rows: rows || 24, shouldPersist: session.shouldPersist, keepAliveMs: session.keepAliveMs });
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
