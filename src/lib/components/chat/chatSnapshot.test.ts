import { afterEach, expect, it, vi } from 'vitest';
import { clearChatSnapshots, readChatSnapshot, saveChatSnapshot, type ChatSnapshot } from './chatSnapshot';
const connection = vi.hoisted(() => ({ client: {} }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => connection.client }));
const snapshot = (text = 'reply'): ChatSnapshot => ({ messages: [{ id: 'one', role: 'assistant', content: text, status: 'stored', createdAt: 1 }], agentName: 'Codex', agentAvailable: true, scrollTop: 320, nearBottom: false, visibleCount: 60 });
afterEach(() => { clearChatSnapshots(); vi.useRealTimers(); });
it('expires old history and never reuses it under a different secure connection', () => {
  vi.useFakeTimers();
  saveChatSnapshot('one', snapshot()); expect(readChatSnapshot('one')?.scrollTop).toBe(320);
  connection.client = {}; expect(readChatSnapshot('one')).toBeUndefined();
  saveChatSnapshot('one', snapshot()); vi.advanceTimersByTime(300001); expect(readChatSnapshot('one')).toBeUndefined();
});
it('bounds history by both entry count and retained bytes', () => {
  for (let i = 0; i < 13; i++) saveChatSnapshot(String(i), snapshot());
  expect(readChatSnapshot('0')).toBeUndefined(); expect(readChatSnapshot('12')).toBeTruthy();
  saveChatSnapshot('oversized', snapshot('x'.repeat(3 * 1024 * 1024)));
  expect(readChatSnapshot('oversized')).toBeUndefined();
  for (let i = 0; i < 4; i++) saveChatSnapshot(`large-${i}`, snapshot('x'.repeat(1500000)));
  expect(readChatSnapshot('large-0')).toBeUndefined(); expect(readChatSnapshot('large-3')).toBeTruthy();
});
