import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import { RelayClient } from './relay.js';
import { openServiceSocket } from './serviceTransport.js';
import { serviceEndpoint } from './connectionModel.js';
import { verifyDirectTarget } from './directRoutes.js';

export interface FederationRelayConfig {
  entryUrl: string;
  relayToken: string;
  caPath?: string;
  targets: { serviceId: string; url: string; caPath?: string }[];
}
function secureEndpoint(value: string, endpoint: string): string {
  const url = new URL(value);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Federation relay URLs must use HTTPS/WSS without credentials, query or fragment');
  if (url.pathname !== '/' && url.pathname !== endpoint) throw new Error('Federation relay URL must be a service origin or the exact tunnel endpoint');
  return serviceEndpoint(url.origin, endpoint === '/api/federation/relay' ? 'relay' : 'secure').href;
}
export function parseRelayConfig(value: unknown): FederationRelayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relay config');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['entryUrl', 'relayToken', 'caPath', 'targets'].includes(k)) || typeof v.entryUrl !== 'string' || typeof v.relayToken !== 'string' || v.relayToken.length < 32 || /[\r\n]/.test(v.relayToken) || !Array.isArray(v.targets) || !v.targets.length || v.targets.length > 64 || (v.caPath !== undefined && typeof v.caPath !== 'string')) throw new Error('Invalid relay config fields');
  secureEndpoint(v.entryUrl, '/api/federation/relay');
  const seen = new Set<string>();
  for (const target of v.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(k => !['serviceId', 'url', 'caPath'].includes(k)) || typeof target.serviceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(target.serviceId) || typeof target.url !== 'string' || (target.caPath !== undefined && typeof target.caPath !== 'string') || seen.has(target.serviceId)) throw new Error('Invalid or duplicate relay target');
    secureEndpoint(target.url, '/api/federation/secure'); seen.add(target.serviceId);
  }
  return structuredClone(v) as unknown as FederationRelayConfig;
}
async function connect(url: string, ca: Buffer | undefined, sockets: Set<WebSocket>, token?: string, readyHandshake = false, signal?: AbortSignal): Promise<WebSocket> {
  const ws = await openServiceSocket(url, { ca }, { maxPayload: 256 * 1024, handshakeTimeout: 10_000, relayReady: readyHandshake, signal,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  sockets.add(ws); ws.once('close', () => sockets.delete(ws)); return ws;
}
export function pairingInviteUrl(serviceId: string, code: string, value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('配对地址必须是服务的 HTTP(S) 根地址，不含账号、参数或片段。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程配对地址必须使用 HTTPS。');
  if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(serviceId)) throw new Error('Invalid pairing information');
  const origin = url.origin;
  url.hash = 'termdock-invite=' + Buffer.from(JSON.stringify({ v: 1, serviceId, code, entryUrl: origin, serviceUrl: origin })).toString('base64url');
  return url.href;
}

export async function runFederationCli(args: string[]): Promise<number> {
  try {
    if (args[0] === '--federation-pairing') {
      let explicitUrl: string | undefined; let json = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--json' && !json) json = true;
        else if (args[i] === '--url' && explicitUrl === undefined && args[i + 1]) explicitUrl = args[++i];
        else throw new Error('Usage: termdock --federation-pairing [--url https://service:port] [--json]');
      }
      const file = resolve(homedir(), '.termdock/federation/pairing.json');
      if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) throw new Error('配对文件权限异常，请先 chmod 600 配对文件。');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (!data || typeof data.serviceId !== 'string' || typeof data.pairingCode !== 'string') throw new Error('Invalid pairing file; start the service to initialize pairing');
      if (json) {
        process.stdout.write(`${JSON.stringify({ serviceId: data.serviceId, pairingCode: data.pairingCode, ...(explicitUrl ? { url: explicitUrl } : typeof data.url === 'string' ? { url: data.url } : {}) })}\n`);
        return 0;
      }
      let serviceUrl = explicitUrl ?? (typeof data.url === 'string' ? data.url : undefined);
      if (!serviceUrl) {
        try {
          const state = JSON.parse(readFileSync(resolve(homedir(), '.termdock/server.json'), 'utf8'));
          serviceUrl = typeof state.lanUrl === 'string' ? state.lanUrl : typeof state.localUrl === 'string' ? state.localUrl : undefined;
        } catch { /* Require an explicit usable service URL below. */ }
      }
      if (!serviceUrl) throw new Error('请添加 --url https://服务地址:端口，生成可直接打开的配对链接。');
      const invitation = pairingInviteUrl(data.serviceId, data.pairingCode, serviceUrl);
      process.stdout.write(`用新设备打开链接或扫描二维码，即可一次性配对本服务：\n${invitation}\n`);
      process.stdout.write(await QRCode.toString(invitation, { type: 'terminal', small: true }));
      return 0;
    }
    if (args[0] !== '--federation-relay' || args.length !== 2) throw new Error('Usage: termdock --federation-pairing [--url https://service:port] [--json] | termdock --federation-relay <config.json>');
    const configPath = resolve(args[1]);
    if (process.platform !== 'win32' && (statSync(configPath).mode & 0o077) !== 0) throw new Error('Relay config contains a token: chmod 600 the config file first');
    const config = parseRelayConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    const loadCa = (file?: string) => file ? readFileSync(resolve(dirname(configPath), file)) : undefined;
    const entryCa = loadCa(config.caPath);
    const targets = config.targets.map(t => ({ ...t, ca: loadCa(t.caPath ?? config.caPath) }));
    const lifetime = new AbortController();
    const sockets = new Set<WebSocket>(); let stopped = false; let client: RelayClient | undefined; let wake: (() => void) | undefined;
    const stop = () => { stopped = true; lifetime.abort(); wake?.(); client?.close(); for (const socket of sockets) socket.terminate(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    let delay = 1000;
    try {
      while (!stopped) {
        try {
          const upstream = await connect(secureEndpoint(config.entryUrl, '/api/federation/relay'), entryCa, sockets, config.relayToken, true, lifetime.signal);
          if (stopped) { upstream.terminate(); break; }
          const protectedTargets = new Set<string>();
          const verify = (t: typeof targets[number], signal: AbortSignal) => verifyDirectTarget({ serviceId: t.serviceId, url: t.url,
            ...(t.caPath ?? config.caPath ? { caPath: t.caPath ?? config.caPath } : {}) }, dirname(configPath), signal);
          const targetFactories = new Map<string, (signal: AbortSignal) => Promise<WebSocket>>();
          const verification = new AbortController();
          const verificationSignal = AbortSignal.any([lifetime.signal, verification.signal]);
          upstream.once('close', () => verification.abort());
          let refreshTimer: ReturnType<typeof setTimeout> | undefined;
          // A failed proof withdraws the route. A confirmed missing password
          // remains advertised as blocked, so the directory can explain it.
          const refreshTargets = async () => {
            let index = 0;
            await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
              while (!verificationSignal.aborted && index < targets.length) {
                const target = targets[index++];
                let configured: boolean;
                try { await verify(target, verificationSignal); configured = true; }
                catch (error) {
                  if (!(error instanceof Error) || error.message !== 'TARGET_PASSWORD_REQUIRED') {
                    protectedTargets.delete(target.serviceId); targetFactories.delete(target.serviceId); continue;
                  }
                  configured = false;
                }
                if (verificationSignal.aborted) return;
                if (configured) protectedTargets.add(target.serviceId); else protectedTargets.delete(target.serviceId);
                targetFactories.set(target.serviceId, async signal => {
                  await verify(target, AbortSignal.any([signal, verificationSignal]));
                  return connect(serviceEndpoint(target.url, 'relay-target').href, target.ca, sockets, undefined, false, AbortSignal.any([signal, verificationSignal]));
                });
              }
            }));
          };
          try {
            await refreshTargets();
            if (verificationSignal.aborted) throw new Error('Relay disconnected');
            client = new RelayClient(upstream, { routeTtlMs: 4000, isPasswordProtected: id => protectedTargets.has(id), targets: targetFactories });
            const poll = async () => { await refreshTargets(); if (!verificationSignal.aborted) refreshTimer = setTimeout(() => void poll(), 2000); };
            refreshTimer = setTimeout(() => void poll(), 2000);
            process.stderr.write('加密中继已连接。\n'); delay = 1000;
            await new Promise<void>(done => { if (upstream.readyState !== WebSocket.OPEN) done(); else upstream.once('close', () => done()); });
          } finally { verification.abort(); clearTimeout(refreshTimer); }
        } catch { if (!stopped) process.stderr.write('中继连接失败或已断开，将重试；请检查授权和证书。\n'); }
        client?.close(); client = undefined;
        for (const socket of sockets) socket.terminate();
        if (!stopped) await new Promise<void>(done => { const timer = setTimeout(() => { wake = undefined; done(); }, delay); wake = () => { clearTimeout(timer); wake = undefined; done(); }; });
        delay = Math.min(delay * 2, 30_000);
      }
    } finally { stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return 0;
  } catch (error) {
    // Config parsing and network failures must not echo the config or its token.
    const message = error instanceof Error && !('code' in error) && !(error instanceof SyntaxError) ? error.message : '无法读取有效配置或配对信息。';
    process.stderr.write(`${message}\n`); return 1;
  }
}
