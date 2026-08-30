import { describe, expect, it } from 'vitest';
import { buildBracketedSubmitBytes, canDeliverPromptToAgent } from './promptDelivery.js';

describe('buildBracketedSubmitBytes', () => {
  it('keeps multiline prompts in one paste block and submits once', () => {
    expect(buildBracketedSubmitBytes('first\nsecond\r\nthird')).toBe(
      '\x1b[200~first\rsecond\rthird\x1b[201~\r',
    );
  });

  it('keeps a multiline collaboration inbox in one submission', () => {
    const inbox = '[Termdock 协作收件箱]\n- [任务 #1] 用户 → 发布组: 检查构建\n- [问题 #2] 用户 → 发布组: 测试通过了吗？\n请处理这些消息。';
    expect(buildBracketedSubmitBytes(inbox)).toBe(
      '\x1b[200~[Termdock 协作收件箱]\r- [任务 #1] 用户 → 发布组: 检查构建\r- [问题 #2] 用户 → 发布组: 测试通过了吗？\r请处理这些消息。\x1b[201~\r',
    );
  });

  it('neutralizes escape bytes from prompt content', () => {
    expect(buildBracketedSubmitBytes('safe\x1b[201~injected')).toBe(
      '\x1b[200~safe␛[201~injected\x1b[201~\r',
    );
  });

  it('accepts either process detection or hook state as a live Agent signal', () => {
    expect(canDeliverPromptToAgent({ agent: { slug: 'claude' }, agentSession: null })).toBe(true);
    expect(canDeliverPromptToAgent({ agent: null, agentSession: { status: 'idle' } })).toBe(true);
    expect(canDeliverPromptToAgent({ agent: null, agentSession: null })).toBe(false);
  });
});
