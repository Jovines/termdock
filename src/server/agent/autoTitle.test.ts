import { describe, expect, it } from 'vitest';
import {
  AUTO_TITLE_LONG_RUNNING_CONTEXT_CHARS,
  AUTO_TITLE_LONG_RUNNING_DELAY_MS,
  AUTO_TITLE_MIN_CONTEXT_CHARS,
  buildAutoTitlePrompt,
  cleanTerminalContext,
  hasSubstantiveAutoTitleContext,
  isNewAgentSessionId,
  isLongRunningAutoTitleTurnEligible,
  isAutoTitleReevaluationDue,
  normalizeGeneratedTitle,
  resolveTitleNamerOrder,
  shouldReplaceAutoTitle,
} from './autoTitle.js';

describe('agent auto titles', () => {
  it('removes terminal control sequences and keeps recent readable content', () => {
    const input = `old\n\x1b[31mFix login redirect\x1b[0m\n\x1b]0;/tmp/project\x07done`;
    expect(cleanTerminalContext(input)).toBe('old\nFix login redirect\ndone');
  });

  it('allows a short first exchange to trigger a title attempt', () => {
    expect(AUTO_TITLE_MIN_CONTEXT_CHARS).toBeLessThanOrEqual('hi\nHi! How can I help?'.length);
  });

  it('waits for substantial output before scheduling a long-running title', () => {
    expect(AUTO_TITLE_LONG_RUNNING_DELAY_MS).toBe(30_000);
    expect(hasSubstantiveAutoTitleContext('x'.repeat(AUTO_TITLE_LONG_RUNNING_CONTEXT_CHARS - 1))).toBe(false);
    expect(hasSubstantiveAutoTitleContext(`\x1b[32m${'x'.repeat(AUTO_TITLE_LONG_RUNNING_CONTEXT_CHARS)}\x1b[0m`)).toBe(true);
  });

  it('requires a confirmed active prompt before scheduling a long-running title', () => {
    expect(isLongRunningAutoTitleTurnEligible(undefined, false, false)).toBe(false);
    expect(isLongRunningAutoTitleTurnEligible('working', false, false)).toBe(false);
    expect(isLongRunningAutoTitleTurnEligible('working', true, false)).toBe(false);
    expect(isLongRunningAutoTitleTurnEligible('idle', true, true)).toBe(false);
    expect(isLongRunningAutoTitleTurnEligible('done', true, true)).toBe(false);
    expect(isLongRunningAutoTitleTurnEligible('working', true, true)).toBe(true);
  });

  it('asks for a stable purpose-oriented title using the agent identity', () => {
    const prompt = buildAutoTitlePrompt('Codex', 'Implemented the cache');
    expect(prompt).toContain('Codex coding session');
    expect(prompt).toContain("session's primary purpose");
    expect(prompt).toContain('not the latest activity, implementation details, commands, progress, or completion status');
    expect(prompt).toContain('<terminal_context>\nImplemented the cache');
  });

  it('keeps an existing title only while it represents the primary purpose', () => {
    const prompt = buildAutoTitlePrompt('Codex', 'Implemented the cache', 'Improve caching');
    expect(prompt).toContain('Keep it unchanged if it still represents the session\'s primary purpose');
    expect(prompt).toContain('rename only when that primary purpose clearly changed');
  });

  it('appends optional user preferences without exposing or replacing the default prompt', () => {
    const prompt = buildAutoTitlePrompt('Codex', 'Implemented the cache', undefined, '突出用户收益，避免技术术语');
    expect(prompt).toContain('Create a concise title for this Codex coding session.');
    expect(prompt).toContain('<user_title_preferences>\n突出用户收益，避免技术术语\n</user_title_preferences>');
    expect(buildAutoTitlePrompt('Codex', 'Implemented the cache')).not.toContain('<user_title_preferences>');
  });

  it('labels raw Agent prompt-submit payloads without assuming their schema', () => {
    const prompt = buildAutoTitlePrompt(
      'Codex',
      'Running tests',
      undefined,
      undefined,
      ['{"prompt":"修复自动标题"}', '{"request":{"text":"不要让 Loading 污染上下文"}}'],
    );
    expect(prompt).toContain('raw payloads emitted by Codex prompt-submit hooks');
    expect(prompt).toContain('[payload 1] {"prompt":"修复自动标题"}');
    expect(prompt).toContain('[payload 2] {"request":{"text":"不要让 Loading 污染上下文"}}');
  });

  it('does not silently truncate a configured payload at the terminal-context limit', () => {
    const payload = `{"prompt":"${'x'.repeat(20_000)}"}`;
    const prompt = buildAutoTitlePrompt('Codex', 'static output', undefined, undefined, [payload]);
    expect(prompt).toContain(payload);
  });

  it('normalizes common model wrappers around a title', () => {
    expect(normalizeGeneratedTitle('标题：修复登录跳转。\n')).toBe('修复登录跳转');
    expect(normalizeGeneratedTitle('```text\nImprove cache invalidation\n```')).toBe('Improve cache invalidation');
    expect(normalizeGeneratedTitle('')).toBeNull();
  });

  it('prefers the current supported agent unless the user overrides it', () => {
    expect(resolveTitleNamerOrder('claude', 'auto')).toEqual(['claude', 'codex']);
    expect(resolveTitleNamerOrder('codex', 'auto')).toEqual(['codex', 'claude']);
    expect(resolveTitleNamerOrder('claude', 'codex')).toEqual(['codex']);
    expect(resolveTitleNamerOrder('test-agent', 'auto', ['codex', 'claude', 'test-agent']))
      .toEqual(['test-agent', 'codex', 'claude']);
  });

  it('keeps cosmetic title variants and accepts a clear topic shift', () => {
    expect(shouldReplaceAutoTitle('修复登录跳转', '修复登录跳转问题')).toBe(false);
    expect(shouldReplaceAutoTitle('Improve cache invalidation', 'Cache invalidation improvements')).toBe(false);
    expect(shouldReplaceAutoTitle('修复登录跳转', '重构数据库迁移')).toBe(true);
  });

  it('distinguishes a cleared/new agent session from a resume', () => {
    expect(isNewAgentSessionId('old-id', 'new-id')).toBe(true);
    expect(isNewAgentSessionId('same-id', 'same-id')).toBe(false);
    expect(isNewAgentSessionId(null, 'new-id')).toBe(false);
  });

  it('uses the configurable title re-evaluation interval with a five-minute floor', () => {
    const now = 1_000_000;
    expect(isAutoTitleReevaluationDue(now - 9 * 60_000, 10, now)).toBe(false);
    expect(isAutoTitleReevaluationDue(now - 10 * 60_000, 10, now)).toBe(true);
    expect(isAutoTitleReevaluationDue(now - 4 * 60_000, 1, now)).toBe(false);
    expect(isAutoTitleReevaluationDue(now - 5 * 60_000, 1, now)).toBe(true);
  });
});
