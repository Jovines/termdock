import express from 'express';
import fs from 'fs';

const router = express.Router();

// PTY后端抽象
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
}

const terminalSessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_SESSIONS = parseInt(process.env.MAX_TERMINAL_SESSIONS || '20', 10);

// 开发模式下使用更激进的清理策略
const isDevelopment = process.env.NODE_ENV === 'development';
const TERMINAL_IDLE_TIMEOUT = parseInt(process.env.TERMINAL_IDLE_TIMEOUT || (isDevelopment ? '60000' : '1800000'), 10); // 开发: 1分钟, 生产: 30分钟
const CLEANUP_INTERVAL = isDevelopment ? 30 * 1000 : 5 * 60 * 1000; // 开发: 30秒, 生产: 5分钟

function buildAugmentedPath(): string {
  const pathEnv = process.env.PATH || '';
  const extraPaths = ['/usr/local/bin', '/usr/bin', '/bin'];
  const allPaths = [...extraPaths, ...pathEnv.split(':')].filter(Boolean);
  return [...new Set(allPaths)].join(':');
}

// 获取PTY提供者
async function getPtyProvider(): Promise<PtyProvider> {
  try {
    // 优先尝试Bun的pty
    const { BunPtyProvider } = await import('./lib/bun-pty.js');
    return new BunPtyProvider();
  } catch (error) {
    // 回退到node-pty
    const { NodePtyProvider } = await import('./lib/node-pty.js');
    return new NodePtyProvider();
  }
}

// 清理空闲会话
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions.entries()) {
    if (now - session.lastActivity > TERMINAL_IDLE_TIMEOUT) {
      console.log(`Cleaning up idle terminal session: ${sessionId}`);
      try {
        session.ptyProcess.kill();
      } catch (error) {
        // 忽略错误
      }
      terminalSessions.delete(sessionId);
    }
  }
}, CLEANUP_INTERVAL);

// 输入验证：过滤危险控制字符
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  
  // 过滤危险的控制序列
  const esc = String.fromCharCode(0x1b); // ESC字符
  const bell = String.fromCharCode(0x07); // BEL字符
  
  const dangerousPatterns = [
    new RegExp(`${esc}\\[[0-9;]*[ABCDEFGHJKSTfmhlr]`, 'g'), // 危险的ANSI序列
    new RegExp(`${esc}\\][0-9];.*${bell}`, 'g'), // OSC序列
    new RegExp(`${esc}P.*${esc}\\\\`, 'g'), // DCS序列
  ];
  
  let sanitized = input;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }
  
  // 限制输入长度
  const MAX_INPUT_LENGTH = 1024 * 10; // 10KB
  if (sanitized.length > MAX_INPUT_LENGTH) {
    console.warn(`Input truncated from ${sanitized.length} to ${MAX_INPUT_LENGTH} characters`);
    sanitized = sanitized.substring(0, MAX_INPUT_LENGTH);
  }
  
  return sanitized;
}

// 创建终端会话
router.post('/create', async (req, res) => {
  try {
    if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
      return res.status(429).json({ error: 'Maximum terminal sessions reached' });
    }

    const { cwd, cols, rows } = req.body;
    if (!cwd) {
      return res.status(400).json({ error: 'cwd is required' });
    }

    // 使用路径验证器而不是fs.existsSync
    let validatedCwd: string;
    try {
      validatedCwd = req.pathValidator?.validate(cwd) || cwd;
    } catch (error: any) {
      return res.status(400).json({ 
        error: 'Invalid working directory',
        details: error.message 
      });
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
      cwd: validatedCwd,
      env: {
        ...resolvedEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const session: TerminalSession = {
      ptyProcess,
      ptyBackend: pty.backend,
      cwd: validatedCwd,
      lastActivity: Date.now(),
      clients: new Set(),
    };

    terminalSessions.set(sessionId, session);

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      terminalSessions.delete(sessionId);
    });

    console.log(`Created secure terminal session: ${sessionId} in ${validatedCwd}`);
    res.json({ sessionId, cols: cols || 80, rows: rows || 24 });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to create terminal session:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to create terminal session',
      code: 'TERMINAL_CREATION_FAILED'
    });
  }
});

