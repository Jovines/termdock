// @vitest-environment jsdom
import { Terminal } from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ bridge: undefined as any }));
vi.mock('../desktop/nativeBridge', () => ({ getTermdockDesktopBridge: () => state.bridge }));
import { createOsc52ClipboardHandler } from './osc52Clipboard';

const terminals: Terminal[] = [];
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
function setup(current = () => true) {
  const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  terminals.push(terminal);
  const failure = vi.fn(), nativeWrite = vi.fn(async (_text: string) => {});
  state.bridge = { writeClipboardText: nativeWrite };
  terminal.parser.registerOscHandler(52, createOsc52ClipboardHandler(current, failure));
  return { terminal, failure, nativeWrite };
}
afterEach(() => {
  terminals.splice(0).forEach(terminal => terminal.dispose());
  state.bridge = undefined;
  vi.restoreAllMocks();
});

it.each(['\x07', '\x1b\\', '\x9c'])('program copy reaches the client native clipboard across every split, terminated by %j', async end => {
  const { terminal, nativeWrite } = setup();
  const webWrite = vi.fn(async () => { throw new Error('user gesture required'); });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: webWrite } });
  const text = 'QUIC／HTTP/3、WebTransport 中文🙂\nnext line';
  const sequence = `\x1b]52;c;${encode(text)}${end}`;
  for (let split = 1; split < sequence.length; split++) {
    nativeWrite.mockClear();
    await write(terminal, sequence.slice(0, split));
    // xterm ends an OSC on the ESC of ST, before the final backslash.
    if (split <= sequence.length - end.length) expect(nativeWrite).not.toHaveBeenCalled();
    await write(terminal, sequence.slice(split));
    expect(nativeWrite).toHaveBeenCalledExactlyOnceWith(text);
  }
  expect(webWrite).not.toHaveBeenCalled();
});

it('ignores queries, empty/malformed/oversized payloads and keeps ordinary output', async () => {
  const { terminal, nativeWrite } = setup();
  const reply = vi.fn(); terminal.onData(reply);
  for (const payload of ['?', '', '%%%invalid', '/w==', btoa('x'.repeat(262145))]) {
    await write(terminal, `\x1b]52;c;${payload}\x07`);
  }
  await write(terminal, 'normal output');
  expect(nativeWrite).not.toHaveBeenCalled();
  expect(reply).not.toHaveBeenCalled();
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('normal output');
});

it('suppresses replay/background copies, and permits the next live copy once', async () => {
  let live = false;
  const { terminal, nativeWrite } = setup(() => live);
  const sequence = `\x1b]52;c;${encode('selected')}\x07`;
  await write(terminal, sequence);
  expect(nativeWrite).not.toHaveBeenCalled();
  live = true;
  await write(terminal, sequence);
  expect(nativeWrite).toHaveBeenCalledExactlyOnceWith('selected');
  live = false;
  await write(terminal, sequence);
  expect(nativeWrite).toHaveBeenCalledTimes(1);
});

it('reports a native failure instead of silently pretending the program copied', async () => {
  const { terminal, failure, nativeWrite } = setup();
  nativeWrite.mockRejectedValueOnce(new Error('native clipboard unavailable'));
  await write(terminal, `\x1b]52;c;${encode('selected')}\x07`);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
});

it('does not block output or report a stale failure after the owner disappears', async () => {
  let current = true, reject!: (error: Error) => void;
  const { terminal, failure, nativeWrite } = setup(() => current);
  nativeWrite.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
  await write(terminal, `\x1b]52;c;${encode('selected')}\x07prompt`);
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('prompt');
  current = false;
  reject(new Error('stale'));
  await Promise.resolve(); await Promise.resolve();
  expect(failure).not.toHaveBeenCalled();
});
