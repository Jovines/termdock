import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationRoutingStore, selectCollaborationPane, selectDrivePane, type CollaborationBinding, type CollaborationPaneCandidate } from './collaborationRouting.js';
import { resolveCollaborationBackend } from './sessionBindingRecovery.js';

const pane: CollaborationPaneCandidate = { serverPid: 12, sessionId: '$1', paneId: '%1', panePid: 123,
  agentSlug: 'traex', nativeSessionId: 'native', cwd: '/repo' };
const binding: CollaborationBinding = { sessionId: 'peer', backendSessionId: 'backend', mode: 'tmux',
  tmuxSessionName: 'td-peer', agentSlug: 'traex', nativeSessionId: 'native', pane: null };

describe('authoritative collaboration routing', () => {
  let directory: string;
  let file: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-routing-')); file = path.join(directory, 'routes.json'); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('persists runtime bindings independently of stale UI state or search index eviction', () => {
    const store = new CollaborationRoutingStore(file);
    store.bind({ ...binding, pane });
    const restored = new CollaborationRoutingStore(file);
    expect(restored.get('peer')).toEqual({ ...binding, pane });
    const copy = restored.get('peer')!;
    copy.backendSessionId = null;
    copy.pane!.paneId = '%999';
    expect(restored.get('peer')).toEqual({ ...binding, pane });
    expect(restored.ownerOfBackend('backend')).toBe('peer');
  });

  it('rejects duplicate ownership and does not adopt a binding that failed to persist', () => {
    const store = new CollaborationRoutingStore(file);
    store.bind(binding);
    expect(() => store.bind({ ...binding, sessionId: 'other' })).toThrow('BACKEND_ALREADY_BOUND');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.bind({ ...binding, backendSessionId: 'next' })).toThrow('disk full');
    expect(store.get('peer')?.backendSessionId).toBe('backend');
    expect(new CollaborationRoutingStore(file).get('peer')?.backendSessionId).toBe('backend');
  });

  it('uses the persisted runtime binding after restart despite null or conflicting UI backend ids', () => {
    const store = new CollaborationRoutingStore(file);
    store.bind(binding);
    const restored = new CollaborationRoutingStore(file);
    const backend = { mode: 'tmux', tmuxSessionName: 'td-peer', agent: { slug: 'traex' }, agentSession: { sessionId: 'native' } };
    const live = new Map([['backend', backend], ['wrong', { ...backend, tmuxSessionName: 'other' }]]);
    for (const backendSessionId of [null, 'wrong']) {
      const record = { sessionId: 'peer', backendSessionId, mode: 'tmux', tmuxSessionName: null };
      expect(resolveCollaborationBackend(record, [record], live, restored)).toEqual(['backend', backend]);
      expect(restored.get('peer')?.backendSessionId).toBe('backend');
    }
    const record = { ...binding };
    expect(resolveCollaborationBackend(record, [record], new Map(), restored)).toBeNull();
  });

  it('fails closed on a corrupt registry without overwriting the evidence', () => {
    fs.writeFileSync(file, '{bad');
    const store = new CollaborationRoutingStore(file);
    expect(() => store.bind(binding)).toThrow('COLLABORATION_ROUTING_STORE_UNREADABLE');
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad');
  });

  it('pins a unique native session and ignores subsequent active pane changes', () => {
    const other = { ...pane, paneId: '%2', panePid: 456, nativeSessionId: 'other' };
    expect(selectCollaborationPane(binding, [other, pane])).toMatchObject({ state: 'ready', pane });
    expect(selectCollaborationPane({ ...binding, pane }, [other, pane])).toMatchObject({ state: 'ready', pane });
  });

  it('does not guess between multiple Agents without unique native identity', () => {
    const unknown = { ...pane, nativeSessionId: null };
    expect(selectCollaborationPane(binding, [unknown, { ...unknown, paneId: '%2' }])).toMatchObject({ state: 'ambiguous' });
    expect(selectCollaborationPane(binding, [unknown])).toMatchObject({ state: 'ready' });
  });

  it('rejects a reused tmux session/pane and a replaced Agent', () => {
    for (const changed of [{ serverPid: 13 }, { sessionId: '$2' }, { panePid: 456 }, { paneId: '%3' }, { agentSlug: 'codex' }, { nativeSessionId: 'new' }]) {
      expect(selectCollaborationPane({ ...binding, pane }, [{ ...pane, ...changed }])).toMatchObject({ state: 'identity-mismatch' });
    }
    expect(selectCollaborationPane({ ...binding, pane }, [{ ...pane, agentSlug: '' }])).toMatchObject({ state: 'agent-exited' });
  });

  describe('drive-side pane resolution', () => {
    const shell = { ...pane, paneId: '%2', panePid: 456, agentSlug: '', nativeSessionId: null, cwd: '/repo' };
    const unpinned: CollaborationBinding = { ...binding, agentSlug: null, nativeSessionId: null, pane: null };

    it('prefers an Agent pane when one is selectable', () => {
      expect(selectDrivePane(unpinned, [shell, pane], shell.paneId)).toMatchObject({ state: 'ready', pane });
    });

    it('falls back to the session pane for a plain shell member', () => {
      expect(selectDrivePane(unpinned, [shell], shell.paneId)).toMatchObject({ state: 'ready', pane: shell });
    });

    it('returns the agent-keyed verdict when there is no pane at all', () => {
      expect(selectDrivePane(unpinned, [], '%9')).toMatchObject({ state: 'agent-exited' });
    });

    it('prefers the active pane among several plain panes', () => {
      const second = { ...shell, paneId: '%3', panePid: 789 };
      expect(selectDrivePane(unpinned, [shell, second], second.paneId)).toMatchObject({ state: 'ready', pane: second });
    });
  });
});
