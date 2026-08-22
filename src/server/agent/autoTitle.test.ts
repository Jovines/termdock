import { describe, expect, it } from 'vitest';
import {
  AUTO_TITLE_MIN_CONTEXT_CHARS,
  buildAutoTitlePrompt,
  cleanTerminalContext,
  isNewAgentSessionId,
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

  it('asks for one concise title using the agent identity', () => {
    const prompt = buildAutoTitlePrompt('Codex', 'Implemented the cache');
    expect(prompt).toContain('Codex coding session');
    expect(prompt).toContain('<terminal_context>\nImplemented the cache');
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
