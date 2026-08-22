import { describe, expect, it } from 'vitest';
import { buildAutoTitlePrompt, cleanTerminalContext, isNewAgentSessionId, normalizeGeneratedTitle, resolveTitleNamerOrder, shouldReplaceAutoTitle } from './autoTitle.js';

describe('agent auto titles', () => {
  it('removes terminal control sequences and keeps recent readable content', () => {
    const input = `old\n\x1b[31mFix login redirect\x1b[0m\n\x1b]0;/tmp/project\x07done`;
    expect(cleanTerminalContext(input)).toBe('old\nFix login redirect\ndone');
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
});
