// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { classifySessionCreationError, openSessionWithRecovery } from './newSessionRequest';

describe('session creation feedback', () => {
  it('maps recoverable failures without presenting paths, stack traces or transport detail', () => {
    expect(classifySessionCreationError(new Error('Directory does not exist: /private/path'))).toBe('directoryUnavailable');
    expect(classifySessionCreationError(new Error('Path is not a directory: /private/path'))).toBe('directoryUnavailable');
    expect(classifySessionCreationError(new Error('EACCES: permission denied'))).toBe('permissionDenied');
    expect(classifySessionCreationError(new TypeError('Failed to fetch'))).toBe('connection');
    expect(classifySessionCreationError(new Error('Request timed out'))).toBe('connection');
    expect(classifySessionCreationError(new Error('private diagnostic'))).toBe('unknown');
    expect(classifySessionCreationError(new Error('spawn shell ENOENT'))).toBe('unknown');
  });
});

it('retries a lost response with the same identity and reports only the final result', async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockRejectedValueOnce(new Error('Secure request closed')).mockResolvedValueOnce('opened');
  const pending = vi.fn();
  const result = openSessionWithRecovery({ cwd: '/work' }, open, { current: () => true, pending });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe('opened');
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[0][0].preferredFrontendSessionId).toBeTruthy();
  expect(open.mock.calls[1][0]).toEqual(open.mock.calls[0][0]);
  expect(pending.mock.calls).toEqual([[true], [false]]);
  vi.useRealTimers();
});
it('does not retry directory errors or create after the user has navigated away', async () => {
  const directory = vi.fn().mockRejectedValue(new Error('Directory does not exist'));
  await expect(openSessionWithRecovery({ cwd: '/gone' }, directory, { current: () => true, pending: vi.fn() })).rejects.toThrow('Directory');
  expect(directory).toHaveBeenCalledOnce();
  const disconnected = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(openSessionWithRecovery({ cwd: '/work' }, disconnected, { current: () => false, pending: vi.fn() })).rejects.toThrow('fetch');
  expect(disconnected).toHaveBeenCalledOnce();
});
