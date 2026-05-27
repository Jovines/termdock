import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import terminalRoutes, { handleTerminalWebSocket } from './routes/terminal.js';
import { csrfProtection } from './utils/csrfProtection.js';
import { pathValidator } from './utils/pathValidator.js';

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

  // 健康检查端点（不需要CSRF保护）
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

  // CSRF令牌获取端点
  app.get('/api/csrf-token', csrfProtection.getTokenHandler());

  // 安全中间件：将路径验证器注入到请求对象中
  app.use((req, _res, next) => {
    req.pathValidator = pathValidator;
    next();
  });

  app.get('/api/home', (_req, res) => {
    res.json({ home: homedir() });
  });

  // 应用CSRF保护（在终端路由之前）
  app.use('/api/terminal', csrfProtection.verifyMiddleware());

  // 终端路由
  app.use('/api/terminal', terminalRoutes);

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

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const match = url.pathname.match(WS_PATH_RE);

    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const clientId = crypto.randomUUID();

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTerminalWebSocket(ws, sessionId, clientId);
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
