import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Server as HttpServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { homedir } from 'os';
import cookieParser from 'cookie-parser';
import { type SecureContextOptions } from 'tls';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import terminalRoutes, { handleTerminalWebSocket, handleControlWebSocket } from './routes/terminal.js';
import filesystemRoutes from './routes/filesystem.js';
import authRoutes from './routes/auth.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { csrfProtection } from './utils/csrfProtection.js';
import { pathValidator } from './utils/pathValidator.js';
import { isUpgradeRequestAuthenticated, requireAuth } from './utils/authProtection.js';
import { localAccessManager, type LocalAccessState } from './utils/localAccess.js';
import {
  isAllowedHost,
  isUpgradeOriginAllowed,
  validateHostMiddleware,
} from './utils/requestSecurity.js';
import { getCookieSecurityOptions, setSecureCookieMode } from './utils/cookieSecurity.js';
import { startOnboardingServer, stopOnboardingServer, getOnboardingServerUrl } from './onboardingServer.js';
import { CertificateWatcher } from './certificateWatcher.js';

import { PORT, DEFAULT_HOST } from './config.js';

const CLIENT_STATE_COOKIE = 'termdock-client';
export const DEFAULT_PORT = PORT.backend;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const clientDistPath = path.resolve(currentDirPath, '../client');
const clientIndexPath = path.join(clientDistPath, 'index.html');

export interface CertificateRefreshResult {
  reloaded: boolean;
  localAccessState?: LocalAccessState;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  httpsCertPath?: string;
  httpsKeyPath?: string;
  httpsCaPath?: string;
  onboardingPort?: number;
  onCertificateRefreshNeeded?: (missingNames: string[]) => CertificateRefreshResult | Promise<CertificateRefreshResult>;
}

export interface StartServerResult {
  server: HttpServer;
  scheme: 'http' | 'https';
  getLocalAccessState: () => LocalAccessState;
  getOnboardingUrl: () => string | null;
}

export interface AppOptions {
  port?: number;
  httpsCaPath?: string;
}

// 静态资源压缩中间件（零依赖，用 Node 内置 zlib）。
// 动机：跨城/弱网首刷（或 PWA SW 更新后）要下载未压缩的 JS/CSS bundle，
// express.static 默认不压缩。这里对文本类资源做 br/gzip 压缩，跨城下能把
// bundle 下载体积砍到 ~1/4，明显缩短首屏等待。
// 设计要点：
//  - 只压文本类扩展名；图片/字体/woff2 等已是压缩格式，跳过避免做无用功。
//  - 编译产物在运行期不变，按 (绝对路径 + mtimeMs + 编码) 缓存压缩结果到内存，
//    只在第一次请求时压一次，后续直接命中，不占 CPU。
//  - 路径必须落在 dist 目录内且文件真实存在，否则交回后续中间件（含 SPA
//    fallback），不影响 index.html 路由与 /api 等。
const COMPRESSIBLE_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.map', '.txt']);
// 扩展名 → Content-Type。自己维护一张小表，不依赖 express.static.mime
// （express 5 运行期不暴露该字段，访问会抛 TypeError）。
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
function createStaticCompressionMiddleware(rootDir: string): express.RequestHandler {
  const resolvedRoot = path.resolve(rootDir);
  const cache = new Map<string, { encoding: 'br' | 'gzip'; body: Buffer; mtimeMs: number }>();

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const useBr = /\bbr\b/.test(acceptEncoding);
    const useGzip = /\bgzip\b/.test(acceptEncoding);
    if (!useBr && !useGzip) return next();

    // 解析并防目录穿越：只服务 dist 内的文件。
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return next();
    }
    const ext = path.extname(pathname).toLowerCase();
    if (!COMPRESSIBLE_EXT.has(ext)) return next();

    const filePath = path.resolve(resolvedRoot, '.' + pathname);
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) return next();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    const encoding: 'br' | 'gzip' = useBr ? 'br' : 'gzip';
    const cacheKey = `${filePath}|${encoding}`;
    let entry = cache.get(cacheKey);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      let raw: Buffer;
      try {
        raw = fs.readFileSync(filePath);
      } catch {
        return next();
      }
      const body = encoding === 'br'
        ? zlib.brotliCompressSync(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          })
        : zlib.gzipSync(raw, { level: 7 });
      entry = { encoding, body, mtimeMs: stat.mtimeMs };
      cache.set(cacheKey, entry);
    }

    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    const type = CONTENT_TYPE_BY_EXT[ext];
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', entry.body.length);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(entry.body);
  };
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();

  app.use(validateHostMiddleware);

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
        ...getCookieSecurityOptions(),
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

  // 手机首次接入引导（未信任 CA 前需要从 HTTP 内网页面下载证书）
  app.use('/onboarding', createOnboardingRouter({ port: options.port, caCertPath: options.httpsCaPath }));
  app.get('/ca', (_req, res) => {
    if (!options.httpsCaPath || !fs.existsSync(options.httpsCaPath)) {
      res.status(404).json({ error: 'CA certificate is not configured', code: 'CA_NOT_CONFIGURED' });
      return;
    }
    res.download(options.httpsCaPath, 'rootCA.pem');
  });

  // 鉴权路由（公开：登录 / 登出 / 状态查询）
  app.use('/api/auth/logout', csrfProtection.verifyMiddleware());
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
    app.use(createStaticCompressionMiddleware(clientDistPath));
    app.use(express.static(clientDistPath));
    app.get(/^(?!\/api(?:\/|$)|\/health$|\/onboarding(?:\/|$)|\/ca(?:\/|$)).*/, (_req, res) => {
      res.sendFile(clientIndexPath);
    });
  }

  return app;
}

