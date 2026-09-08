// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
import { downloadFile } from './api';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('uses the decrypted blob when iOS sharing fails, without navigating to a business endpoint', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', share: vi.fn().mockRejectedValue(new Error('Sharing unavailable')), canShare: () => true });
  const fetch = vi.fn().mockResolvedValue(new Response('private file bytes', { headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="private.txt"' } }));
  vi.stubGlobal('fetch', fetch);
  const created = vi.fn(() => 'blob:https://app.test/decrypted'), revoked = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }));
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href); });
  await downloadFile('/private.txt');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(clicked).toEqual(['blob:https://app.test/decrypted']);
  expect(created.mock.calls).toHaveLength(1);
  vi.runAllTimers(); expect(revoked).toHaveBeenCalledWith('blob:https://app.test/decrypted');
});
