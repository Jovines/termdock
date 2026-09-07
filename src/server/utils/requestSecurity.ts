import { shouldUseSecureCookies } from './cookieSecurity.js';
import { getPublicOrigin } from './publicSecurity.js';
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

// 额外主机白名单：TERMDOCK_ALLOWED_HOSTS=逗号分隔的主机名/IP（带端口也行，
// 端口会被剥掉）。用于公网域名 / 反向代理 / 内网穿透等默认白名单覆盖不到的入口，
// 例如 TERMDOCK_ALLOWED_HOSTS=term.example.com,10.8.0.2
let cachedEnvHosts: { raw: string; hosts: string[] } | null = null;
function getEnvExtraHosts(): string[] {
  const raw = process.env.TERMDOCK_ALLOWED_HOSTS ?? '';
  if (!cachedEnvHosts || cachedEnvHosts.raw !== raw) {
    cachedEnvHosts = {
      raw,
      hosts: raw
        .split(',')
        .map((entry) => stripPort(entry.trim().toLowerCase()))
        .filter((entry) => entry.length > 0),
    };
  }
  return cachedEnvHosts.hosts;
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
  for (const host of getEnvExtraHosts()) {
    hosts.add(host);
  }
  const publicOrigin = getPublicOrigin();
  if (publicOrigin) hosts.add(new URL(publicOrigin).hostname);
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

export function isAllowedOrigin(originHeader: string | undefined, _hostHeader: string | undefined): boolean {
  // Non-browser API clients may omit Origin; cookie-authenticated mutations
  // additionally require CSRF tokens. Browsers cannot forge this header.
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== originHeader) return false;
    const publicOrigin = getPublicOrigin();
    if (publicOrigin) return origin.origin === publicOrigin;
    if (!getAllowedHosts().has(stripPort(origin.host))) return false;
    // Only the development proxy intentionally changes Host/port. On normal
    // listeners, another service on the same LAN host is a different origin.
    if (process.env.NODE_ENV === 'development') return true;
    return origin.host.toLowerCase() === (_hostHeader ?? '').toLowerCase() &&
      origin.protocol === (shouldUseSecureCookies() ? 'https:' : 'http:');
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

export function isUpgradeOriginAllowed(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (getPublicOrigin() && !originHeader) return false;
  return isAllowedOrigin(originHeader, hostHeader);
}
