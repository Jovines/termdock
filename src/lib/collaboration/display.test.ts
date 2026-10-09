import { describe, expect, it } from 'vitest';
import { collaborationMemberLabel } from './display';

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
    expect(collaborationMemberLabel(unnamed, [unnamed])).toBe('成员');
  });
});
