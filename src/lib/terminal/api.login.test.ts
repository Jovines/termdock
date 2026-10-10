import { afterEach, expect, it, vi } from 'vitest';
import { loginWithPassword } from './api';

afterEach(() => vi.unstubAllGlobals());
it('retains legacy 401 and 429 contracts and distinguishes other server failures', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: 'Invalid password' }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ retryAfterMs: 6000 }, { status: 429 }))
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  expect(await loginWithPassword('test')).toMatchObject({ ok: false, reason: 'invalidPassword' });
  expect(await loginWithPassword('test')).toMatchObject({ ok: false, reason: 'rateLimited', rateLimited: true, retryAfterMs: 6000 });
  expect(await loginWithPassword('test')).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('returns a fixed connection failure when the login fetch rejects without silently retrying', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('private endpoint or stack'));
  vi.stubGlobal('fetch', fetch);
  const result = await loginWithPassword('test');
  expect(result).toMatchObject({ ok: false, reason: 'connectionFailed' });
  expect(result.error).not.toContain('private');
  expect(fetch).toHaveBeenCalledOnce();
});
