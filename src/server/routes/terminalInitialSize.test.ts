// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { TerminalClientAttachment } from '../utils/terminalClientAttachment.js';
import { TerminalInputQueue } from '../utils/terminalInputQueue.js';
import { TerminalPasteBuffer } from '../utils/terminalPasteBuffer.js';
import { TerminalOutputDelivery, resolveTerminalReplayCursor } from '../utils/terminalOutputDelivery.js';
import { TmuxInitialScreen } from '../utils/tmuxInitialScreen.js';
import { readTmuxObserverSize } from '../utils/tmuxObserverSize.js';
import { TmuxDisplayGeometry } from '../utils/tmuxDisplayGeometry.js';
import { buildTmuxAttachArgs } from '../utils/tmuxClientCapabilities.js';
import { claimTmuxSize } from '../utils/tmuxSizeOwnership.js';
import { redrawTmuxClient } from '../utils/tmuxClientRedraw.js';
import { PtySpawnDeferredError } from '../utils/ptySpawnBackoff.js';
import { buildAtomicTerminalReplay } from '../../lib/terminal/replayPresentation.js';

// Run the actual handler without importing the route's persistent session state.
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const handler = ast.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'handleTerminalWebSocket')!.getText(ast).replace(/^export /, '');
class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  frames: Array<{ type: string; replayChunks?: string[]; cols?: number; rows?: number; data?: string }> = [];
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  async message(value: unknown) { await this.listeners('message')[0](JSON.stringify(value)); }
}

