import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBracketedPasteBytes, writeBracketedPrompt, canDeliverPromptToAgent } from './promptDelivery.js';

describe('buildBracketedPasteBytes', () => {
  it('keeps multiline prompts in one paste block without a submit CR', () => {
    expect(buildBracketedPasteBytes('first\nsecond\r\nthird')).toBe(
      '\x1b[200~first\rsecond\rthird\x1b[201~',
    );
  });

  it('keeps a multiline collaboration inbox in one paste', () => {
    const inbox = '[Termdock 协作收件箱]\n- [任务 #1] 用户 → 发布组: 检查构建\n- [问题 #2] 用户 → 发布组: 测试通过了吗？\n请处理这些消息。';
    expect(buildBracketedPasteBytes(inbox)).toBe(
      '\x1b[200~[Termdock 协作收件箱]\r- [任务 #1] 用户 → 发布组: 检查构建\r- [问题 #2] 用户 → 发布组: 测试通过了吗？\r请处理这些消息。\x1b[201~',
    );
  });

  it('neutralizes escape bytes from prompt content', () => {
    expect(buildBracketedPasteBytes('safe\x1b[201~injected')).toBe(
      '\x1b[200~safe␛[201~injected\x1b[201~',
    );
  });

  it('accepts either process detection or hook state as a live Agent signal', () => {
    expect(canDeliverPromptToAgent({ agent: { slug: 'claude' }, agentSession: null })).toBe(true);
    expect(canDeliverPromptToAgent({ agent: null, agentSession: { status: 'idle' } })).toBe(true);
    expect(canDeliverPromptToAgent({ agent: { slug: 'codex' }, agentSession: { status: 'working', rich: true } })).toBe(true);
    expect(canDeliverPromptToAgent({ agent: null, agentSession: null })).toBe(false);
  });
});


describe('PTY paste and submit', () => {
  afterEach(() => vi.useRealTimers());
  it('writes one bracketed paste, then one CR after 50ms', async () => {
    vi.useFakeTimers();
    const target = { write: vi.fn() };
    const delivery = writeBracketedPrompt(target, 'first\nsecond');
    await vi.advanceTimersByTimeAsync(49);
    expect(target.write.mock.calls).toEqual([['\x1b[200~first\rsecond\x1b[201~']]);
    await vi.advanceTimersByTimeAsync(1);
    await delivery;
    expect(target.write.mock.calls).toEqual([['\x1b[200~first\rsecond\x1b[201~'], ['\r']]);
  });
  it('serializes pairs for one PTY while other PTYs remain independent', async () => {
    vi.useFakeTimers();
    const a = { write: vi.fn() }, b = { write: vi.fn() };
    const deliveries = [writeBracketedPrompt(a, 'one'), writeBracketedPrompt(a, 'two'), writeBracketedPrompt(b, 'other')];
    await vi.advanceTimersByTimeAsync(49);
    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(51);
    await Promise.all(deliveries);
    expect(a.write.mock.calls).toEqual([['\x1b[200~one\x1b[201~'], ['\r'], ['\x1b[200~two\x1b[201~'], ['\r']]);
    expect(b.write).toHaveBeenCalledTimes(2);
  });
});
