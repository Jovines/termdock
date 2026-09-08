import { setPushTargetPeerId } from './notifications/pushService.js';
import { desktopDirectTargets } from './federation/desktopTargets.js';
import { createOpenAccessRouter } from './federation/openAccess.js';
import { createPasswordLoginRouter } from './federation/passwordLoginRoutes.js';
import { apiAccessGate, isTrustedLocalRequest } from './utils/apiAccess.js';
import { isEncryptedRequest } from './federation/requestContext.js';
import { createFederationRuntime } from './federation/runtime.js';
import { RouteAccess, type RoutePrincipal } from './federation/routeAccess.js';
import { RouteInvitationStore } from './federation/routeInvitations.js';
import { attachRegisteredDirectTargets, verifyDirectTarget } from './federation/directRoutes.js';
import { secureChannelOriginAllowed } from './federation/originPolicy.js';
import { RelayRouter } from './federation/relay.js';
import { assertPublicSecurity, securityHeaders } from './utils/publicSecurity.js';
import { apiCachePolicy } from './utils/apiCachePolicy.js';
import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Server as HttpServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createStaticCompressionMiddleware, setStaticCacheHeaders } from './utils/staticAssets.js';
import { homedir } from 'os';
import cookieParser from 'cookie-parser';
import { type SecureContextOptions } from 'tls';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import terminalRoutes, { handleTerminalWebSocket, handleControlWebSocket } from './routes/terminal.js';
import filesystemRoutes from './routes/filesystem.js';
import authRoutes from './routes/auth.js';
import notificationRoutes from './routes/notifications.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { createLocalRouter } from './routes/local.js';
import { csrfProtection } from './utils/csrfProtection.js';
import { pathValidator } from './utils/pathValidator.js';
import { requireAuth, renewSessionMiddleware } from './utils/authProtection.js';
import { localAccessManager, type LocalAccessState } from './utils/localAccess.js';
import {
  isAllowedHost,
  isUpgradeOriginAllowed,
  validateHostMiddleware,
  validateOriginMiddleware,
} from './utils/requestSecurity.js';
import { getCookieSecurityOptions, setSecureCookieMode } from './utils/cookieSecurity.js';
import { requestDeadlineMiddleware } from './utils/requestDeadline.js';
import { RuntimeMonitor } from './utils/runtimeMonitor.js';
import { startOnboardingServer, stopOnboardingServer, getOnboardingServerUrl } from './onboardingServer.js';
import { CertificateWatcher } from './certificateWatcher.js';
import {
  startTermdockLogMaintenance,
  writeDiffTraceLog,
  writeErrorLog,
  writeJsonLog,
  writeTextLog,
} from './utils/serverLogger.js';
import { pinBundledRuntimeClientDist, resolveRuntimeClientDist } from './utils/runtimeClient.js';
import {
  getTermdockVersion,
  TERMDOCK_CAPABILITIES,
  TERMDOCK_PROTOCOL_VERSION,
} from './utils/version.js';

import { PORT, DEFAULT_HOST } from './config.js';

const CLIENT_STATE_COOKIE = 'termdock-client';
export const DEFAULT_PORT = PORT.backend;

const CLIENT_LOG_DEDUP_WINDOW_MS = 5_000;
const CLIENT_LOG_RATE_WINDOW_MS = 10_000;
const CLIENT_LOG_RATE_LIMIT = 120;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const bundledClientDistPath = path.resolve(currentDirPath, '../client');
const bundledClientIndexPath = path.join(bundledClientDistPath, 'index.html');
const clientLogRecent = new Map<string, number>();
let clientLogWindowStartedAt = 0;
let clientLogWindowCount = 0;
let clientLogSuppressedCount = 0;

