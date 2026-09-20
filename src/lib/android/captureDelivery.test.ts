// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { insertAndroidText, useAndroidRecordingDelivery } from './captureDelivery';
afterEach(() => { vi.useRealTimers(); useAndroidRecordingDelivery.setState({ pending: [] }); });
it('waits for the matching terminal acknowledgement, reports negative acknowledgements', async () => {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    expect(detail.sessionId).toBe('target');
    expect(detail.paste).toBe(true);
    window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce: 'unrelated', ok: true } }));
    window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce: detail.nonce, ok: false } }));
  };
  window.addEventListener('termdock-insert-reference', receive);
  try { await expect(insertAndroidText('text', 'target')).rejects.toThrow('尚未插入'); }
  finally { window.removeEventListener('termdock-insert-reference', receive); }
});
it('does not claim successful delivery when the terminal is absent', async () => {
  vi.useFakeTimers();
  await expect(insertAndroidText('text', null)).rejects.toThrow('没有');
  const pending = expect(insertAndroidText('text', 'closed-terminal')).rejects.toThrow('尚未插入');
  await vi.advanceTimersByTimeAsync(10000);
  await pending;
});
it('deduplicates recovered recordings across mounts without replacing the original destination', () => {
  const file = { id: 'record', serial: 'phone', name: 'same.mp4', size: 1, startedAt: 1, status: 'ready' as const };
  useAndroidRecordingDelivery.getState().enqueue(file, 'original', '/project');
  useAndroidRecordingDelivery.getState().enqueue(file, 'other');
  expect(useAndroidRecordingDelivery.getState().pending).toHaveLength(1);
  expect(useAndroidRecordingDelivery.getState().pending[0].sessionId).toBe('original');
  useAndroidRecordingDelivery.getState().remove(file.id);
  expect(useAndroidRecordingDelivery.getState().pending).toEqual([]);
});
