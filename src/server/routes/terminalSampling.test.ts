// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedSessionSampler, SharedSnapshotCache } from '../utils/sharedSampling.js';
import { TerminalClientAttachment } from '../utils/terminalClientAttachment.js';
import { TerminalOutputDelivery, resolveTerminalReplayCursor } from '../utils/terminalOutputDelivery.js';
import { TmuxInitialScreen } from '../utils/tmuxInitialScreen.js';

// Execute the route's actual functions without importing its boot-time tmux
// configuration or reading/writing the developer's persisted session state.
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const sseRoute = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.arguments[0]?.getText(ast) === "'/:sessionId/stream'") as ts.ExpressionStatement;
const sseHandler = (sseRoute.expression as ts.CallExpression).arguments[1].getText(ast);
function routeFunctions(names: string[], setup: string, dependencies: Record<string, unknown>) {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const context = vm.createContext({ Date, Buffer, performance, setInterval, clearInterval, setTimeout, clearTimeout, console, ...dependencies });
  vm.runInContext(ts.transpileModule(`${setup}\n${functions}`.replace(/^export /gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context;
}
afterEach(() => vi.useRealTimers());

it('shares the actual macOS ps branch across 25 calls and retries after a failure', async () => {
  vi.useFakeTimers();
  const ps = vi.fn().mockRejectedValueOnce(new Error('ps failed')).mockResolvedValue({ stdout: '' });
  const context = routeFunctions(['resolveTmuxPaneProgram'], '', {
    process: { platform: 'darwin' }, normalizeProgramName: (value: string) => value,
    shellNamesBackend: new Set(['zsh']), genericProgramNames: new Set(['node']),
    ttyProcessSnapshots: new SharedSnapshotCache(2500), execFileAsync: ps,
    selectTmuxForegroundProgram: () => null,
  });
  const pane = { command: 'node', pid: 10, tty: '/dev/ttys001' };
  await Promise.all(Array.from({ length: 25 }, () => context.resolveTmuxPaneProgram(pane)));
  expect(ps).toHaveBeenCalledOnce();
  await Promise.all(Array.from({ length: 25 }, () => context.resolveTmuxPaneProgram(pane)));
  expect(ps).toHaveBeenCalledTimes(2);
  await context.resolveTmuxPaneProgram(pane);
  expect(ps).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2501);
  await context.resolveTmuxPaneProgram(pane);
  expect(ps).toHaveBeenCalledTimes(3);
});

it('merges forced inventory refreshes and allows recovery after a rejected build', async () => {
  let finish!: (value: unknown) => void;
  const build = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const context = routeFunctions(['getSessionInventorySnapshot'], `
    let latestSessionInventory = null, latestSessionInventoryAt = 0, sessionInventoryBuildPromise = null;
    const SESSION_INVENTORY_CACHE_TTL_MS = 1500;
  `, { buildSessionInventory: build });
  const calls = Array.from({ length: 25 }, () => context.getSessionInventorySnapshot({ refresh: true }));
  expect(build).toHaveBeenCalledOnce();
  finish({ tmuxSessions: [] }); await Promise.all(calls);
  build.mockImplementationOnce(() => Promise.reject(new Error('inventory failed')));
  await expect(context.getSessionInventorySnapshot({ refresh: true })).rejects.toThrow('inventory failed');
  build.mockImplementationOnce(() => Promise.resolve({ tmuxSessions: [] }));
  await context.getSessionInventorySnapshot({ refresh: true });
  expect(build).toHaveBeenCalledTimes(3);
});

it('reconciles from one liveness snapshot, preserves unknown/new sessions, and never calls has-session', async () => {
  const inventory = {};
  const liveness = new WeakMap<object, Set<string>>();
  const entries = Array.from({ length: 9 }, (_, i) => ({ sessionId: `s${i}`, mode: 'tmux', tmuxSessionName: `t${i}` }));
  const build = vi.fn(async () => inventory);
  const hasSession = vi.fn();
  const context = routeFunctions(['reconcileClientState', 'reconcileClientStateOnce'], 'let reconcileInFlight = null;', {
    globalSessionState: { sessions: entries }, inventoryTmuxLiveness: liveness,
    getSessionInventorySnapshot: build, tmuxSessionExists: hasSession,
    terminalSessions: new Map(), broadcastClientState: vi.fn(), schedulePersistGlobalState: vi.fn(),
    getErrorMessage: String,
  });
  await Promise.all(Array.from({ length: 25 }, () => context.reconcileClientState()));
  expect(build).toHaveBeenCalledOnce();
  expect(context.globalSessionState.sessions).toHaveLength(9); // Unknown observation.
  liveness.set(inventory, new Set(['t0']));
  build.mockImplementationOnce(async () => {
    context.globalSessionState.sessions.push({ sessionId: 'new', mode: 'tmux', tmuxSessionName: 'new' });
    return inventory;
  });
  await context.reconcileClientState();
  expect(context.globalSessionState.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['s0', 'new']);
  expect(hasSession).not.toHaveBeenCalled();
});

class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  async message(value: unknown) { await this.listeners('message')[0](JSON.stringify(value)); }
}

it('keeps the real WS handler PTYs through flow pauses, while unsubscribe/reconnect initialize fresh streams', async () => {
  vi.useFakeTimers();
  const ptys: Array<{ emit(data: string): void; kill: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }> = [];
  const spawn = vi.fn(() => {
    let listener: ((data: string) => void) | undefined;
    const pty = {
      pid: ptys.length + 100, kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
      onData: (handler: (data: string) => void) => {
        listener = handler;
        queueMicrotask(() => listener?.('\x1b[?2026hfirst\x1b[?2026l'));
        return { dispose: () => { listener = undefined; } };
      },
      onExit: () => ({ dispose: () => {} }), emit: (data: string) => listener?.(data),
    };
    ptys.push(pty); return pty;
  });
  const session = { mode: 'tmux', tmuxSessionName: 'task', ptyProcess: { pid: 1 },
    clients: new Map(), cols: 80, rows: 24, cwd: '/work', activeProgram: null, agentLeftAt: null, lastPromptState: 'idle' };
  const pane = { command: 'codex', currentPath: '/work', title: 'task' };
  const layout = vi.fn(async () => ({ activePane: pane }));
  const identity = vi.fn();
  const context = routeFunctions(['handleTerminalWebSocket', 'subscribeTerminalSampling', 'sampleTerminalSession'], `
    const terminalSamplers = new Map();
    const sampledProgramSessions = new WeakSet();
    const TMUX_POLL_INTERVAL = 500, ACTIVE_PROGRAM_POLL_INTERVAL = 1200;
    globalThis.attachSse = ${sseHandler};
  `, {
    SharedSessionSampler, TerminalClientAttachment, TmuxInitialScreen, TerminalOutputDelivery, resolveTerminalReplayCursor,
    terminalSessions: new Map([['backend', session]]), wsClients: new Map(),
    outputDeliveries: new WeakMap(), independentTmuxClients: new WeakSet(), independentTmuxReplays: new WeakMap(),
    TERMINAL_STREAM_EPOCH: 'test', attachmentSpawnBackoff: { check: () => {}, spawn: (fn: () => unknown) => fn() },
    getPtyProvider: async () => ({ spawn }), getTmuxBinary: () => 'tmux', supportsTmuxClientFeatures: async () => true,
    runTmux: async () => '1 /dev/metadata', buildInteractiveColorEnvironment: (env: unknown) => env,
    buildAugmentedPath: () => '', buildTmuxAttachArgs: () => [], process, os: { homedir: () => '/tmp' },
    getCachedTmuxLayout: layout, getActivePaneFromLayout: (value: { activePane: unknown }) => value.activePane,
    getActiveProgramFromTmuxLayout: () => ({ command: 'codex', source: 'tmux-pane', rawArgs: null, updatedAt: Date.now() }),
    resolveTmuxPaneProgram: async () => ({ command: 'codex', source: 'tmux-pane', rawArgs: null }),
    getCwdFromTmuxLayout: () => pane.currentPath, shellNamesBackend: new Set(['zsh']),
    syncAgentIdentity: identity, persistActiveProgramBinding: vi.fn(), refreshGitStatus: vi.fn(), syncDynamicTmuxMetadata: vi.fn(),
    syncClientCountToTmux: vi.fn(), updateGlobalBindingForBackendSession: () => false, persistAndBroadcastGlobalState: vi.fn(),
    getPersistedActiveProgramForBackend: () => null, getErrorMessage: String,
    removeClientFlowPaused: vi.fn(), broadcastClientState: vi.fn(), setClientViewingSession: vi.fn(),
    writeSse: (response: { events: unknown[] }, event: unknown) => { response.events.push(event); return true; },
    writeResponseChunk: () => true,
    closeClient: (_session: unknown, _id: string, clientId: string) => session.clients.delete(clientId),
  });
  const sockets = Array.from({ length: 25 }, () => new Socket());
  sockets.forEach((socket, i) => context.handleTerminalWebSocket(socket, 'backend', String(i), { flowControl: true, independentTmux: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(25);
  expect(identity).toHaveBeenCalledOnce();
  const request = Object.assign(new EventEmitter(), { params: { sessionId: 'backend' }, query: {} });
  const response = { events: [] as Array<{ type: string; cwd?: string; title?: string }>, setHeader: vi.fn() };
  await context.attachSse(request, response);
  expect(response.events.some(event => event.type === 'tmux-layout')).toBe(true);
  layout.mockClear();
  await vi.advanceTimersByTimeAsync(500);
  expect(layout).toHaveBeenCalledOnce(); // one sampler, 25 WS + one SSE client
  pane.currentPath = '/second'; pane.title = 'updated';
  await vi.advanceTimersByTimeAsync(500);
  for (const value of sockets) {
    expect(value.send.mock.calls.some(([data]) => JSON.parse(data).cwd === '/second')).toBe(true);
    expect(value.send.mock.calls.some(([data]) => JSON.parse(data).title === 'updated')).toBe(true);
  }
  expect(response.events).toContainEqual({ type: 'cwd', cwd: '/second' });
  expect(response.events).toContainEqual({ type: 'shell-title', title: 'updated' });
  const socket = sockets[0];
  socket.send.mockClear();
  await socket.message({ type: 'flow-control', paused: true });
  ptys[0].emit('paused output');
  expect(socket.send).not.toHaveBeenCalled();
  await socket.message({ type: 'flow-control', paused: false });
  expect(JSON.parse(socket.send.mock.calls[0][0]).data).toBe('paused output');
  expect(spawn).toHaveBeenCalledTimes(25);
  expect(ptys[0].kill).not.toHaveBeenCalled();
  await socket.message({ type: 'input', data: 'hello\r' });
  expect(ptys[0].write).toHaveBeenCalledWith('hello\r');
  await socket.message({ type: 'output-subscription', active: false });
  expect(ptys[0].kill).toHaveBeenCalledOnce();
  await socket.message({ type: 'output-subscription', active: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(26);
  sockets.forEach(value => value.close());
  const reconnect = new Socket();
  context.handleTerminalWebSocket(reconnect, 'backend', 'reconnect', { flowControl: true, independentTmux: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(27);
  expect(reconnect.send.mock.calls.some(([data]) => JSON.parse(data).type === 'connected')).toBe(true);
  reconnect.close();
  request.emit('close');
  expect(vi.getTimerCount()).toBe(0);
});
