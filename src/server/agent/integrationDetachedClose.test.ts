// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { assertDetachedCloseOwnership, type DetachedCloseOwnership } from './integrationCloseOwnership.js';
import { selectCollaborationPane } from './collaborationRouting.js';
import { closeSessionRuntime } from './sessionManagement.js';
import { readTmuxLayout } from '../utils/tmuxLayoutReader.js';

const ownership = (): DetachedCloseOwnership => ({ sessionId: 'fixture', groupId: 'group', principalId: 'owner', localGroup: true,
  descriptorOwners: [{ sessionId: 'fixture', groupId: 'group', principalId: 'owner' }],
  principalOwners: [{ principalId: 'owner', groupId: 'group', revoked: false }], groupOwners: ['group'],
  terminalClaims: 0, backendClaims: [], otherPaneOwner: false });
it('allows a unique durable local owner without claiming a terminal registration', () => {
  expect(() => assertDetachedCloseOwnership(ownership())).not.toThrow();
  expect(() => assertDetachedCloseOwnership({ ...ownership(), backendClaims: [{ routeOwner: 'fixture', foreignTerminal: false }] })).not.toThrow();
});
it.each([
  { localGroup: false }, { descriptorOwners: [] }, { descriptorOwners: [...ownership().descriptorOwners, ...ownership().descriptorOwners] },
  { descriptorOwners: [{ sessionId: 'fixture', groupId: 'foreign', principalId: 'owner' }] },
  { principalOwners: [] }, { principalOwners: [{ principalId: 'owner', groupId: 'group', revoked: true }] },
  { principalOwners: [{ principalId: 'foreign', groupId: 'group', revoked: false }] },
  { groupOwners: [] }, { groupOwners: ['group', 'foreign'] }, { terminalClaims: 1 }, { otherPaneOwner: true },
  { backendClaims: [{ routeOwner: 'other', foreignTerminal: false }] },
  { backendClaims: [{ routeOwner: null, foreignTerminal: true }] },
  { backendClaims: [{ routeOwner: null, foreignTerminal: false }, { routeOwner: null, foreignTerminal: false }] },
])('rejects incomplete, duplicate or foreign ownership %j', patch => {
  expect(() => assertDetachedCloseOwnership({ ...ownership(), ...patch })).toThrow();
});

// Run the actual route/adapter functions without starting a service or touching
// the real user's inventory. Native process evidence is injected here; the
// provider itself has independent real Linux flock/FD/starttime tests.
const source = fs.readFileSync(new URL('../routes/terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['integrationTerminalRecord', 'integrationTmuxPresent', 'integrationRuntimeRegistered', 'verifyIntegrationRuntimeOwnership',
  'forgetIntegrationRuntime', 'observeIntegrationCloseTarget', 'inspectCollaborationTmux'];
const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && functions.includes(n.name?.text ?? '')).map(n => n.getText(ast)).join('\n');
const declaration = ast.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
  .find(n => n.name.getText(ast) === 'integrationSessionAdapter')!;
const methods = (declaration.initializer as ts.ObjectLiteralExpression).properties.filter(n => ts.isMethodDeclaration(n)
  && ['prepareRelease', 'prepareClose', 'closeRuntime', 'closeDiagnostics', 'runtimePresent', 'inspect'].includes(n.name.getText(ast)));