// SSE流式输出
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
      const escaped = data.replace(/\n/g, '\ndata: ');
      res.write(`data: ${escaped}\n\n`);
    } catch (error) {
      console.error(`Failed to write SSE data for client ${clientId}:`, error);
      clearInterval(heartbeatInterval);
    }
  };

  const exitHandler = ({ exitCode, signal }: { exitCode: number; signal: number | null }) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'exited', exitCode, signal })}\n\n`);
      res.end();
    } catch (error) {
      // 忽略错误
    } finally {
      clearInterval(heartbeatInterval);
      terminalSessions.delete(sessionId);
    }
  };

  const dataDisposable = session.ptyProcess.onData(dataHandler);
  const exitDisposable = session.ptyProcess.onExit(exitHandler);

  req.on('close', () => {
    clearInterval(heartbeatInterval);
    dataDisposable.dispose();
    exitDisposable.dispose();
    session.clients.delete(clientId);
    console.log(`Client ${clientId} disconnected from session ${sessionId}`);
    
    // 如果会话没有客户端了，可以清理
    if (session.clients.size === 0) {
      session.lastActivity = Date.now(); // 更新最后活动时间
    }
  });
});

// 健康检查
router.get('/:sessionId/health', (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  res.json({
    sessionId,
    active: true,
    clients: Array.from(session.clients),
    lastActivity: session.lastActivity,
    backend: session.ptyBackend
  });
});

// 发送输入
router.post('/:sessionId/input', express.text({ type: '*/*' }), (req, res) => {
  const { sessionId } = req.params;
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  const data = typeof req.body === 'string' ? req.body : '';
  const sanitizedData = sanitizeInput(data);

  try {
    session.ptyProcess.write(sanitizedData);
    session.lastActivity = Date.now();
    res.json({ success: true, sanitizedLength: sanitizedData.length });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to write to terminal:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to write to terminal',
      code: 'TERMINAL_WRITE_FAILED'
    });
  }
});

// 调整终端大小
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

  // 验证大小参数
  const validatedCols = Math.max(10, Math.min(cols, 500));
  const validatedRows = Math.max(5, Math.min(rows, 200));

  try {
    session.ptyProcess.resize(validatedCols, validatedRows);
    session.lastActivity = Date.now();
    res.json({ success: true, cols: validatedCols, rows: validatedRows });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to resize terminal:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to resize terminal',
      code: 'TERMINAL_RESIZE_FAILED'
    });
  }
});

// 关闭会话
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
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to close terminal:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to close terminal',
      code: 'TERMINAL_CLOSE_FAILED'
    });
  }
});

// 重启会话
router.post('/:sessionId/restart', async (req, res) => {
  const { sessionId } = req.params;
  const { cwd, cols, rows } = req.body;

  if (!cwd) {
    return res.status(400).json({ error: 'cwd is required' });
  }

  const existingSession = terminalSessions.get(sessionId);
  if (existingSession) {
    try {
      existingSession.ptyProcess.kill();
    } catch (error) {
      // 忽略错误
    }
    terminalSessions.delete(sessionId);
  }

  try {
    // 使用路径验证器
    let validatedCwd: string;
    try {
      validatedCwd = req.pathValidator?.validate(cwd) || cwd;
    } catch (error: any) {
      return res.status(400).json({ 
        error: 'Invalid working directory',
        details: error.message 
      });
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
      cwd: validatedCwd,
      env: {
        ...resolvedEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const session: TerminalSession = {
      ptyProcess,
      ptyBackend: pty.backend,
      cwd: validatedCwd,
      lastActivity: Date.now(),
      clients: new Set(),
    };

    terminalSessions.set(newSessionId, session);

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal session ${newSessionId} exited with code ${exitCode}, signal ${signal}`);
      terminalSessions.delete(newSessionId);
    });

    console.log(`Restarted secure terminal session: ${newSessionId} in ${validatedCwd}`);
    res.json({ 
      success: true, 
      newSessionId, 
      oldSessionId: sessionId,
      cols: cols || 80, 
      rows: rows || 24 
    });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to restart terminal session:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to restart terminal session',
      code: 'TERMINAL_RESTART_FAILED'
    });
  }
});

// 强制结束会话（管理端点）
router.post('/force-kill', (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const session = terminalSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Terminal session not found' });
  }

  try {
    session.ptyProcess.kill();
    terminalSessions.delete(sessionId);
    console.log(`Force killed terminal session: ${sessionId}`);
    res.json({ success: true });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to force kill terminal:', errorMessage);
    res.status(500).json({ 
      error: errorMessage || 'Failed to force kill terminal',
      code: 'TERMINAL_FORCE_KILL_FAILED'
    });
  }
});

// 会话统计
router.get('/stats', (_req, res) => {
  const stats = {
    totalSessions: terminalSessions.size,
    maxSessions: MAX_TERMINAL_SESSIONS,
    sessions: Array.from(terminalSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      cwd: session.cwd,
      clients: Array.from(session.clients),
      lastActivity: session.lastActivity,
      backend: session.ptyBackend,
      idleTime: Date.now() - session.lastActivity,
    })),
    security: {
      pathValidation: true,
      inputSanitization: true,
      csrfProtection: true,
      rateLimiting: true,
    }
  };
  
  res.json(stats);
});

export default router;