import { expect, it, vi } from 'vitest';
import { raceConnectionAttempts } from './connectionAttempts';
import { describeInvitationFailure } from './invitationFailure';
import { ConnectionAccessError } from './accessFailure';

it.each(['INVITATION_EXPIRED', 'INVITATION_USED', 'PAIRING_DENIED', 'ROUTE_INVITATION_EXPIRED', 'ROUTE_INVITATION_USED', 'ROUTE_PAIRING_DENIED'])(
  'retains confirmed %s instead of trying another route with the same one-use code', async code => {
    const alternate = vi.fn().mockRejectedValue(new Error('Secure transport unavailable'));
    await expect(raceConnectionAttempts([
      { key: 'direct:first', run: async () => { throw new Error(code); } },
      { key: 'relay:alternate', run: alternate },
    ], vi.fn(), true)).rejects.toThrow(code);
    expect(alternate).not.toHaveBeenCalled();
  },
);
it('continues to an available route after a transport failure', async () => {
  const alternate = vi.fn().mockResolvedValue('connected');
  expect(await raceConnectionAttempts([
    { key: 'direct:first', run: async () => { throw new Error('Secure transport unavailable'); } },
    { key: 'relay:alternate', run: alternate },
  ], vi.fn(), true)).toEqual({ key: 'relay:alternate', value: 'connected' });
});
it('does not label a transport or identity failure as an expired invitation', () => {
  expect(describeInvitationFailure(new Error('Secure handshake timed out'))).toMatchObject({ kind: 'connection', retryable: true });
  expect(describeInvitationFailure(new ConnectionAccessError('TARGET_IDENTITY_MISMATCH'))).toMatchObject({ kind: 'identity', retryable: false });
});
it('bounds the entire route round, aborts pending dials and disposes late successes', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: string) => void, signal!: AbortSignal;
    const dispose = vi.fn();
    const pending = raceConnectionAttempts([{ key: 'relay:slow', run: current => { signal = current; return new Promise<string>(resolve => { finish = resolve; }); } }], dispose, false, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(101); await rejected;
    expect(signal.aborted).toBe(true); finish('late-connection'); await Promise.resolve();
    expect(dispose).toHaveBeenCalledWith('late-connection');
  } finally { vi.useRealTimers(); }
});
it('honors caller cancellation and ignores optional timing API failures', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled owner'));
  const dial = vi.fn();
  await expect(raceConnectionAttempts([{ key: 'direct:a', run: dial }], vi.fn(), false, { signal: controller.signal })).rejects.toThrow('cancelled owner');
  expect(dial).not.toHaveBeenCalled();
  const measure = vi.spyOn(performance, 'measure').mockImplementation(() => { throw new Error('timing unavailable'); });
  try {
    expect(await raceConnectionAttempts([{ key: 'direct:a', run: async () => 'connected' }], vi.fn())).toMatchObject({ value: 'connected' });
  } finally { measure.mockRestore(); }
});