const compiled = ts.transpileModule(`${code}\nconst integrationSessionAdapter={${methods.map(n => n.getText(ast)).join(',')}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  let exists = true;
  const group = { id: 'group', archivedAt: 1, sessionIds: ['fixture'] };
  const binding = { serverPid: 10, sessionId: '$1', paneId: '%1', panePid: 100, agentSlug: 'fixture', nativeSessionId: 'native' };
  const record = { session_id: 'fixture', group_id: 'group', principal_id: 'owner', agent_slug: 'fixture', agent_native_session_id: 'native',
    terminal_binding: binding, profile: { nativeIdentity: { kind: 'linux-flock-owner', directory: '/owned/locks' } } };
  const layout = { serverPid: 10, sessionId: '$1', sessionName: 'wt-integration-fixture', activePaneId: '%1',
    windows: [{ active: true, panes: [{ id: '%1', pid: 100, command: 'fixture', currentPath: '/owned' }] }] };
  const native = vi.fn(async () => ({ nativeId: 'native', source: 'linux-flock-owner', failure: null }));
  const runTmux = vi.fn(async (args: string[]) => {
    if (args[0] === 'has-session') { if (!exists) throw Error('no sessions'); return ''; }
    if (args[0] === 'list-panes') return '$1 %1';
    if (args[0] === 'kill-session') { exists = false; return ''; }
    throw Error(`Unexpected tmux command: ${args[0]}`);
  });
  const context = vm.createContext({ process: { platform: 'linux' }, Date, setTimeout, record, globalSessionState: { sessions: [] },
    integrationError(code: string, message: string) { throw Object.assign(new Error(message), { code }); },
    assertDetachedCloseOwnership, integrationRecoveryOwnership: async () => ownership(),
    getTmuxLayout: vi.fn(async () => { if (!exists) throw Error('no sessions'); return layout; }), runTmux,
    getErrorMessage: String, getProcessSnapshot: async () => {},
    resolveTmuxPaneProgram: vi.fn(async () => ({ command: 'fixture', rawArgs: 'fixture resume native', source: 'tmux-tty', processPid: 200 })),
    detectAgentFromCommand: vi.fn(() => ({ slug: 'fixture' })), agentCustomCommands: () => [], observeProgramNativeIdentity: native,
    normalizeProgramName: (s: string) => s, shellNamesBackend: new Set(['sh']), selectCollaborationPane,
    integrationNativeIdentity: () => record.profile.nativeIdentity, integrationPaneIsIdleShell: async () => true,
    processStartIdentity: async () => 'linux:1', foregroundProcessInstance: async () => 'linux:2',
    terminalSessions: new Map(), collaborationRouting: { assertReadable: () => {}, hasOtherPaneOwner: vi.fn(() => false), ownerOfBackend: () => null, remove: vi.fn() },
    collaborationStore: { pendingCount: () => 0, getGroup: () => group, groupsForSession: () => group.sessionIds.includes('fixture') ? [group] : [],
      archiveSession: vi.fn(() => { group.sessionIds = []; }) },
    collaborationDeliveryWorker: { reconfigure: vi.fn(async (_id: string, action: () => Promise<void>) => action()) },
    intentionallyDeletingTmuxSessions: new Set(), cleanupSession: vi.fn(), removeGlobalSessionRecord: vi.fn(),
    persistGlobalStateNow: vi.fn(async () => {}), broadcastClientState: vi.fn(), closeSessionRuntime,
  });
  vm.runInContext(compiled, context);
  return { context, runTmux, native, record, binding, group, layout };
}
const evaluate = (f: ReturnType<typeof fixture>, code: string) => vm.runInContext(code, f.context);
it('reads current native/process facts without registering, launching, saving or terminating anything', async () => {
  const f = fixture();
  expect(await evaluate(f, 'integrationSessionAdapter.closeDiagnostics(record)')).toMatchObject({ terminal_registration_present: false,
    runtime_present: true, target_confirmed: true, code: null, target: { binding: f.binding, kind: 'agent', native_id: 'native', process_pid: 200, process_start_id: 'linux:2' } });
  expect(f.context.globalSessionState.sessions).toEqual([]);
  expect(f.context.persistGlobalStateNow).not.toHaveBeenCalled(); expect(f.context.collaborationStore.archiveSession).not.toHaveBeenCalled();
  expect(f.runTmux.mock.calls.every(([args]) => !['kill-session', 'send-keys', 'new-session'].includes(args[0]!))).toBe(true);
  expect(f.native).toHaveBeenCalledWith(expect.anything(), expect.anything(), f.record.profile.nativeIdentity);
});
it('closes the exact proved original target under the worker barrier without resurrecting inventory', async () => {
  const f = fixture();
  f.context.record.close_intent = { target: await evaluate(f, 'integrationSessionAdapter.prepareClose(record)') };
  await evaluate(f, 'integrationSessionAdapter.closeRuntime(record,false)');
  expect(f.runTmux.mock.calls.filter(([args]) => args[0] === 'kill-session')).toEqual([[['kill-session', '-t', '$1']]]);
  expect(f.context.collaborationDeliveryWorker.reconfigure).toHaveBeenCalledTimes(1);
  expect(f.context.globalSessionState.sessions).toEqual([]); expect(f.group.sessionIds).toEqual([]);
  expect(f.context.persistGlobalStateNow).toHaveBeenCalledTimes(1);
});
it.each(['argv-only', 'different-native', 'shell', 'pane-changed', 'foreign-owner', 'unreadable-routing'])('refuses unsafe detached close: %s', async mode => {
  const f = fixture();
  if (mode === 'argv-only') f.native.mockResolvedValue({ nativeId: 'native', source: 'argv', failure: null });
  if (mode === 'different-native') f.native.mockResolvedValue({ nativeId: 'other', source: 'linux-flock-owner', failure: null });
  if (mode === 'shell') f.context.detectAgentFromCommand.mockReturnValue(null);
  if (mode === 'pane-changed') f.layout.windows[0]!.panes[0]!.pid++;
  if (mode === 'foreign-owner') f.context.collaborationRouting.hasOtherPaneOwner.mockReturnValue(true);
  if (mode === 'unreadable-routing') f.context.collaborationRouting.assertReadable = () => { throw Error('unreadable'); };
  const report = await evaluate(f, 'integrationSessionAdapter.closeDiagnostics(record)');
  expect(report.target_confirmed).toBe(false); expect(report.target).toBeNull(); expect(report.code).not.toBeNull();
  await expect(evaluate(f, 'integrationSessionAdapter.prepareClose(record)')).rejects.toThrow();
  expect(f.runTmux.mock.calls.some(([args]) => args[0] === 'kill-session')).toBe(false);
});
it('rejects a changed process instance after the durable intent, without killing anything', async () => {
  const f = fixture(); f.context.record.close_intent = { target: await evaluate(f, 'integrationSessionAdapter.prepareClose(record)') };
  f.context.foregroundProcessInstance = async () => 'linux:new-instance';
  await expect(evaluate(f, 'integrationSessionAdapter.closeRuntime(record,false)')).rejects.toMatchObject({ code: 'SESSION_CLOSE_TARGET_CHANGED' });
  expect(f.runTmux.mock.calls.some(([args]) => args[0] === 'kill-session')).toBe(false);
});
it('reports missing registration rather than pretending the existing Agent has exited', async () => {
  const f = fixture();
  await expect(evaluate(f, 'integrationSessionAdapter.inspect(record)')).rejects.toMatchObject({ code: 'SESSION_TERMINAL_REGISTRATION_MISSING' });
});
it('keeps the registered failed cold-shell close path, while refusing that shell without registration', async () => {
  const f = fixture();
  f.context.detectAgentFromCommand.mockReturnValue(null);
  f.native.mockResolvedValue({ nativeId: null as never, source: null as never, failure: null });
  f.context.record.agent_native_session_id = null;
  f.context.globalSessionState.sessions = [{ sessionId: 'fixture', mode: 'tmux', tmuxSessionName: 'wt-integration-fixture', backendSessionId: 'backend' }];
  expect(await evaluate(f, 'integrationSessionAdapter.prepareClose(record)')).toMatchObject({ kind: 'shell', native_id: null, process_pid: 100 });
  f.context.globalSessionState.sessions = [];
  await expect(evaluate(f, 'integrationSessionAdapter.prepareClose(record)')).rejects.toMatchObject({ code: 'SESSION_CLOSE_TARGET_UNCONFIRMED' });
});

it.skipIf(process.platform !== 'linux')('tears down only the exact isolated real tmux after proof; leaves its neighbour alive', async () => {
  const exec = promisify(execFile), socket = `td-close-${process.pid}-${Date.now()}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  try {
    await run(['new-session', '-d', '-s', 'wt-integration-fixture', '/bin/sleep', '120']);
    await run(['new-session', '-d', '-s', 'neighbour', '/bin/sleep', '120']);
    const layout = await readTmuxLayout(run, 'wt-integration-fixture'), pane = layout.windows[0]!.panes[0]!;
    const f = fixture(); Object.assign(f.binding, { serverPid: layout.serverPid, sessionId: layout.sessionId, paneId: pane.id, panePid: pane.pid });
    f.context.runTmux = run; f.context.getTmuxLayout = (name: string) => readTmuxLayout(run, name);
    f.context.record.close_intent = { target: await evaluate(f, 'integrationSessionAdapter.prepareClose(record)') };
    await evaluate(f, 'integrationSessionAdapter.closeRuntime(record,false)');
    await expect(run(['has-session', '-t', '=wt-integration-fixture'])).rejects.toThrow();
    await expect(run(['has-session', '-t', '=neighbour'])).resolves.toBe('');
    expect(f.context.globalSessionState.sessions).toEqual([]);
  } finally { await run(['kill-server']).catch(() => {}); }
}, 10000);
