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

export function isUpgradeOriginAllowed(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  return isAllowedOrigin(originHeader, hostHeader);
}
