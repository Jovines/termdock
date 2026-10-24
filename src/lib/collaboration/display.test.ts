import { describe, expect, it } from 'vitest';
import { collaborationMemberLabel, collaborationRemoteConnection } from './display';

describe('collaboration member names', () => {
  it('uses readable Agent names for terminal identifiers and distinguishes peers', () => {
    const members = ['one', 'two'].map(id => ({ sessionId: id, name: `tmux:wt-${id}`, agent: { displayName: 'Codex' } }));
    expect(collaborationMemberLabel(members[0], members)).toBe('Codex 1');
    expect(collaborationMemberLabel(members[1], members)).toBe('Codex 2');
  });
  it('keeps user names and gives unnamed members a readable fallback', () => {
    const named = { sessionId: 'one', name: '设计评审' };
    expect(collaborationMemberLabel(named, [named])).toBe('设计评审');
    const unnamed = { sessionId: 'remote:node:two', name: 'remote:node:two' };
    expect(collaborationMemberLabel(unnamed, [unnamed])).toBe('终端会话');
  });
  it('never replaces projected or legacy titles with their shared working directory', () => {
    const members = [
      { sessionId: 'one', name: 'lifeservices_dld_csr', displayName: '改造 Android 应用', cwd: '/repo/lifeservices_dld_csr' },
      { sessionId: 'two', name: '核对 Codex Session 检索', cwd: '/repo/lifeservices_dld_csr' },
    ];
    expect(collaborationMemberLabel(members[0], members)).toBe('改造 Android 应用');
    expect(collaborationMemberLabel(members[1], members)).toBe('核对 Codex Session 检索');
  });
});

describe('remote connectivity evidence', () => {
  it('does not turn missing connectivity or a last known task status green', () => {
    expect(collaborationRemoteConnection({ status: 'working' })).toBe('unknown');
    expect(collaborationRemoteConnection({ status: 'ready', serviceConnected: false })).toBe('disconnected');
    expect(collaborationRemoteConnection({ status: 'offline', serviceConnected: true })).toBe('disconnected');
    expect(collaborationRemoteConnection({ status: 'working', serviceConnected: true })).toBe('connected');
  });
});