function getRouteFamily(pathname: string): string {
  if (pathname.startsWith('/api/terminal/fs/')) return 'fs';
  if (pathname.startsWith('/api/terminal/')) return 'terminal';
  if (pathname.startsWith('/api/auth')) return 'auth';
  if (pathname.startsWith('/api/client-log')) return 'client-log';
  if (pathname.startsWith('/api/diagnostics')) return 'diagnostics';
  if (pathname === '/health') return 'health';
  if (pathname.startsWith('/assets/')) return 'asset';
  return 'page';
}

export interface CertificateRefreshResult {
  reloaded: boolean;
  certificateUpdated?: boolean;
  localAccessState?: LocalAccessState;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  httpsCertPath?: string;
  httpsKeyPath?: string;
  httpsCaPath?: string;
  onboardingPort?: number;
  localApiToken?: string;
  onCertificateRefreshNeeded?: (missingNames: string[]) => CertificateRefreshResult | Promise<CertificateRefreshResult>;
}

export interface StartServerResult {
  server: HttpServer;
  scheme: 'http' | 'https';
  getLocalAccessState: () => LocalAccessState;
  getOnboardingUrl: () => string | null;
}

export interface AppOptions {
  secureRequired?: boolean;
  port?: number;
  httpsCaPath?: string;
  localApiToken?: string;
  runtimeMonitor?: RuntimeMonitor;
}

function shouldWriteClientLog(level: unknown, message: unknown): boolean {
  const now = Date.now();
  const importantClientLog = typeof message === 'string' && (
    message.startsWith('DIFF_VIEWER ')
    || message.startsWith('DIFF_LOADING ')
    || message.startsWith('FILE_PREVIEW_LOADING ')
    || message.startsWith('GIT_BUNDLE ')
    || message.startsWith('DIFF_INTERACTION ')
    || message.startsWith('DIFF_API ')
  );
  if (!clientLogWindowStartedAt || now - clientLogWindowStartedAt > CLIENT_LOG_RATE_WINDOW_MS) {
    if (clientLogSuppressedCount > 0) {
      writeTextLog('client.log', `[client-log ${new Date().toISOString()}] [warn] suppressed ${clientLogSuppressedCount} noisy client log(s)`);
    }
    clientLogWindowStartedAt = now;
    clientLogWindowCount = 0;
    clientLogSuppressedCount = 0;
    clientLogRecent.clear();
  }

  if (importantClientLog) {
    return true;
  }

  clientLogWindowCount += 1;
  if (clientLogWindowCount > CLIENT_LOG_RATE_LIMIT) {
    clientLogSuppressedCount += 1;
    return false;
  }

  const key = `${String(level ?? 'info')}\u0000${String(message ?? '')}`;
  const last = clientLogRecent.get(key);
  if (last && now - last < CLIENT_LOG_DEDUP_WINDOW_MS) {
    clientLogSuppressedCount += 1;
    return false;
  }
  clientLogRecent.set(key, now);
  return true;
}

function getDiffTraceSource(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  if (message.startsWith('DIFF_INTERACTION ')) return 'client.interaction';
  if (message.startsWith('DIFF_LOADING ')) return 'client.loading';
  if (message.startsWith('DIFF_VIEWER ')) return 'client.viewer';
  if (message.startsWith('DIFF_API ')) return 'client.api';
  if (message.startsWith('FILE_PREVIEW_LOADING ')) return 'client.file-preview';
  if (message.startsWith('GIT_BUNDLE ')) return 'client.git-bundle';
  return null;
}

function getDiffTraceEvent(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const spaceIndex = message.indexOf(' ');
  if (spaceIndex < 0) return message;
  return message.slice(spaceIndex + 1);
}

