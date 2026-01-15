import express from 'express';
import fs from 'fs';
import path from 'path';
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
  clients: Set<string>;
  createdAt: number;
}

const terminalSessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_SESSIONS = parseInt(process.env.MAX_TERMINAL_SESSIONS || '20', 10);

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '300000' : '1800000'), 10);
const CLEANUP_INTERVAL = isDevelopment ? 60 * 1000 : 5 * 60 * 1000;

// Session 持久化存储
const SESSION_STORAGE_FILE = path.join(process.cwd(), '.terminal-sessions.json');

interface PersistedSessionMeta {
  sessionId: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
}

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

function persistSessions(sessions: PersistedSessionMeta[]): void {
  try {
    fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(sessions, null, 2));
  } catch {
    // Ignore errors
  }
}

setInterval(() => {
  const sessionMetas: PersistedSessionMeta[] = [];
  for (const [sessionId, session] of terminalSessions.entries()) {
    sessionMetas.push({
      sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    });
  }
  persistSessions(sessionMetas);
}, 30000);

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
    if (now - session.lastActivity > TERMINAL_IDLE_TIMEOUT) {
      console.log(`Cleaning up idle terminal session: ${sessionId}`);
      try {
        session.ptyProcess.kill();
      } catch (error) {
      }
      terminalSessions.delete(sessionId);
    }
  }
}, CLEANUP_INTERVAL);

router.post('/create', async (req, res) => {
  try {
    if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
      return res.status(429).json({ error: 'Maximum terminal sessions reached' });
    }

    const { cwd: inputCwd, cols, rows } = req.body;
    const cwd = inputCwd || os.homedir();

    if (!fs.existsSync(cwd)) {
      return res.status(400).json({ error: 'Invalid working directory' });
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

    const sessionId = Math.random().toString(36).substring(2, 15) +
                      Math.random().toString(36).substring(2, 15);

    const envPath = buildAugmentedPath();
    const resolvedEnv = { ...process.env, PATH: envPath };

    const pty = await getPtyProvider();
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd,
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
      clients: new Set(),
      createdAt: Date.now(),
    };

    terminalSessions.set(sessionId, session);

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      terminalSessions.delete(sessionId);
    });

    console.log(`Created terminal session: ${sessionId} in ${cwd}`);
    res.json({ sessionId, cols: cols || 80, rows: rows || 24 });
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
  session.clients.add(clientId);
  session.lastActivity = Date.now();

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

  const dataHandler = (data: string) => {
    try {
      session.lastActivity = Date.now();
      // Capture to history buffer
      addToHistory(sessionId, data);
      const ok = res.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`);
      if (!ok && session.ptyProcess && typeof session.ptyProcess.pause === 'function') {
        session.ptyProcess.pause();
        res.once('drain', () => {
          if (session.ptyProcess && typeof session.ptyProcess.resume === 'function') {
            session.ptyProcess.resume();
          }
        });
      }
    } catch (error) {
      console.error(`Error sending data to client ${clientId}:`, error);
      cleanup();
    }
  };

  const exitHandler = ({ exitCode, signal }: { exitCode: number; signal: number | null }) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'exit', exitCode, signal })}\n\n`);
      res.end();
    } catch (error) {
    }
    cleanup();
  };

  const dataDisposable = session.ptyProcess.onData(dataHandler);
  const exitDisposable = session.ptyProcess.onExit(exitHandler);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
    session.clients.delete(clientId);
    dataDisposable.dispose();
    exitDisposable.dispose();
    try {
      res.end();
    } catch (error) {
    }
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

  // 重连 API - 检查并返回现有 session 信息
  router.get('/:sessionId/reconnect', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      clearHistory(sessionId);
      return res.status(404).json({
        error: 'Session not found or expired',
        expired: true
      });
    }

    // 检查是否超时
    const age = Date.now() - session.lastActivity;
    if (age > TERMINAL_IDLE_TIMEOUT) {
      console.log(`Reconnect rejected: session ${sessionId} expired (age: ${age}ms)`);
      terminalSessions.delete(sessionId);
      clearHistory(sessionId);
      return res.status(410).json({
        error: 'Session expired',
        expired: true
      });
    }

    // 返回 session 信息和历史数据
    const history = getHistory(sessionId);
    console.log(`Reconnect accepted: session=${sessionId} cwd=${session.cwd}, historySize=${history.length} chunks, ${history.join('').length} bytes`);
    res.json({
      sessionId,
      cwd: session.cwd,
      backend: session.ptyBackend,
      clients: session.clients.size,
      age,
      history
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
    session.ptyProcess.kill();
    terminalSessions.delete(sessionId);
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
  const { cwd: inputCwd, cols, rows } = req.body;
  const cwd = inputCwd || os.homedir();

  const existingSession = terminalSessions.get(sessionId);
  if (existingSession) {
    try {
      existingSession.ptyProcess.kill();
    } catch (error) {
    }
    terminalSessions.delete(sessionId);
  }

  try {
    if (!fs.existsSync(cwd)) {
      return res.status(400).json({ error: 'Invalid working directory' });
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

    const newSessionId = Math.random().toString(36).substring(2, 15) +
                        Math.random().toString(36).substring(2, 15);

    const envPath = buildAugmentedPath();
    const resolvedEnv = { ...process.env, PATH: envPath };

    const pty = await getPtyProvider();
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd,
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
      clients: new Set(),
      createdAt: Date.now(),
    };

    terminalSessions.set(newSessionId, session);

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal session ${newSessionId} exited with code ${exitCode}, signal ${signal}`);
      terminalSessions.delete(newSessionId);
    });

    console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${cwd}`);
    res.json({ sessionId: newSessionId, cols: cols || 80, rows: rows || 24 });
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
      try {
        session.ptyProcess.kill();
      } catch (error) {
      }
      terminalSessions.delete(sessionId);
      killedCount++;
    }
  } else if (cwd) {
    for (const [id, session] of terminalSessions) {
      if (session.cwd === cwd) {
        try {
          session.ptyProcess.kill();
        } catch (error) {
        }
        terminalSessions.delete(id);
        killedCount++;
      }
    }
  } else {
    for (const [id, session] of terminalSessions) {
      try {
        session.ptyProcess.kill();
      } catch (error) {
      }
      terminalSessions.delete(id);
      killedCount++;
    }
  }

  console.log(`Force killed ${killedCount} terminal session(s)`);
  res.json({ success: true, killedCount });
});

export default router;
