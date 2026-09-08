import { describe, expect, it } from 'vitest';
import { canReadLocalInvite, type LocalInviteContext } from './localInviteGuard.js';
const valid: LocalInviteContext = { registeredOrigin: 'http://localhost:9834', currentUrl: 'http://localhost:9834/', mainFrame: true, running: true, desktopManaged: true, servicePort: 9834 };
describe('local desktop bootstrap invitation guard', () => {
  it('allows only the managed top-level loopback application', () => {
    expect(canReadLocalInvite(valid)).toBe(true);
    expect(canReadLocalInvite({ ...valid, currentUrl: 'http://localhost:9834/index.html' })).toBe(true);
    expect(canReadLocalInvite({ ...valid, registeredOrigin: 'https://[::1]:9834', currentUrl: 'https://[::1]:9834/' })).toBe(true);
  });
  it.each([
    { mainFrame: false }, { running: false }, { desktopManaged: false }, { registeredOrigin: undefined }, { servicePort: 9835 },
    { currentUrl: 'https://remote.example/' },
    { registeredOrigin: 'https://remote.example:9834', currentUrl: 'https://remote.example:9834/' },
    { registeredOrigin: 'https://192.168.8.1:9834', currentUrl: 'https://192.168.8.1:9834/' },
    { registeredOrigin: 'https://termdock.local:9834', currentUrl: 'https://termdock.local:9834/' },
    { currentUrl: 'http://localhost:9834/api/terminal/fs/preview/project/index.html' },
    { currentUrl: 'http://localhost:9834/file.html' },
    { currentUrl: 'file:///index.html' },
    { currentUrl: 'http://user:password@localhost:9834/' },
  ])('denies untrusted context %j', override => {
    expect(canReadLocalInvite({ ...valid, ...override })).toBe(false);
  });
});
