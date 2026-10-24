// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { spawn } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalOutputActivity } from '../utils/terminalOutputActivity.js';
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
function pipeline() {
  const names = ['processSessionOutput', 'cleanupSession'];
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const session = { mode: 'tmux', oscSniffBuf: '', ptyProcess: { kill() {} }, flowPausedClientTimers: new Map(), flowPausedClients: new Set(), clients: new Map(), autoTitleTerminal: { dispose() {} } };
  const broadcastEvent = vi.fn();
  const sessions = new Map([['backend', session]]);
  const context = vm.createContext({
    Date, process, TerminalOutputActivity, terminalSessions: sessions, broadcastEvent,
    updateFocusTrackingFromOutput() {}, sniffOsc: () => ({ agentEvents: [] }), terminalProgramStatus: () => ({ feed: () => ({}) }),
    appendAutoTitleContext() {}, searchMetadataForBackend: () => null, broadcastJsonWs() {},
    terminalSamplers: new Map(), cancelLongRunningAutoTitle() {}, lastAgentStatusSnapshots: new Map(), lastGitStatusSnapshots: new Map(),
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
  p.data('live'); vi.advanceTimersByTime(1800); p.data('live again'); vi.advanceTimersByTime(200);
  expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity').map(([, event]) => event.active)).toEqual([true]);
  p.context.cleanupSession('backend', { killProcess: true }); p.data('late disposed PTY'); vi.advanceTimersByTime(5000);
  expect(p.sessions.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity')).toHaveLength(1);
});
it.skipIf(process.platform === 'win32')('qualifies and expires actual PTY output while no browser is attached', async () => {
  const p = pipeline();
  const child = spawn(process.execPath, ['-e', "process.stdout.write('start\\n'); const timer=setInterval(()=>process.stdout.write('tick\\n'),100); setTimeout(()=>clearInterval(timer),2400); setTimeout(()=>process.exit(0),4800)"], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PTY fixture timeout')), 7000);
      child.onData(p.data); child.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error(`PTY exited ${exitCode}`)); });
    });
    expect(p.broadcastEvent.mock.calls.filter(([, event]) => event.type === 'terminal-output-activity').map(([, event]) => event.active)).toEqual([true, false]);
  } finally { p.context.cleanupSession('backend', { killProcess: true }); try { child.kill(); } catch { /* already exited */ } }
}, 8000);
