// @vitest-environment node
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicSecurity, getPublicOrigin, securityHeaders } from './publicSecurity.js';
import { isAllowedOrigin, isUpgradeOriginAllowed } from './requestSecurity.js';
import { getCookieSecurityOptions, setSecureCookieMode } from './cookieSecurity.js';

vi.mock('./authProtection.js', () => ({ isAuthEnabled: () => Boolean(process.env.TERMDOCK_PASSWORD), readAuthFile: () => null }));
vi.mock('./localAccess.js', () => ({ getLanIPv4Addresses: () => ['192.168.1.2'], localAccessManager: { getState: () => ({ hostname: 'test.termdock.local' }) } }));
afterEach(() => { vi.unstubAllEnvs(); setSecureCookieMode(false); });

describe('public ingress security', () => {
  it('fails closed without auth and for weak env passwords or non-HTTPS origins', () => {
    vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', 'https://term.example.com');
    vi.stubEnv('TERMDOCK_PASSWORD', '');
    expect(assertPublicSecurity).toThrow(/requires authentication/);
    vi.stubEnv('TERMDOCK_PASSWORD', 'short');
    expect(assertPublicSecurity).toThrow(/16 characters/);
    vi.stubEnv('TERMDOCK_PASSWORD', 'a sufficiently strong password');
    expect(assertPublicSecurity).not.toThrow();
    for (const value of ['http://term.example.com', 'https://user@term.example.com', 'https://term.example.com/path']) {
      vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', value);
      expect(getPublicOrigin).toThrow();
    }
  });

  it('requires exact HTTPS origin including port in public mode', () => {
    vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', 'https://term.example.com');
    for (const origin of ['http://term.example.com', 'https://term.example.com:444', 'https://term.example.com.attacker.org', 'null', 'https://localhost', 'ftp://term.example.com']) {
      expect(isAllowedOrigin(origin, 'localhost:9834')).toBe(false);
      expect(isUpgradeOriginAllowed(origin, 'localhost:9834')).toBe(false);
    }
    expect(isAllowedOrigin('https://term.example.com', 'localhost:9834')).toBe(true);
    expect(isUpgradeOriginAllowed(undefined, 'term.example.com')).toBe(false);
    expect(getCookieSecurityOptions().secure).toBe(true);
  });

  it('keeps local Vite proxy origins working without public mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', '');
    expect(isAllowedOrigin('http://192.168.1.2:9833', 'localhost:9835')).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com', 'localhost:9835')).toBe(false);
    expect(isAllowedOrigin('ftp://localhost', 'localhost:9835')).toBe(false);
  });

  it('sends a server-enforced opaque-origin sandbox for direct HTML and SVG navigation', async () => {
    vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', '');
    const app = express();
    app.use(securityHeaders);
    app.use((_req, res) => res.send('<script>fetch("/api/terminal")</script>'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const route of ['/api/terminal/fs/preview/token/tmp/evil.html', '/api/terminal/fs/blob?path=evil.svg', '/api/terminal/fs/eda-preview', '/api/terminal/fs/blob/', '/API/TERMINAL/FS/BLOB/']) {
        const response = await fetch(base + route);
        expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
        expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});


it('rejects same-host cross-port or cross-scheme WebSocket hijacking in production', () => {
  vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', '');
  vi.stubEnv('NODE_ENV', 'production');
  setSecureCookieMode(true);
  expect(isUpgradeOriginAllowed('https://localhost:9834', 'localhost:9834')).toBe(true);
  expect(isUpgradeOriginAllowed('https://localhost:8888', 'localhost:9834')).toBe(false);
  expect(isUpgradeOriginAllowed('http://localhost:9834', 'localhost:9834')).toBe(false);
});
