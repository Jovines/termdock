import { describe, expect, it } from 'vitest';
import { resolveNewSessionAgentPreference } from './useNewSessionAgentPreference';

const agents = [
  { slug: 'codex', displayName: 'Codex', command: 'codex', accentColor: 'var(--ui)', icon: 'codex' },
  { slug: 'claude', displayName: 'Claude Code', command: 'claude', accentColor: 'var(--accent)', icon: 'claude' },
];

describe('resolveNewSessionAgentPreference', () => {
  it('resolves the server-owned slug to the detected launcher', () => {
    expect(resolveNewSessionAgentPreference('claude', agents)).toEqual(agents[1]);
  });

  it('falls back to a plain terminal when no launcher matches', () => {
    expect(resolveNewSessionAgentPreference(null, agents)).toBeNull();
    expect(resolveNewSessionAgentPreference('missing', agents)).toBeNull();
  });
});
