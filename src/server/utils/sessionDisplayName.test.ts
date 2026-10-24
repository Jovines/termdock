import { describe, expect, it } from 'vitest';
import { collaborationSessionDisplayName, getSessionDisplayName, getSessionSnapshotPresentation } from './sessionDisplayName';

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
  it('reads projected snapshots without treating the compatibility name or directory as a new title source', () => {
    const snapshot = { sessionId: 'one', name: 'repo', cwd: '/repo', displayName: '完整任务标题', displaySubtitle: 'repo' };
    expect(getSessionSnapshotPresentation(snapshot)).toEqual({ displayName: '完整任务标题', displaySubtitle: 'repo' });
    expect(getSessionSnapshotPresentation({ ...snapshot, displayName: undefined, name: '旧版完整任务标题' }).displayName).toBe('旧版完整任务标题');
    expect(getSessionSnapshotPresentation({ name: 'remote:node:one', sessionId: 'remote:node:one' }).displayName).toBe('终端会话');
  });
});
