// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { spawn } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalOutputActivity } from '../utils/terminalOutputActivity.js';
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
function pipeline(mode: 'shell' | 'tmux' = 'shell') {
  const names = ['processSessionOutput', 'cleanupSession', 'recordSessionOutputActivity', 'startTmuxPaneOutputActivity'];
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const session = { mode, oscSniffBuf: '', ptyProcess: { kill() {} }, flowPausedClientTimers: new Map(), flowPausedClients: new Set(), clients: new Map(), autoTitleTerminal: { dispose() {} } };
  const broadcastEvent = vi.fn();
  const sessions = new Map([['backend', session]]);
  const context = vm.createContext({
    Date, process, TerminalOutputActivity, terminalSessions: sessions, broadcastEvent,
    updateFocusTrackingFromOutput() {}, sniffOsc: () => ({ agentEvents: [] }), terminalProgramStatus: () => ({ feed: () => ({}) }),
    appendAutoTitleContext() {}, searchMetadataForBackend: () => null, broadcastJsonWs() {},
    terminalSamplers: new Map(), cancelLongRunningAutoTitle() {}, lastAgentStatusSnapshots: new Map(), lastGitStatusSnapshots: new Map(),
    addToHistory: () => 1, globalSessionState: { sessions: [] }, archiveAgentResumeRecord() {},
    destroyTmuxControl() {}, exitedAtBottom: new Map(), clearHistory() {}, clearTimeout,
  });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const data = (data: string, broadcast = true) => context.processSessionOutput('backend', session, data, { broadcast });
  return { context, session, sessions, broadcastEvent, data };
}
afterEach(() => vi.useRealTimers());
it('observes a persistent backend without clients, ignores replay/empty data, and disposes on cleanup', () => {
  vi.useFakeTimers(); const p = pipeline();
  p.data('restored history', false); p.data(''); vi.advanceTimersByTime(5000);
  expect(p.broadcastEvent.mock.calls.some(([, event]) => event.type === 'terminal-output-activity')).toBe(false);
  p.data('live'); vi.advanceTimersByTime(200); p.data('live again'); vi.advanceTimersByTime(400);
  expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity').map(([, event]) => event.active)).toEqual([true]);
  p.context.cleanupSession('backend', { killProcess: true }); p.data('late disposed PTY'); vi.advanceTimersByTime(5000);
  expect(p.sessions.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity')).toHaveLength(1);
});
it.skipIf(process.platform === 'win32')('qualifies and expires actual PTY output while no browser is attached', async () => {
  const p = pipeline();
  const child = spawn(process.execPath, ['-e', "process.stdout.write('start\\n'); const timer=setInterval(()=>process.stdout.write('tick\\n'),100); setTimeout(()=>clearInterval(timer),2400); setTimeout(()=>process.exit(0),10800)"], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PTY fixture timeout')), 13000);
      child.onData(p.data); child.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error(`PTY exited ${exitCode}`)); });
    });
    expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity').map(([, event]) => event.active)).toEqual([true, false]);
  } finally { p.context.cleanupSession('backend', { killProcess: true }); try { child.kill(); } catch { /* already exited */ } }
}, 14000);

it('never counts tmux render replay, resize or repeated copies of old text as program output', () => {
  vi.useFakeTimers(); const p = pipeline('tmux');
  p.data('restored screen'); vi.advanceTimersByTime(300); p.data('restored screen after resize'); vi.advanceTimersByTime(300); p.data('same old screen again'); vi.advanceTimersByTime(1000);
  expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity')).toEqual([]);
  expect('lastOutputAt' in p.session).toBe(false);
  p.context.recordSessionOutputActivity('backend', p.session); vi.advanceTimersByTime(200); p.context.recordSessionOutputActivity('backend', p.session); vi.advanceTimersByTime(400);
  expect(p.broadcastEvent).toHaveBeenCalledWith('backend', { type: 'terminal-output-activity', active: true });
  p.context.cleanupSession('backend', { killProcess: true });
});

it('replaces observation when its target changes, clears unavailable state, and never attaches an unsupported size client', () => {
  vi.useFakeTimers(); const p = pipeline('tmux');
  const readers: Array<{ target: string; output: () => void; unavailable: () => void; start: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  p.context.getTmuxBinary = () => 'tmux';
  p.context.TmuxPaneOutputObserver = class {
    start = vi.fn(); dispose = vi.fn();
    constructor(_binary: string, public target: string, public output: () => void, public unavailable: () => void) { readers.push(this); }
  };
  Object.assign(p.session, { tmuxSessionName: 'first', tmuxClientFeatures: true });
  p.context.startTmuxPaneOutputActivity('backend', p.session); expect(readers).toHaveLength(1); expect(readers[0].target).toBe('=first');
  readers[0].output(); vi.advanceTimersByTime(200); readers[0].output(); vi.advanceTimersByTime(400);
  expect(p.broadcastEvent).toHaveBeenLastCalledWith('backend', { type: 'terminal-output-activity', active: true });
  readers[0].unavailable(); expect(p.broadcastEvent).toHaveBeenLastCalledWith('backend', { type: 'terminal-output-activity', active: false });
  Object.assign(p.session, { tmuxSessionName: 'second' }); p.context.startTmuxPaneOutputActivity('backend', p.session);
  expect(readers[0].dispose).toHaveBeenCalledOnce(); expect(readers[1].target).toBe('=second');
  Object.assign(p.session, { tmuxClientFeatures: false }); p.context.startTmuxPaneOutputActivity('backend', p.session);
  expect(readers[1].dispose).toHaveBeenCalledOnce(); expect(readers).toHaveLength(2);
  p.context.cleanupSession('backend', { killProcess: true }); expect(vi.getTimerCount()).toBe(0);
});
