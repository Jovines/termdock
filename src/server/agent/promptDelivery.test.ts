import { captureTerminalInputGuard } from './terminalInput.js';
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
  it('fences a queued paste when its runtime has changed and lets later input proceed', async () => {
    vi.useFakeTimers();
    const target = { write: vi.fn() };
    let generation = 'old';
    const first = writeBracketedPrompt(target, 'first');
    const stale = writeBracketedPrompt(target, 'stale', captureTerminalInputGuard(() => generation));
    const failure = expect(stale).rejects.toThrow('TERMINAL_INPUT_TARGET_CHANGED');
    await vi.advanceTimersByTimeAsync(0);
    generation = 'new';
    const next = writeBracketedPrompt(target, 'next', captureTerminalInputGuard(() => generation));
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, failure, next]);
    expect(target.write.mock.calls).toEqual([
      ['\x1b[200~first\x1b[201~'], ['\r'], ['\x1b[200~next\x1b[201~'], ['\r'],
    ]);
  });

  it('never sends an old delayed CR into a replacement runtime', async () => {
    vi.useFakeTimers();
    const target = { write: vi.fn() };
    let generation = 'old';
    const delivery = writeBracketedPrompt(target, 'old-body', captureTerminalInputGuard(() => generation));
    const failure = expect(delivery).rejects.toThrow('TERMINAL_INPUT_TARGET_CHANGED');
    await vi.advanceTimersByTimeAsync(49);
    generation = 'new';
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(target.write.mock.calls).toEqual([['\x1b[200~old-body\x1b[201~']]);
  });

});
