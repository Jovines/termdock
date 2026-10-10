import { describe, expect, it } from 'vitest';
import { collaborationSessionDisplayName, getSessionDisplayName } from './sessionDisplayName';

describe('collaboration directory display names', () => {
  it('retains user and generated titles even when an Agent is running', () => {
    const record = { sessionId: 'one', name: '查看 Todos.dev | web-terminal', customName: true, activeProgram: 'codex', shellTitle: 'codex', cwd: '/project' };
    expect(collaborationSessionDisplayName(record)).toBe(record.name);
  });
  it('uses the same live title as the sidebar rather than the internal tmux name', () => {
    const record = { name: 'tmux:wt-abc', activeProgram: 'codex', shellTitle: '优化文件预览', cwd: '/project' };
    expect(collaborationSessionDisplayName(record)).toBe(getSessionDisplayName(record, 'codex', null, undefined, record.shellTitle));
    expect(collaborationSessionDisplayName(record)).toBe('优化文件预览');
  });
  it.each(['/home/qiao/project', 'project'])('does not mistake a directory title for a conversation name (%s)', shellTitle => {
    expect(collaborationSessionDisplayName({ name: 'tmux:wt-abc', shellTitle, activeProgram: 'codex', cwd: '/home/qiao/project' })).toBe('codex');
  });
  it('keeps readable last-known names when no live backend is attached', () => {
    expect(collaborationSessionDisplayName({ name: '审查登录体验', customName: true })).toBe('审查登录体验');
    expect(collaborationSessionDisplayName({ name: 'tmux:wt-abc', agent: { displayName: 'Codex' } })).toBe('Codex');
    expect(collaborationSessionDisplayName({ name: 'tmux:wt-abc', cwd: '/home/qiao/project', activeProgram: 'zsh' })).toBe('project');
  });
});
