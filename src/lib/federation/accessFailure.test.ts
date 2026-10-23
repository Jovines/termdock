import { describe, expect, it, vi } from 'vitest';
import { ConnectionAccessError, connectionAccessError, relayAuthorizationError } from './accessFailure';
import { raceConnectionAttempts } from './connectionAttempts';
import { DeviceAuthorizationRequired } from './deviceAuthorization';

describe('confirmed access failures and saved route selection', () => {
  it.each([new TypeError('network unavailable'), new Error('Route unavailable or denied'), new DOMException('timeout', 'TimeoutError')])('does not infer authorization from a transport failure (%s)', error => {
    expect(connectionAccessError(error)).toBeUndefined();
    expect(relayAuthorizationError(error, {})).toBe(error);
  });
  it('binds a confirmed entry denial to the original route and final target without copying private errors', () => {
    const context = { targetServiceId: 'target', entryServiceId: 'entry', entryUrl: 'https://entry.example' };
    const error = relayAuthorizationError(new Error('AUTHORIZATION_DENIED'), context);
    expect(error).toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED', context });
    expect(error.message).not.toMatch(/撤销|过期/);
  });
  it('tries another saved authorized route after an entry denies access', async () => {
    const denied = new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED');
    const dispose = vi.fn();
    await expect(raceConnectionAttempts([
      { key: 'relay:first', run: async () => { throw denied; } },
      { key: 'relay:second', run: async () => 'authorized-transport' },
    ], dispose)).resolves.toEqual({ key: 'relay:second', value: 'authorized-transport' });
    expect(dispose).not.toHaveBeenCalled();
  });
  it('retains confirmed route denial after all saved alternatives fail temporarily', async () => {
    const denied = new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED');
    await expect(raceConnectionAttempts([
      { key: 'relay:first', run: async () => { throw denied; } },
      { key: 'direct:offline', run: async () => { throw new TypeError('offline'); } },
    ], vi.fn())).rejects.toBe(denied);
  });
  it('does not bypass a final target denial by trying another entry', async () => {
    const later = vi.fn(async () => 'must-not-connect');
    await expect(raceConnectionAttempts([
      { key: 'direct:target', run: async () => { throw new DeviceAuthorizationRequired(); } },
      { key: 'relay:other', run: later },
    ], vi.fn())).rejects.toMatchObject({ code: 'TARGET_AUTHORIZATION_REQUIRED' });
    expect(later).not.toHaveBeenCalled();
  });
  it('retains identity mismatch rather than offering authorization to a different service', async () => {
    await expect(raceConnectionAttempts([
      { key: 'direct:target', run: async () => { throw new ConnectionAccessError('TARGET_IDENTITY_MISMATCH'); } },
      { key: 'relay:entry', run: async () => { throw new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED'); } },
    ], vi.fn())).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' });
  });
});