export function createApp(options: AppOptions = {}): express.Express {
  assertPublicSecurity();
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.use(validateHostMiddleware);
  if (options.secureRequired) app.use('/api/auth/open', createOpenAccessRouter(() => app.locals.passwordRuntime?.serviceId));
  if (options.secureRequired) app.use('/api/auth/password', createPasswordLoginRouter(() => app.locals.passwordRuntime));

  app.use('/api', (req, res, next) => {
    if (!options.secureRequired || isEncryptedRequest(req) || isTrustedLocalRequest(req, options.localApiToken)) return next();
    if (req.method === 'GET' && ['/meta', '/auth/status'].includes(req.path)) return next();
    res.status(426).json({ error: 'Pair this device to use an encrypted connection', code: 'E2EE_REQUIRED' });
  });

  // Authenticate before allocating request bodies, including future API routes.
  app.use(cookieParser());
  app.use('/api', renewSessionMiddleware);
  app.use('/api', apiAccessGate(options.localApiToken));
  // 基础中间件
  app.use('/api/auth', express.json({ limit: '2kb' }));
  app.use(express.json({ limit: '5mb' }));

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

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const pathname = (() => {
      try {
        return new URL(req.originalUrl || req.url, 'http://localhost').pathname;
      } catch {
        return req.path || req.url || '';
      }
    })();
    const logPathname = pathname.replace(/(\/fs\/preview\/)[0-9a-f]{32}(?=\/)/gi, '$1[redacted]');
    const routeFamily = getRouteFamily(pathname);
    let logged = false;
    const log = (event: 'finish' | 'close') => {
      if (logged) return;
      logged = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      options.runtimeMonitor?.recordRequest(res.statusCode, durationMs);
      writeJsonLog('access.log', {
        event,
        method: req.method,
        path: logPathname,
        routeFamily,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        contentLength: res.getHeader('Content-Length') ?? null,
        clientId: req.clientId,
        closedBeforeFinish: event === 'close' && !res.writableEnded,
      });
      if (res.statusCode >= 400 || (event === 'close' && !res.writableEnded)) {
        writeErrorLog({
          source: 'access',
          event,
          method: req.method,
          path: logPathname,
          routeFamily,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          clientId: req.clientId,
          closedBeforeFinish: event === 'close' && !res.writableEnded,
        });
      }
    };
    res.on('finish', () => log('finish'));
    res.on('close', () => {
      if (!res.writableEnded) log('close');
    });
    next();
  });

  // 全局请求兜底超时：任何 handler 挂起最多活 30s（长连接流按表豁免），
  // 到期销毁 socket 释放浏览器连接槽。必须在所有路由与静态资源之前挂载。
  app.use(requestDeadlineMiddleware());

  app.use('/api', apiCachePolicy);

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

  // Public, non-sensitive capability handshake used by desktop clients before
  // navigating to a local or remote Termdock service. Keep this endpoint
  // backwards-compatible: older desktops only require /health, while newer
  // clients can use protocolVersion/capabilities for feature gating.
  app.get('/api/meta', (_req, res) => {
    res.json({
      product: 'termdock',
      version: getTermdockVersion(),
      protocolVersion: TERMDOCK_PROTOCOL_VERSION,
      capabilities: TERMDOCK_CAPABILITIES,
      desktopManaged: process.env.TERMDOCK_DESKTOP === '1',
    });
  });

  // Client-side log relay — enables collecting browser/device logs
  // on the server, critical for debugging mobile Safari / PWA issues.
  app.post('/api/client-log', requireAuth(), validateOriginMiddleware, (req, res) => {
    const { level, message, data } = req.body ?? {};
    if (!shouldWriteClientLog(level, message)) {
      res.json({ ok: true, suppressed: true });
      return;
    }
    const ts = new Date().toISOString();
    const line = `[client-log ${ts}] [${level ?? 'info'}] ${message ?? ''} ${data ? JSON.stringify(data) : ''}`;
    writeTextLog('client.log', line);
    const diffTraceSource = getDiffTraceSource(message);
    if (diffTraceSource) {
      writeDiffTraceLog({
        source: diffTraceSource,
        event: getDiffTraceEvent(message),
        level: level ?? 'info',
        traceId: data?.traceId,
        interactionId: data?.interactionId,
        filePath: data?.filePath ?? data?.selectedFilePath ?? data?.requestedPath,
        requestPath: data?.requestPath,
        cwd: data?.cwd,
        gitRoot: data?.gitRoot,
        data,
      });
    }
    res.json({ ok: true });
  });

  app.use('/api/local', createLocalRouter({ token: options.localApiToken }));

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

  app.use('/api/notifications', requireAuth());
  app.use('/api/notifications', csrfProtection.verifyMiddleware());
  app.use('/api/notifications', notificationRoutes);

  // 安全中间件：将路径验证器注入到请求对象中
  app.use((req, _res, next) => {
    req.pathValidator = pathValidator;
    next();
  });

  app.get('/api/home', requireAuth(), (_req, res) => {
    res.json({ home: homedir() });
  });

  // A locally installed Agent/plugin CLI uses the mode-0600 local API token.
  // Keep this bypass loopback-only: possession of the token must not turn the
  // LAN-facing terminal API into a bearer-token endpoint.
  const isTrustedLocalCliRequest = (req: express.Request): boolean => isTrustedLocalRequest(req, options.localApiToken);

  app.get('/api/diagnostics/runtime', requireAuth({ bypass: isTrustedLocalCliRequest }), async (_req, res) => {
    if (!options.runtimeMonitor) {
      res.status(503).json({ error: 'Runtime monitor is not active', code: 'RUNTIME_MONITOR_INACTIVE' });
      return;
    }
    res.json(await options.runtimeMonitor.diagnostics());
  });

  // 应用鉴权 + CSRF保护（在终端路由之前）
  // The HTML preview route authenticates itself: document requests use the
  // session cookie, then get redirected to a short-lived URL token so the
  // sandboxed iframe's subresource requests (which browsers refuse to send
  // cookies for) can still load images/css/js.
  app.use('/api/terminal', requireAuth({ bypass: (req) => /^\/fs\/preview\//i.test(req.path) || isTrustedLocalCliRequest(req) }));
  app.use('/api/terminal', csrfProtection.verifyMiddleware({ bypass: isTrustedLocalCliRequest }));

  // 终端路由
  app.use('/api/terminal', terminalRoutes);

  // 文件系统路由（继承 /api/terminal 上的 auth + CSRF 保护）
  app.use('/api/terminal/fs', filesystemRoutes);

  if (fs.existsSync(bundledClientIndexPath)) {
    const selectedClientPath = resolveRuntimeClientDist(bundledClientDistPath);
    const clientPath = selectedClientPath === bundledClientDistPath
      ? pinBundledRuntimeClientDist(bundledClientDistPath)
      : selectedClientPath;
    const compression = createStaticCompressionMiddleware(clientPath);
    const staticFiles = express.static(clientPath, {
      setHeaders: (res, filePath, stat) => {
        void stat;
        const relativePath = `/${path.relative(clientPath, filePath).split(path.sep).join('/')}`;
        setStaticCacheHeaders({ url: relativePath, path: relativePath } as express.Request, res);
      },
    });
    app.use((req, res, next) => {
      compression(req, res, (compressionError) => {
        if (compressionError) return next(compressionError);
        staticFiles(req, res, next);
      });
    });
    app.get(/^(?!\/api(?:\/|$)|\/health$|\/onboarding(?:\/|$)|\/ca(?:\/|$)).*/, (req, res) => {
      setStaticCacheHeaders(req, res);
      res.sendFile(path.join(clientPath, 'index.html'));
    });
  }

  // Never expose parser errors, submitted passwords, or stack traces to callers.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    const candidate = (error as { status?: unknown })?.status;
    const status = typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500;
    res.status(status).json({ error: status === 413 ? 'Request body too large' : status < 500 ? 'Invalid request' : 'Internal server error', code: 'REQUEST_ERROR' });
  });
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
  assertPublicSecurity();
  const stopLogMaintenance = startTermdockLogMaintenance();
  const port = options.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const host = options.host ?? (process.env.HOST || DEFAULT_HOST);
  if (process.env.TERMDOCK_PUBLIC_ORIGIN && !(options.httpsCertPath && options.httpsKeyPath) && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Public access requires HTTPS certificates, or a loopback-only listener behind a TLS proxy.');
  }
  const runtimeMonitor = new RuntimeMonitor({
    stateDirectory: path.join(homedir(), '.termdock'),
    historyPath: path.join(homedir(), '.termdock', 'runtime-metrics.log'),
  });
  runtimeMonitor.start();
  const app = createApp({
    secureRequired: true,
    port: options.onboardingPort ?? port,
    httpsCaPath: options.httpsCaPath,
    localApiToken: options.localApiToken,
    runtimeMonitor,
  });
  const { server, scheme } = createServerForApp(app, options);
  let entrySubjectAllowed = (_subjectId: string) => false;
  let routeInvitations: RouteInvitationStore | undefined;
  let federationServiceId = '';
  const desktopTargets = () => desktopDirectTargets(path.join(homedir(), '.termdock', 'desktop.json'), federationServiceId);
  const routeAccess = new RouteAccess(path.join(homedir(), '.termdock', 'federation', 'routes.json'), Date.now,
    (subjectId, targetServiceId) => routeInvitations?.allows(subjectId, targetServiceId) === true, desktopTargets);
  const relayRouter = new RelayRouter<RoutePrincipal>({
    authenticate: context => context as RoutePrincipal,
    allowRegister: (principal, serviceId) => routeAccess.allowRegister(principal, serviceId),
    allowRoute: (principal, serviceId) => routeAccess.allowRoute(principal, serviceId),
  });
  const dynamicDirectTargets = new Map<string, { signature: string; close: () => void }>();
  const refreshDirectTargets = () => {
    const desired = new Map(routeAccess.configuredDirectTargets().filter(target => target.serviceId !== federationServiceId).map(target => [target.serviceId, target]));
    for (const [id, registered] of dynamicDirectTargets) {
      const target = desired.get(id);
      if (!target || registered.signature !== JSON.stringify([target.url, target.caPath, target.caFingerprint256])) {
        registered.close(); dynamicDirectTargets.delete(id);
      }
    }
    for (const [id, target] of desired) if (!dynamicDirectTargets.has(id)) {
      try {
        dynamicDirectTargets.set(id, { signature: JSON.stringify([target.url, target.caPath, target.caFingerprint256]), close: attachRegisteredDirectTargets(relayRouter, [target], path.join(homedir(), '.termdock', 'federation')) });
      } catch { /* A malformed or unavailable local route remains unusable. */ }
    }
  };
  refreshDirectTargets();
  const desktopRoutesTimer = setInterval(refreshDirectTargets, 2000); desktopRoutesTimer.unref();
  server.once('close', () => { clearInterval(desktopRoutesTimer); for (const target of dynamicDirectTargets.values()) target.close(); });
  server.once('close', () => relayRouter.close());
  const federation = createFederationRuntime(app, path.join(homedir(), '.termdock', 'federation'), {
    terminal: handleTerminalWebSocket, control: handleControlWebSocket,
  }, {
    listRouteTargets: () => { refreshDirectTargets(); return routeAccess.configuredTargets().map(target => ({ ...target, available: relayRouter.hasRoute(target.serviceId) })); },
    listRouteAccess: () => routeInvitations?.list() || [],
    grantRouteAccess: async (issuerId, targetServiceId, subjectId, url) => {
      if (!routeInvitations) throw new Error('ROUTE_NOT_AVAILABLE');
      if (!routeAccess.hasConfiguredTarget(targetServiceId)) {
        if (!url) throw new Error('ROUTE_TARGET_NOT_CONFIGURED');
        const target = { serviceId: targetServiceId, url };
        await verifyDirectTarget(target);
        const runtime = await federation;
        if (!runtime.store.authorize({ subjectId: issuerId, serviceId: runtime.serviceId, action: 'authorization.manage' }).allowed) throw new Error('AUTHORIZATION_DENIED');
        routeAccess.addDirectTarget(target);
        refreshDirectTargets();
      }
      return routeInvitations.grant(issuerId, targetServiceId, subjectId);
    },
    revokeRouteAccess: id => routeInvitations?.revoke(id) || false,
    issueRouteTicket: (subjectId: string, serviceId: string) => routeAccess.issueRouteTicket(subjectId, serviceId),
    hasRouteGrant: (subjectId: string, serviceId: string) => routeInvitations?.allows(subjectId, serviceId) === true,
    createRouteInvitation: (issuerId: string, serviceId: string) => {
      if (!routeInvitations) throw new Error('ROUTE_NOT_AVAILABLE');
      return routeInvitations.create(issuerId, serviceId);
    },
    consumeRouteInvitation: (code: string, subjectId: string) => {
      if (!routeInvitations) throw new Error('ROUTE_NOT_AVAILABLE');
      return routeInvitations.consume(code, subjectId);
    },
  });
  void federation.then(runtime => {
    federationServiceId = runtime.serviceId; setPushTargetPeerId(runtime.serviceId); refreshDirectTargets();
    app.locals.passwordRuntime = runtime;
    entrySubjectAllowed = subjectId => runtime.store.authorize({ subjectId, serviceId: runtime.serviceId, action: 'authorization.manage' }).allowed;
    routeInvitations = new RouteInvitationStore({
      filePath: path.join(homedir(), '.termdock', 'federation', 'route-invitations.json'), serviceId: runtime.serviceId,
      issuerAllowed: subjectId => entrySubjectAllowed(subjectId),
      targetAvailable: serviceId => routeAccess.hasConfiguredTarget(serviceId) && relayRouter.hasRoute(serviceId),
    });
  }).catch(() => console.error('Route invitations unavailable; uninitialized route grants remain denied.'));
  void federation.catch(() => console.error('Encrypted access initialization failed; business access remains closed.'));
  server.once('close', () => { void federation.then(runtime => runtime.close()).catch(() => {}); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 1024;
  server.on('connection', (socket) => runtimeMonitor.trackSocket(socket));
  server.once('close', () => runtimeMonitor.stop());
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
      const shouldReloadFromDisk = result?.certificateUpdated === true
        || !options.onCertificateRefreshNeeded;
      const reloaded = result?.reloaded === true
        || (shouldReloadFromDisk && reloadHttpsCertificate(server, options));
      if (!reloaded) {
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
    maxPayload: 1024 * 1024,
    perMessageDeflate: {
      threshold: 1024,
      concurrencyLimit: 10,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
    },
  });


  server.on('upgrade', (request, socket, head) => {
    if (wss.clients.size >= 256) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!isAllowedHost(request.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? '/', `${scheme}://${request.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    if (pathname === '/api/federation/relay') {
      // A paired device can use B from another HTTPS PWA origin. This channel
      // ignores cookies: the single-use target-scoped ticket below is mandatory.
      if (scheme !== 'https' || !secureChannelOriginAllowed(request.headers.origin, () => isUpgradeOriginAllowed(request.headers.origin, request.headers.host))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      const principal = routeAccess.authenticate(request.headers.authorization, url.searchParams.get('routeToken'));
      if (!principal) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(request, socket, head, ws => {
        void relayRouter.attach(ws, principal).then(attached => { if (attached) ws.send(JSON.stringify({ type: 'ready' })); });
      });
      return;
    }
    if (pathname === '/api/federation/secure') {
      // This exception applies only to the cookie-independent Noise handshake.
      // Target pinning and device authorization remain mandatory inside it.
      if (!secureChannelOriginAllowed(request.headers.origin, () => isUpgradeOriginAllowed(request.headers.origin, request.headers.host))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        void federation.then(runtime => runtime.accept(ws, { allowOpenAccess: !!request.headers.origin && isUpgradeOriginAllowed(request.headers.origin, request.headers.host) })).catch(() => ws.close(1011, 'Encrypted access unavailable'));
      });
      return;
    }

    // Business WebSockets have no plaintext fallback after pairing migration.
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    return;


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
    stopLogMaintenance();
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
