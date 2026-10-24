// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { spawn } from 'node-pty';
import { incompleteOscSuffix } from '../utils/oscBuffer.js';
import { terminalProgramStatus, PROGRAM_STATUS_REPLY } from '../shared/programStatus.js';
import { buildHookSequence, parseAgentEvent } from '../agent/session.js';

const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
function sniffer() {
  const names = ['sniffOsc', 'parseConEmuProgressReport', 'parseOsc777NotificationBody', 'processSessionOutput', 'recordSessionOutputActivity', 'scheduleNativeStatusRecovery', 'cancelNativeStatusRecovery'];
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const context = vm.createContext({
    OSC_ANY_PATTERN: /\x1b\](\d+);([^\x07\x1b]*)(\x07|\x1b\\)/g,
    OSC_SNIFF_CAP: 512 * 1024, incompleteOscSuffix, parseAgentEvent,
    parseTitleCwd: () => null, parseOsc7Cwd: () => null,
    terminalProgramStatus, PROGRAM_STATUS_REPLY, process, Date,
    addToHistory: () => 1, broadcastEvent: vi.fn(), broadcastJsonWs: vi.fn(),
    appendAutoTitleContext: vi.fn(), searchMetadataForBackend: () => null,
    applyAgentSignals: vi.fn(), refreshGitStatus: vi.fn(),
    nativeStatusRecoveryTimers: new WeakMap(), terminalSessions: new Map(),
    setTimeout, clearTimeout, broadcastAgentStatus: vi.fn(),
  });
  vm.runInContext(ts.transpileModule(code.replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return Object.assign((buffer: string) => context.sniffOsc(buffer, '/fixture'), { context });
}

it('parses large real hook payloads across arbitrary PTY chunk boundaries', () => {
  const payload = JSON.stringify({ session_id: 'native-fixture', prompt: '中文问题"'.repeat(6000), cwd: '/work' });
  const sequence = buildHookSequence('codex', 'prompt-submit', payload);
  for (const chunkSize of [1, 127, 1024, 8192]) {
    const sniff = sniffer(); let remaining = ''; const events = [];
    for (let offset = 0; offset < sequence.length; offset += chunkSize) {
      const result = sniff(remaining + sequence.slice(offset, offset + chunkSize));
      remaining = result.remaining; events.push(...result.agentEvents);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'prompt-submit', sessionId: 'native-fixture', promptPayload: payload });
    expect(remaining).toBe('');
  }
});

it('recovers a missed Stop hook only after a matching explicit program completion and never notifies', async () => {
  vi.useFakeTimers();
  try {
    const context = sniffer().context;
    const session = { agent: { slug: 'codex', aliases: ['codex-cli'] }, agentSession: { status: 'working', message: null, presentation: null } };
    context.terminalSessions.set('fixture', session);
    context.scheduleNativeStatusRecovery('fixture', session, ['unrelated-program']);
    await vi.advanceTimersByTimeAsync(4000); expect(session.agentSession.status).toBe('working');
    context.scheduleNativeStatusRecovery('fixture', session, ['codex']);
    await vi.advanceTimersByTimeAsync(2999); expect(session.agentSession.status).toBe('working');
    await vi.advanceTimersByTimeAsync(1); expect(session.agentSession.status).toBe('idle');
    expect(context.broadcastAgentStatus).toHaveBeenCalledWith('fixture', session, false, false);
    session.agentSession.status = 'working';
    context.scheduleNativeStatusRecovery('fixture', session, ['codex']);
    context.cancelNativeStatusRecovery(session); // A later hook reports new activity.
    await vi.advanceTimersByTimeAsync(4000); expect(session.agentSession.status).toBe('working');
    context.scheduleNativeStatusRecovery('fixture', session, ['codex']);
    terminalProgramStatus(session).feed('\x1b]7501;state=working:app=codex\x07');
    await vi.advanceTimersByTimeAsync(4000); expect(session.agentSession.status).toBe('working');
  } finally { vi.useRealTimers(); }
});

it.skipIf(process.platform === 'win32')('negotiates with a real terminal program before any browser attaches and publishes native transitions without Agent notifications', async () => {
  const sniff = sniffer(), context = sniff.context;
  const session = { mode: 'shell', oscSniffBuf: '', lastOscCwd: null, lastOscTitle: null, lastPromptState: null, tuiProgress: null, ptyProcess: { write: (_data: string) => {} } };
  const script = `
    process.stdin.setRawMode(true);
    let input = '';
    process.stdin.on('data', data => {
      input += data;
      if (!input.includes(${JSON.stringify(PROGRAM_STATUS_REPLY)})) return;
      process.stdin.removeAllListeners('data');
      process.stdout.write('\\x1b]7501;state=working:app=fixture\\x07');
      setTimeout(() => process.stdout.write('\\x1b]7501;state=blocked:kind=question:app=fixture\\x07'), 50);
      setTimeout(() => process.stdout.write('\\x1b]7501;state=done:app=fixture\\x07'), 100);
      setTimeout(() => process.exit(0), 150);
    });
    process.stdout.write('\\x1b]7501;?\\x1b\\\\');
  `;
  const child = spawn(process.execPath, ['-e', script], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
  session.ptyProcess.write = data => child.write(data);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Program did not receive its native capability response')), 5000);
      child.onData(data => context.processSessionOutput('fixture-terminal', session, data, { broadcast: true }));
      child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error(`Program exited ${exitCode}`)); });
    });
    expect(context.broadcastJsonWs.mock.calls.map((call: unknown[]) => (call[1] as { tuiProgress?: { state?: string } }).tuiProgress?.state)).toEqual(['indeterminate', 'blocked', 'done']);
    expect(context.applyAgentSignals).not.toHaveBeenCalled();
    expect(session.tuiProgress).toMatchObject({ state: 'done', source: 'osc7501', app: 'fixture' });
  } finally { try { child.kill(); } catch { /* already exited */ } }
}, 7000);

it('keeps a split ST terminator, bounds unterminated input, and does not retain ordinary screen output', () => {
  const sniff = sniffer();
  const first = sniff('\x1b]9;4;3\x1b');
  expect(sniff(first.remaining + '\\').tuiProgress).toMatchObject({ state: 'indeterminate' });
  expect(incompleteOscSuffix('screen output'.repeat(10000), 0)).toBe('');
  expect(incompleteOscSuffix('\x1b]777;' + 'a'.repeat(512 * 1024), 0)).toBe('');
  expect(sniff('\x1b]9;4;0\x07').tuiProgress).toMatchObject({ state: 'remove' });
});
