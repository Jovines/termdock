import { describe, expect, it } from 'vitest';
import type { CollaborationBinding } from './collaborationRouting.js';
import { recoverSessionBinding } from './sessionBindingRecovery.js';

const record = {
  sessionId: 'peer', backendSessionId: null, mode: 'tmux', tmuxSessionName: null,
  agentResume: { slug: 'traex', sessionId: 'native' },
};
const backend = {
  mode: 'tmux', tmuxSessionName: 'td-peer', agent: { slug: 'traex' },
  agentSession: { sessionId: 'native' },
};
const binding: CollaborationBinding = {
  sessionId: 'peer', backendSessionId: 'backend', mode: 'tmux', tmuxSessionName: null,
  agentSlug: 'traex', nativeSessionId: 'native', pane: null,
};

describe('recoverSessionBinding', () => {
  it('recovers a missing or dead global binding from live native identity without a search index', () => {
    for (const backendSessionId of [null, 'dead']) {
      const peer = { ...record, backendSessionId };
      expect(recoverSessionBinding(peer, [peer], new Map([['backend', backend]]), binding))
        .toEqual(['backend', backend]);
    }
  });

  it('recovers an exact tmux binding without native identity', () => {
    const peer = { ...record, tmuxSessionName: 'td-peer' };
    expect(recoverSessionBinding(peer, [peer], new Map([['backend', backend]]), null))
      .toEqual(['backend', backend]);
  });

  it('does not mark a persisted binding online without a live backend', () => {
    expect(recoverSessionBinding(record, [record], new Map(), binding)).toBeNull();
  });

  it('preserves an existing live binding', () => {
    const peer = { ...record, backendSessionId: 'current' };
    expect(recoverSessionBinding(peer, [peer], new Map([['current', backend], ['backend', backend]]), binding)).toBeNull();
  });

  it('rejects a different native session, Agent, tmux session, mode, or binding owner', () => {
    const live = new Map([['backend', backend]]);
    expect(recoverSessionBinding(record, [record], live, { ...binding, nativeSessionId: 'other' })).toBeNull();
    expect(recoverSessionBinding(record, [record], live, { ...binding, agentSlug: 'other' })).toBeNull();
    expect(recoverSessionBinding(record, [record], live, { ...binding, sessionId: 'other' })).toBeNull();
    expect(recoverSessionBinding({ ...record, tmuxSessionName: 'other' }, [record], live, binding)).toBeNull();
    expect(recoverSessionBinding({ ...record, mode: 'shell' }, [record], live, binding)).toBeNull();
    expect(recoverSessionBinding(record, [record], new Map([['backend', {
      ...backend, agentSession: { sessionId: 'replaced' },
    }]]), binding)).toBeNull();
  });

  it('does not steal another peer backend or select an ambiguous tmux backend', () => {
    expect(recoverSessionBinding(record, [record, { ...record, sessionId: 'other', backendSessionId: 'backend' }],
      new Map([['backend', backend]]), binding)).toBeNull();
    const peer = { ...record, tmuxSessionName: 'td-peer' };
    expect(recoverSessionBinding(peer, [peer], new Map([['backend', backend], ['duplicate', backend]]), binding)).toBeNull();
  });
});