it('retains the window throughout refresh and presents the measured grid without a second redraw', async () => {
  const exec = promisify(execFile);
  const socketName = `termdock-initial-size-${randomUUID()}`;
  const runTmux = async (args: string[]) => (await exec('tmux', ['-L', socketName, ...args])).stdout;
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  const processes: import('node-pty').IPty[] = [];
  const sockets: Socket[] = [];
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const spawn = (cols: number, rows: number, args = buildTmuxAttachArgs('task', true)) => {
    const display = pty.spawn('tmux', ['-L', socketName, ...args], {
      cols, rows, name: 'xterm-256color', env: { ...process.env, TMUX: '' },
    });
    processes.push(display);
    return display;
  };
  try {
    await runTmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'task', '-x', '60', '-y', '20',
      `sh -c 'i=0; while [ "$i" -lt 1500 ]; do printf "OLDER_%s\\n" "$i"; i=$((i + 1)); done; printf "\\033[H\\033[2JSESSION_CONTENT"; exec sleep 30'`]);
    await vi.waitFor(async () => expect(await runTmux(['capture-pane', '-p', '-t', 'task'])).toContain('SESSION_CONTENT'));
    await runTmux(['set-option', '-t', 'task', 'status', 'off']);
    await runTmux(['set-window-option', '-t', 'task', 'window-size', 'latest']);
    const metadata = spawn(60, 20, ['-u', '-T', 'RGB,sync', 'attach-session', '-t', 'task']);
    metadata.onData(() => {});
    await vi.waitFor(async () => expect((await runTmux(['list-clients', '-t', 'task', '-F', '#{client_pid}']))
      .trim().split('\n')).toHaveLength(1));
    const wsClients = new Map();
    const tmuxAttachments = new WeakMap();
    const session = { mode: 'tmux', tmuxSessionName: 'task', ptyProcess: metadata, cols: 60, rows: 20, cwd: os.tmpdir() };
    const redraw = vi.fn(redrawTmuxClient);
    const provider = { spawn: (_binary: string, args: string[], options: { cols: number; rows: number }) => spawn(options.cols, options.rows, args) };
    const getProvider = vi.fn(async () => provider);
    let io = Promise.resolve<unknown>(undefined);
    const context = vm.createContext({
      Date, Buffer, performance, setTimeout, clearTimeout, console, process, os,
      TerminalClientAttachment, TerminalInputQueue, TerminalPasteBuffer, TmuxInitialScreen, TmuxDisplayGeometry,
      TerminalOutputDelivery, resolveTerminalReplayCursor, buildTmuxAttachArgs, claimTmuxSize, redrawTmuxClient: redraw, PtySpawnDeferredError,
      terminalSessions: new Map([['backend', session]]), wsClients, tmuxAttachments,
      outputDeliveries: new WeakMap(), independentTmuxClients: new WeakSet(), independentTmuxReplays: new WeakMap(),
      TERMINAL_STREAM_EPOCH: 'test', attachmentSpawnBackoff: { check() {}, spawn: (fn: () => unknown) => fn() },
      getPtyProvider: getProvider,
      getTmuxBinary: () => 'tmux', supportsTmuxClientFeatures: async () => true, runTmux,
      buildInteractiveColorEnvironment: (env: unknown) => env, buildAugmentedPath: () => process.env.PATH,
      getCachedTmuxLayout: async () => null, getActiveProgramFromTmuxLayout: () => null,
      getPersistedActiveProgramForBackend: () => null, subscribeTerminalSampling: () => () => {},
      syncClientCountToTmux() {}, updateGlobalBindingForBackendSession: () => false, persistAndBroadcastGlobalState() {},
      removeClientFlowPaused() {}, broadcastClientState() {}, getErrorMessage: String, broadcastJsonWs() {},
      enqueueTmuxIo: (_session: unknown, operation: () => Promise<unknown>) => { const next = io.then(operation); io = next.catch(() => {}); return next; },
    });
    vm.runInContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const connect = async (id: string, cols: number, rows: number, active = true) => {
      const socket = new Socket(); sockets.push(socket);
      context.handleTerminalWebSocket(socket, 'backend', id, { independentTmux: true, flowControl: true, outputActive: active }, { cols, rows });
      await vi.waitFor(() => expect(socket.frames.some(frame => frame.type === 'connected')).toBe(true));
      return socket;
    };
    const present = async (socket: Socket, cols: number, rows: number) => {
      const connected = socket.frames.filter(frame => frame.type === 'connected').at(-1)!;
      expect(connected).toMatchObject({ cols, rows });
      terminal.resize(cols, rows);
      await new Promise<void>(resolve => terminal.write(buildAtomicTerminalReplay(connected.replayChunks ?? []).join(''), resolve));
      const lines = Array.from({ length: rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '');
      expect(lines.join('\n')).toContain('SESSION_CONTENT');
      expect(lines.join('\n')).not.toContain('OLDER_');
      expect(lines.join('\n'), 'the first presented grid must have no old-size tmux padding').not.toContain('·');
      expect((await runTmux(['display-message', '-p', '-t', 'task', '#{window_width}x#{window_height}'])).trim(), 'tmux must already use the destination grid before presentation').toBe(`${cols}x${rows}`);
    };
    const windowSize = async () => (await runTmux(['display-message', '-p', '-t', 'task', '#{window_width}x#{window_height}'])).trim();
    const onlyObserver = async () => vi.waitFor(async () => expect((await runTmux(['list-clients', '-t', 'task', '-F', '#{client_pid}']))
      .trim().split('\n')).toHaveLength(1));
    const first = await connect('desktop', 120, 40);
    await present(first, 120, 40);
    expect(redraw, 'initial opening must not wait for a forced second redraw').not.toHaveBeenCalled();
    await first.message({ type: 'resize', cols: 120, rows: 40, seq: 1 });
    expect(first.frames.at(-1)).toMatchObject({ type: 'resize-ack', ok: true, cols: 120, rows: 40 });
    expect(session).toMatchObject({ cols: 120, rows: 40 });
    first.close();
    await onlyObserver();
    expect(await windowSize(), 'refresh itself must not collapse the window to 80x24').toBe('120x40');
    expect(await readTmuxObserverSize(runTmux, '=task')).toEqual({ cols: 120, rows: 40 });

    // Refresh, immediately enter a not-yet-mounted session, and change the
    // viewport on another reload. Each first replay already fills its grid.
    const reopened = await connect('desktop-refresh', 120, 40);
    await present(reopened, 120, 40);
    await reopened.message({ type: 'resize', cols: 140, rows: 45, seq: 2 });
    reopened.close(); await onlyObserver();
    expect(await windowSize()).toBe('140x45');
    const resized = await connect('desktop-resized-refresh', 140, 45);
    await present(resized, 140, 45);
    expect(redraw).not.toHaveBeenCalled();

    // An offscreen retained terminal must not overwrite the fallback size.
    const passive = new Socket(); sockets.push(passive);
    context.handleTerminalWebSocket(passive, 'backend', 'retained-offscreen', { independentTmux: true, flowControl: true });
    await vi.waitFor(() => expect(passive.frames.some(frame => frame.type === 'connected')).toBe(true));
    expect(await windowSize()).toBe('140x45');
    expect(session).toMatchObject({ cols: 140, rows: 45 });
    passive.close(); resized.close(); await onlyObserver();

    const beforeBackground = processes.length;
    const background = await connect('background', 50, 16, false);
    expect(processes).toHaveLength(beforeBackground);
    expect(await windowSize()).toBe('140x45');
    await background.message({ type: 'output-subscription', active: true });
    await vi.waitFor(() => expect(background.frames.filter(frame => frame.type === 'connected')).toHaveLength(2));
    await present(background, 50, 16);
    background.close(); await onlyObserver();
    expect(await windowSize()).toBe('50x16');

    // Cancel while provider initialization is pending, then immediately resume.
    let releaseProvider!: () => void;
    const heldProvider = new Promise<void>(resolve => { releaseProvider = resolve; });
    let providerStarted = false;
    getProvider.mockImplementationOnce(async () => {
      providerStarted = true;
      await heldProvider;
      return provider;
    });
    const interrupted = new Socket(); sockets.push(interrupted);
    context.handleTerminalWebSocket(interrupted, 'backend', 'interrupted', { independentTmux: true, flowControl: true }, { cols: 100, rows: 32 });
    await vi.waitFor(() => expect(providerStarted).toBe(true));
    await interrupted.message({ type: 'output-subscription', active: false });
    const resuming = interrupted.message({ type: 'output-subscription', active: true });
    expect(interrupted.frames.some(frame => frame.type === 'connected')).toBe(false);
    releaseProvider(); await resuming;
    await vi.waitFor(() => expect(interrupted.frames.filter(frame => frame.type === 'connected')).toHaveLength(1));
    await present(interrupted, 100, 32);
    interrupted.close(); await onlyObserver();

    // The browser no longer retains output history: it remains in tmux,
    // including the copy-mode viewport when a fresh display client attaches.
    expect(Number((await runTmux(['display-message', '-p', '-t', 'task', '#{history_size}'])).trim())).toBeGreaterThan(1000);
    await runTmux(['copy-mode', '-t', 'task']);
    await runTmux(['send-keys', '-t', 'task', '-X', 'history-top']);
    const historyViewer = await connect('history-viewer', 100, 32);
    const screen = historyViewer.frames.find(frame => frame.type === 'connected')!;
    await new Promise<void>(resolve => terminal.write(buildAtomicTerminalReplay(screen.replayChunks ?? []).join(''), resolve));
    const historyScreen = Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');
    expect(historyScreen).toContain('OLDER_0');
    expect((await runTmux(['display-message', '-p', '-t', 'task', '#{pane_in_mode}'])).trim()).toBe('1');
    historyViewer.close(); await onlyObserver();
    await runTmux(['send-keys', '-t', 'task', '-X', 'cancel']);
    await present(await connect('after-history', 100, 32), 100, 32);
  } finally {
    sockets.forEach(socket => socket.close()); terminal.dispose();
    processes.forEach(display => { try { display.kill(); } catch {} });
    await runTmux(['kill-server']).catch(() => {});
  }
}, 15000);
