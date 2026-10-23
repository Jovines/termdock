// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Load the emitter's real functions without executing its CLI entry point.
const source = fs.readFileSync(new URL('./agentHook.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('agentHook.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text !== 'main');
const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(failedDevices: string[] = []) {
  const writeSync = vi.fn((_fd: unknown, _buffer: Buffer, _offset: number, length: number) => length);
  const openSync = vi.fn((device: string) => {
    if (failedDevices.includes(device)) throw new Error('device gone');
    return device;
  });
  const context = vm.createContext({
    Buffer,
    setTimeout,
    fs: { constants: fs.constants, openSync, writeSync, closeSync: vi.fn(), existsSync: () => true,
      readFileSync: () => Buffer.from('TERMDOCK=1\0') },
    process: { env: { TMUX: 'socket,1,0', TMUX_PANE: '%1' } },
    execFileSync: () => '/dev/pts/101\t101\n/dev/pts/102\t102\n',
  });
  vm.runInContext(code, context);
  return { context, openSync, writeSync };
}

describe('hook delivery failure recovery', () => {
  it('continues after one observer disappears and falls back when every direct write fails', async () => {
    const oneGone = fixture(['/dev/pts/101']);
    expect(await vm.runInContext('writeToControllingTty("event", true)', oneGone.context)).toBe(true);
    expect(oneGone.writeSync).toHaveBeenCalledWith('/dev/pts/102', Buffer.from('event'), 0, 5);

    const allGone = fixture(['/dev/pts/101', '/dev/pts/102']);
    expect(await vm.runInContext('writeToControllingTty("\\x1b]777;event\\x07", true)', allGone.context)).toBe(true);
    const wire = Buffer.from('\x1bPtmux;\x1b\x1b]777;event\x07\x1b\\');
    expect(allGone.writeSync).toHaveBeenCalledWith('/dev/tty', wire, 0, wire.length);
  });

  it('writes every UTF-8 byte across short writes and rejects a stalled write without looping', async () => {
    const f = fixture();
    f.writeSync.mockImplementation((_fd, _buffer, _offset, length) => Math.min(length, 2));
    expect(await vm.runInContext('writeDev("/dev/tty", "中文!")', f.context)).toBe(true);
    const transmitted = Buffer.concat(f.writeSync.mock.calls.map(([, buffer, offset, length]) => buffer.subarray(offset, offset + Math.min(length, 2))));
    expect(transmitted.toString()).toBe('中文!');
    f.writeSync.mockReturnValue(0);
    expect(await vm.runInContext('writeDev("/dev/tty", "event")', f.context)).toBe(false);
  });

  it('retries a temporary full PTY while still delivering immediately to other observers', async () => {
    const f = fixture();
    f.writeSync.mockImplementationOnce(() => { throw Object.assign(new Error('full'), { code: 'EAGAIN' }); });
    expect(await vm.runInContext('writeToControllingTty("event", true)', f.context)).toBe(true);
    expect(f.writeSync.mock.calls.map(call => call[0])).toEqual(['/dev/pts/101', '/dev/pts/102', '/dev/pts/101']);
  });
});

describe('question tool hooks', () => {
  it('recognizes only the Agent\'s question tool and stays silent for ordinary or malformed tool calls', () => {
    const { context } = fixture();
    const event = (agent: string, payload: unknown) => {
      context.agent = agent;
      context.payload = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return vm.runInContext('effectiveEvent(agent, "tool-start", payload)', context);
    };
    expect(event('codex', { tool_name: 'request_user_input' })).toBe('question-asked');
    expect(event('claude', { tool_name: 'AskUserQuestion' })).toBe('question-asked');
    expect(event('codex', { tool_name: 'exec_command', input: 'request_user_input' })).toBeNull();
    expect(event('claude', { tool_name: 'request_user_input' })).toBeNull();
    expect(event('codex', '{}')).toBeNull();
    expect(event('codex', 'null')).toBeNull();
    expect(event('codex', '{broken')).toBeNull();
  });
});
