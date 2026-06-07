import type { NextFunction, Request, Response } from 'express';
import { getLanIPv4Addresses, localAccessManager } from './localAccess.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function stripPort(hostHeader: string | undefined): string {
  const raw = (hostHeader ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(':')[0] ?? raw;
}

export function getAllowedHosts(): Set<string> {
  const hosts = new Set<string>(LOOPBACK_HOSTS);
  for (const address of getLanIPv4Addresses()) {
    hosts.add(address.toLowerCase());
  }
  const localAccess = localAccessManager.getState();
  if (localAccess.hostname) {
    hosts.add(localAccess.hostname.toLowerCase());
  }
  return hosts;
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  const host = stripPort(hostHeader);
  if (!host) return false;
  return getAllowedHosts().has(host);
}

export function validateHostMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isAllowedHost(req.headers.host)) {
    res.status(421).json({ error: 'Host is not allowed', code: 'HOST_NOT_ALLOWED' });
    return;
  }
  next();
}

export function isAllowedOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (!originHeader) return true;
  if (!isAllowedHost(hostHeader)) return false;
  try {
    const origin = new URL(originHeader);
    const originHost = stripPort(origin.host);
    const requestHost = stripPort(hostHeader);
    if (originHost !== requestHost) return false;
    return getAllowedHosts().has(originHost);
  } catch {
    return false;
  }
}

export function validateOriginMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  next();
}

export function isUpgradeOriginAllowed(originHeader: string | undefined, _hostHeader: string | undefined): boolean {
  // WS 升级请求：Origin 头是浏览器实际发出的（不可伪造），而 Host 头可能被前置代理改写。
  // 在 dev 模式下 Vite proxy (9833 → 9835) 用 changeOrigin: true 会把 Host 改写成
  // `localhost:9835`，但 Origin 仍是 `http://192.168.x.x:9833`。这种 mismatch
  // 会让正常 LAN 访问全部 403、WS 退化为持续 reconnecting。
  // 这里只要求 origin host 落在 allowedHosts 里（loopback + LAN IPv4 + mDNS 域名），
  // 不强制等于 request.headers.host。Origin 校验保持原强度（必须能解析出 host、
  // 且 host 在白名单内），所以攻击者把 Origin 改成任意地址仍然过不了。
  if (!originHeader) return true;
  try {
    const originHost = stripPort(new URL(originHeader).host);
    if (!originHost) return false;
    return getAllowedHosts().has(originHost);
  } catch {
    return false;
  }
}
