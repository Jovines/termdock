import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import terminalRoutes, { handleTerminalWebSocket, handleControlWebSocket } from './routes/terminal.js';
import filesystemRoutes from './routes/filesystem.js';
import authRoutes from './routes/auth.js';
import { csrfProtection } from './utils/csrfProtection.js';
import { pathValidator } from './utils/pathValidator.js';
import { isUpgradeRequestAuthenticated, requireAuth } from './utils/authProtection.js';

import { PORT, DEFAULT_HOST } from './config.js';

const CLIENT_STATE_COOKIE = 'termdock-client';
export const DEFAULT_PORT = PORT.backend;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const clientDistPath = path.resolve(currentDirPath, '../client');
const clientIndexPath = path.join(clientDistPath, 'index.html');

export interface ServerOptions {
  host?: string;
  port?: number;
}

export function createApp(): express.Express {
  const app = express();

  // 基础中间件
  app.use(express.json());
  app.use(cookieParser());

  // Note: clientId cookie is no longer used for session persistence (sessions are global).
  // Kept for potential future use and backward compatibility.
  app.use((req, res, next) => {
    const existingClientId = req.cookies?.[CLIENT_STATE_COOKIE];
    const clientId = typeof existingClientId === 'string' && existingClientId.trim().length > 0
      ? existingClientId
      : crypto.randomUUID();

    if (existingClientId !== clientId) {
      res.cookie(CLIENT_STATE_COOKIE, clientId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }

    req.clientId = clientId;
    next();
  });

  // 安全中间件：CSRF令牌生成（在所有路由之前）
  app.use(csrfProtection.tokenMiddleware());

  // 健康检查端点（不需要CSRF保护，也不需要登录）
  app.get('/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      security: {
        csrfEnabled: true,
        pathValidationEnabled: true
      }
    });
  });

  // Client-side log relay — enables collecting browser/device logs
  // on the server, critical for debugging mobile Safari / PWA issues.
  app.post('/api/client-log', (req, res) => {
    const { level, message, data } = req.body ?? {};
    const ts = new Date().toISOString();
    const line = `[client-log ${ts}] [${level ?? 'info'}] ${message ?? ''} ${data ? JSON.stringify(data) : ''}`;
    console.log(line);
    res.json({ ok: true });
  });

  // 鉴权路由（公开：登录 / 登出 / 状态查询）
  app.use('/api/auth', authRoutes);

  // CSRF令牌获取端点（必须先登录后才能拿，避免未授权探测）
  app.get('/api/csrf-token', requireAuth(), csrfProtection.getTokenHandler());

  // 安全中间件：将路径验证器注入到请求对象中
  app.use((req, _res, next) => {
    req.pathValidator = pathValidator;
    next();
  });

  app.get('/api/home', requireAuth(), (_req, res) => {
    res.json({ home: homedir() });
  });

  // 应用鉴权 + CSRF保护（在终端路由之前）
  app.use('/api/terminal', requireAuth());
  app.use('/api/terminal', csrfProtection.verifyMiddleware());

  // 终端路由
  app.use('/api/terminal', terminalRoutes);

  // 文件系统路由（继承 /api/terminal 上的 auth + CSRF 保护）
  app.use('/api/terminal/fs', filesystemRoutes);

  if (fs.existsSync(clientIndexPath)) {
    app.use(express.static(clientDistPath));
    app.get(/^(?!\/api(?:\/|$)|\/health$).*/, (_req, res) => {
      res.sendFile(clientIndexPath);
    });
  }

  return app;
}

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const host = options.host ?? (process.env.HOST || DEFAULT_HOST);
  const app = createApp();
  const server = createServer(app);

  // WebSocket for bidirectional terminal communication.
  // Replaces SSE (server→client) + HTTP POST (client→server) with a single
  // persistent connection per terminal session.
  const wss = new WebSocketServer({ noServer: true });

  const WS_PATH_RE = /^\/api\/terminal\/([^/]+)\/ws$/;
  const CONTROL_WS_PATH = '/api/control/ws';

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Reject the upgrade before the WebSocket handshake completes if auth
    // is enabled and the client cookie is missing/expired. We respond with
    // a real HTTP 401 so the browser surfaces a useful error. Applied to
    // both per-terminal and control paths.
    const cookieHeader = request.headers.cookie;
    if (!isUpgradeRequestAuthenticated(typeof cookieHeader === 'string' ? cookieHeader : undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Control WS: server-pushed global client-state events. One per browser.
    if (pathname === CONTROL_WS_PATH) {
      const clientId = crypto.randomUUID();
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleControlWebSocket(ws, clientId);
      });
      return;
    }

    // Per-terminal WS: bidirectional I/O for a single terminal session.
    const match = pathname.match(WS_PATH_RE);
    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const clientId = crypto.randomUUID();
    // 短线重连时客户端会带上 ?since=<lastSeq>，让服务端只补发增量。
    const sinceParam = url.searchParams.get('since');
    const sinceSeq = sinceParam ? Math.max(0, Number.parseInt(sinceParam, 10) || 0) : 0;

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTerminalWebSocket(ws, sessionId, clientId, { sinceSeq });
    });
  });

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`Termdock server running at http://${displayHost}:${port}`);
    console.log(`Health check: http://${displayHost}:${port}/health`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use.`);
      console.error(`To free it, find and stop the process: lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`);
      process.exit(1);
    }
    console.error('Server error:', error);
    process.exit(1);
  });

  return server;
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  startServer();
}
