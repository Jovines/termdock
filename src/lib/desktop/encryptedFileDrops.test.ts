// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../federation/clientScope', () => ({ selectedTarget: () => ({ url: 'https://remote.test', targetPeerId: 'C' }) }));
const upload = vi.hoisted(() => vi.fn());
vi.mock('../terminal/api', () => ({ uploadFiles: upload }));
import { canUseLocalDroppedPaths, installEncryptedFileDrops } from './encryptedFileDrops';

afterEach(() => { document.body.replaceChildren(); upload.mockReset(); });
it('only preserves original paths for the same local service, never a relay target behind localhost', () => {
  const target = { url: 'https://localhost:9834', targetPeerId: 'B' };
  expect(canUseLocalDroppedPaths(target.url, target)).toBe(true);
  expect(canUseLocalDroppedPaths(target.url, { ...target, serviceOrigin: 'https://remote.test' })).toBe(false);
  expect(canUseLocalDroppedPaths(target.url, { ...target, targetPeerId: 'C', routes: [{ url: target.url, targetPeerId: 'B' }] })).toBe(false);
  expect(canUseLocalDroppedPaths(target.url, null)).toBe(false);
});
it('uploads a remote drop in the renderer before the legacy preload can transmit it', async () => {
  const zone = document.createElement('div'); zone.dataset.termdockTerminalDropzone = 'session-C'; document.body.append(zone);
  const delivered = vi.fn(), legacy = vi.fn();
  document.addEventListener('drop', legacy, true);
  const dispose = installEncryptedFileDrops(delivered);
  upload.mockResolvedValue({ files: [{ path: '/tmp/uploaded.txt' }] });
  const file = new File(['private bytes'], 'original.txt');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  zone.dispatchEvent(event);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ sessionKey: 'session-C', paths: ['/tmp/uploaded.txt'] }));
  expect(upload).toHaveBeenCalledWith('/tmp', [file]); expect(legacy).not.toHaveBeenCalled();
  dispose(); document.removeEventListener('drop', legacy, true);
});
