// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationRoutingStore, assessCollaborationRouteIdentity, type CollaborationBinding, type CollaborationPaneCandidate } from './collaborationRouting.js';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-route-proof-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const original = { serverPid: 100, sessionId: '$1', paneId: '%1', panePid: 200, agentSlug: 'fixture', nativeSessionId: 'original-native' };
const binding: CollaborationBinding = { sessionId: 'logical', backendSessionId: 'backend', mode: 'tmux', tmuxSessionName: 'original', agentSlug: 'fixture', nativeSessionId: 'original-native', pane: original };
const current: CollaborationPaneCandidate = { ...original, serverPid: 300, sessionId: '$2', paneId: '%2', panePid: 400, cwd: '/private/path', nativeIdentitySource: 'linux-flock-owner', nativeIdentityVerified: true };
it('can recover changed physical identities only from verified original native identity and unambiguous ownership', () => {
  const result = assessCollaborationRouteIdentity(binding, [current], true, false);
  expect(result).toMatchObject({ state: 'ready', pane: current, diagnostics: { expected: original, recovery: 'automatic', reason: null } });
  expect(result.diagnostics.observed[0]).not.toHaveProperty('cwd');
  expect(result.diagnostics.rebind_command).toBe('td collab --session logical rebind --pane %2');
});
it.each([
  { nativeIdentityVerified: false }, { nativeIdentityVerified: undefined, nativeIdentitySource: 'argv' as const },
  { nativeSessionId: null }, { nativeSessionId: 'different' }, { agentSlug: 'different' },
  { nativeIdentityFailure: 'PROCESS_CHANGED' }, { isShell: true },
])('does not automatically adopt weak/changed evidence %j', changed => {
  expect(assessCollaborationRouteIdentity(binding, [{ ...current, ...changed }], true, false)).toMatchObject({ state: 'identity-mismatch', diagnostics: { recovery: 'confirmation-required' } });
});
it('refuses ambiguous current instances, missing original identity and unresolved earlier writes', () => {
  const duplicate = { ...current, paneId: '%3', panePid: 500 };
  expect(assessCollaborationRouteIdentity(binding, [current, duplicate], true, false).diagnostics.reason).toBe('MULTIPLE_NATIVE_IDENTITY_MATCHES');
  expect(assessCollaborationRouteIdentity({ ...binding, nativeSessionId: null, pane: { ...original, nativeSessionId: null } }, [current], true, false).diagnostics.reason).toBe('NATIVE_IDENTITY_UNCONFIRMED');
  expect(assessCollaborationRouteIdentity(binding, [current], false, false).diagnostics.reason).toBe('ROUTE_OWNERSHIP_UNCONFIRMED');
  expect(assessCollaborationRouteIdentity(binding, [current], true, true).diagnostics.reason).toBe('DELIVERY_OUTCOME_UNCONFIRMED');
});
it('unchanged terminals retain existing input semantics rather than introducing a per-message Agent readiness gate', () => {
  const samePane = { ...original, cwd: '/repo', agentSlug: '', nativeSessionId: null };
  expect(assessCollaborationRouteIdentity(binding, [samePane], true, false)).toMatchObject({ state: 'ready', pane: samePane, diagnostics: { recovery: 'unchanged' } });
});
it('bounds diagnostics without treating truncated current identity matches as unique', () => {
  const panes = Array.from({ length: 22 }, (_, index) => ({ ...current, paneId: `%${index + 2}`, panePid: index + 400 }));
  const result = assessCollaborationRouteIdentity(binding, panes, true, false);
  expect(result.diagnostics.observed).toHaveLength(20); expect(result.diagnostics.truncated).toBe(true);
  expect(result.diagnostics.recovery).toBe('confirmation-required');
});
it('preserves route revision and last recovery across restart, protects runtime ownership and failed persistence', () => {
  const file = path.join(directory, 'routes.json'), store = new CollaborationRoutingStore(file);
  const repaired = { ...binding, pane: current, routeRevision: 'revision-1', lastRecovery: { kind: 'native-identity' as const, at: Date.now(), previousPane: original } };
  store.bind(repaired); const restarted = new CollaborationRoutingStore(file);
  expect(restarted.get('logical')).toEqual(repaired);
  expect(restarted.hasOtherPaneOwner('other', current)).toBe(true); expect(restarted.hasOtherPaneOwner('logical', current)).toBe(false);
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failed'); });
  expect(() => restarted.bind({ ...repaired, routeRevision: 'revision-2' })).toThrow('disk failed');
  expect(restarted.get('logical')?.routeRevision).toBe('revision-1');
});
