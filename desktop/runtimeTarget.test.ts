import { describe, expect, it } from 'vitest';
import { isOwnedDesktopRuntimeTarget } from './runtimeTarget.js';

const localAddresses = new Set(['192.168.8.200', 'fe80::1234']);

describe('desktop Runtime target ownership', () => {
  it.each([
    ['loopback HTTP', 'http://localhost:9834'],
    ['loopback HTTPS', 'https://127.0.0.1:9834'],
    ['local LAN IPv4', 'https://192.168.8.200:9834'],
    ['local LAN IPv6', 'https://[fe80::1234]:9834'],
  ])('recognizes a Desktop-managed service on %s', (_label, origin) => {
    expect(isOwnedDesktopRuntimeTarget({
      origin,
      servicePort: 9834,
      desktopManaged: true,
      localAddresses,
    })).toBe(true);
  });

  it.each([
    ['same-machine npm service', 'https://localhost:9834', false],
    ['remote npm service', 'https://192.168.8.88:9834', false],
    ['remote Desktop service', 'https://192.168.8.88:9834', true],
    ['different local port', 'https://localhost:9835', true],
    ['invalid origin', 'not a URL', true],
  ])('leaves %s under the connected service control plane', (_label, origin, desktopManaged) => {
    expect(isOwnedDesktopRuntimeTarget({
      origin,
      servicePort: 9834,
      desktopManaged,
      localAddresses,
    })).toBe(false);
  });
});
