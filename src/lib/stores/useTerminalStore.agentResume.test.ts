// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from './useTerminalStore';

afterEach(() => {
  useTerminalStore.getState().clearAllTerminalSessions();
});

describe('Agent crash recovery state', () => {
  it('survives rebinding the frontend tab to a replacement PTY', () => {
    const store = useTerminalStore.getState();
    store.setAgentResumeRecovered('frontend-1', true);
    store.setTerminalSession('frontend-1', {
      sessionId: 'backend-2',
      cols: 80,
      rows: 24,
      mode: 'shell',
      cwd: '/repo',
    });

    expect(useTerminalStore.getState().sessions.get('frontend-1')).toMatchObject({
      terminalSessionId: 'backend-2',
      agentResumeRecovered: true,
    });
  });

  it('clears when the server confirms an Agent session has started', () => {
    const store = useTerminalStore.getState();
    store.setAgentResumeRecovered('frontend-1', true);
    store.setSessionAgentStatus('frontend-1', {
      agentStatus: 'idle',
      agentNativeSessionId: 'native-1',
      agentResumeRecovered: false,
      reviewed: true,
    });

    expect(useTerminalStore.getState().sessions.get('frontend-1')?.agentResumeRecovered).toBe(false);
  });
});

describe('initial terminal replay boundary', () => {
  it('flushes queued replay synchronously and returns its fixed final chunk id', () => {
    const store = useTerminalStore.getState();
    store.setTerminalSession('frontend-1', {
      sessionId: 'backend-1',
      cols: 80,
      rows: 24,
      mode: 'tmux',
    });
    store.appendToBuffer('frontend-1', 'initial replay');

    const targetChunkId = store.flushPendingBufferWrites('frontend-1');
    store.appendToBuffer('frontend-1', 'later live output');

    expect(targetChunkId).toBeTypeOf('number');
    expect(useTerminalStore.getState().sessions.get('frontend-1')?.bufferChunks.at(-1)?.id)
      .toBe(targetChunkId);
    expect(store.hasPendingBufferWrites('frontend-1')).toBe(true);
  });

  it('returns the final chunk id when replacing with an authoritative screen', () => {
    const store = useTerminalStore.getState();
    store.setTerminalSession('frontend-1', {
      sessionId: 'backend-1',
      cols: 80,
      rows: 24,
      mode: 'tmux',
    });

    const targetChunkId = store.replaceBuffer('frontend-1', ['screen-a', 'screen-b']);

    expect(targetChunkId).toBe(
      useTerminalStore.getState().sessions.get('frontend-1')?.bufferChunks.at(-1)?.id,
    );
  });
});

describe('tmux output delivery queue', () => {
  function session(mode: 'tmux' | 'shell' = 'tmux') {
    const store = useTerminalStore.getState();
    store.setTerminalSession('queue', { sessionId: 'backend', mode, cols: 80, rows: 24, history: ['old history'] });
    return store;
  }

  it('releases only parsed output, leaving queued and later live bytes intact', () => {
    const store = session();
    const first = store.replaceBuffer('queue', ['first'])!;
    store.appendToBuffer('queue', 'second');
    store.releaseWrittenTmuxOutput('queue', first);
    expect(store.getTerminalSession('queue')!.bufferChunks).toEqual([]);
    expect(store.hasPendingBufferWrites('queue')).toBe(true);
    const second = store.flushPendingBufferWrites('queue')!;
    expect(second).toBeGreaterThan(first);
    expect(store.getTerminalSession('queue')!.bufferChunks.map(chunk => chunk.data).join('')).toBe('second');
    store.releaseWrittenTmuxOutput('queue', first);
    expect(store.getTerminalSession('queue')!.bufferLength).toBe(6);
    store.releaseWrittenTmuxOutput('queue', second);
    expect(store.getTerminalSession('queue')!.bufferLength).toBe(0);
    expect(store.getTerminalSession('queue')!.history).toEqual([]);
  });

  it('does not trim unparsed tmux bytes like a replay ring buffer', () => {
    const store = session();
    const data = 'first\n' + 'output\n'.repeat(180_000) + 'last';
    const last = store.replaceBuffer('queue', [data])!;
    expect(store.getTerminalSession('queue')!.bufferChunks.map(chunk => chunk.data).join('')).toBe(data);
    store.releaseWrittenTmuxOutput('queue', last);
    expect(store.getTerminalSession('queue')!.bufferChunks).toEqual([]);
  });

  it('keeps a new authoritative screen when an obsolete write finishes late', () => {
    const store = session();
    const old = store.replaceBuffer('queue', ['obsolete'])!;
    store.replaceBuffer('queue', ['current screen']);
    store.releaseWrittenTmuxOutput('queue', old);
    expect(store.getTerminalSession('queue')!.bufferChunks.map(chunk => chunk.data)).toEqual(['current screen']);
  });

  it('retains shell history and its replay buffer', () => {
    const store = session('shell');
    const last = store.replaceBuffer('queue', ['shell output'])!;
    store.releaseWrittenTmuxOutput('queue', last);
    expect(store.getTerminalSession('queue')!.bufferLength).toBe(12);
    expect(store.getTerminalSession('queue')!.history).toEqual(['old history']);
  });
});