function createServerForApp(app: express.Express, options: ServerOptions): { server: HttpServer; scheme: 'http' | 'https' } {
  if (options.httpsCertPath && options.httpsKeyPath) {
    const cert = fs.readFileSync(options.httpsCertPath);
    const key = fs.readFileSync(options.httpsKeyPath);
    return { server: createHttpsServer({ cert, key }, app), scheme: 'https' };
  }
  return { server: createHttpServer(app), scheme: 'http' };
}

function reloadHttpsCertificate(server: HttpServer, options: ServerOptions): boolean {
  if (!options.httpsCertPath || !options.httpsKeyPath || typeof (server as { setSecureContext?: unknown }).setSecureContext !== 'function') {
    return false;
  }
  const cert = fs.readFileSync(options.httpsCertPath);
  const key = fs.readFileSync(options.httpsKeyPath);
  (server as unknown as { setSecureContext: (options: SecureContextOptions) => void }).setSecureContext({ cert, key });
  return true;
}

export function startServer(options: ServerOptions = {}): StartServerResult {
  const port = options.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const host = options.host ?? (process.env.HOST || DEFAULT_HOST);
  const app = createApp({ port: options.onboardingPort ?? port, httpsCaPath: options.httpsCaPath });
  const { server, scheme } = createServerForApp(app, options);
  setSecureCookieMode(scheme === 'https');
  const certWatcher = new CertificateWatcher({
    enabled: scheme === 'https' && Boolean(options.httpsCertPath && options.httpsKeyPath),
    certPath: options.httpsCertPath,
    keyPath: options.httpsKeyPath,
    caPath: options.httpsCaPath,
  });
  certWatcher.on('refresh-needed', (missingNames: string[]) => {
    void (async () => {
      const result = await options.onCertificateRefreshNeeded?.(missingNames);
      if (!result?.reloaded && !reloadHttpsCertificate(server, options)) {
        console.warn('[cert-watch] certificate refresh requested but HTTPS context could not be reloaded');
        certWatcher.markRefreshComplete(missingNames, false);
        return;
      }
      if (result?.localAccessState) {
        latestLocalAccessState = result.localAccessState;
        latestOnboardingUrl = getOnboardingServerUrl();
      }
      certWatcher.markRefreshComplete(missingNames, true);
      console.log('[cert-watch] HTTPS certificate context reloaded');
    })().catch((error) => {
      certWatcher.markRefreshComplete(missingNames, false);
      console.error('[cert-watch] failed to handle certificate refresh:', error);
    });
  });
  certWatcher.start();

  let latestLocalAccessState = localAccessManager.getState();
  let latestOnboardingUrl: string | null = null;

  // WebSocket for bidirectional terminal communication.
  // Replaces SSE (server→client) + HTTP POST (client→server) with a single
  // persistent connection per terminal session.
  //
  // perMessageDeflate: 终端输出是纯文本，压缩比通常 5-10x。弱网/跨城（高 RTT、
  // 低带宽）下，刷新页面时 N 个终端各自一次性回放全量 scrollback（每个可达
  // 100KB），未压缩会同时挤满链路、肉眼可见地卡几秒。开启压缩后带宽需求直接
  // 降到 1/5~1/10。参数：
  //  - threshold 1024：小于 1KB 的小包（按键回显等）不压缩，避免 CPU 浪费。
  //  - concurrencyLimit：限制并发压缩任务，防止突发回放打满 CPU。
  //  - zlib memLevel 7 + level 6：在压缩比和内存/CPU 间取均衡，避免每连接
  //    分配过大 zlib 上下文（默认 memLevel 8 内存更高）。
  //  - serverNoContextTakeover：每条消息独立压缩上下文，降低长连接常驻内存。
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
      concurrencyLimit: 10,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
    },
  });

  const WS_PATH_RE = /^\/api\/terminal\/([^/]+)\/ws$/;
  const CONTROL_WS_PATH = '/api/control/ws';

  server.on('upgrade', (request, socket, head) => {
    if (!isAllowedHost(request.headers.host) || !isUpgradeOriginAllowed(request.headers.origin, request.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(request.url ?? '/', `${scheme}://${request.headers.host ?? 'localhost'}`);
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
    console.log(`Termdock server running at ${scheme}://${displayHost}:${port}`);
    console.log(`Health check: ${scheme}://${displayHost}:${port}/health`);
    const onboardingServerState = scheme === 'https'
      ? startOnboardingServer({ httpsPort: port, caCertPath: options.httpsCaPath })
      : { server: null, url: null };
    void localAccessManager.start({ host, port, scheme, caCertPath: options.httpsCaPath, onboardingPort: options.onboardingPort ?? port }).then((state) => {
      const publishState = () => {
        const onboardingUrl = onboardingServerState.url ?? state.onboardingUrl;
        latestLocalAccessState = state;
        latestOnboardingUrl = onboardingUrl;
        if (state.status === 'active') {
          console.log(`LAN access: ${state.url}`);
          if (onboardingUrl) console.log(`Mobile setup: ${onboardingUrl} (open this on your phone to download the CA certificate)`);
        } else {
          console.log(`LAN access: ${state.status}${state.reason ? ` (${state.reason})` : ''}`);
        }
      };
      if (onboardingServerState.server && !onboardingServerState.url) {
        onboardingServerState.server.once('listening', publishState);
      } else {
        publishState();
      }
    }).catch((error) => {
      console.warn('[local-access] failed to start:', error);
    });
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

  server.on('close', () => {
    certWatcher.stop();
    stopOnboardingServer();
    void localAccessManager.stop();
  });

  return {
    server,
    scheme,
    getLocalAccessState: () => latestLocalAccessState,
    getOnboardingUrl: () => latestOnboardingUrl,
  };
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  startServer();
}
