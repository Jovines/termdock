// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { TerminalClientAttachment, type AttachedPty } from './terminalClientAttachment.js';

function fakePty(pid: number) {
  const data = new Set<(value: string) => void>();
  const exits = new Set<(event: { exitCode: number; signal: number | null }) => void>();
  const pty = {
    pid, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (handler: (value: string) => void) => { data.add(handler); return { dispose: () => { data.delete(handler); } }; },
    onExit: (handler: (event: { exitCode: number; signal: number | null }) => void) => { exits.add(handler); return { dispose: () => { exits.delete(handler); } }; },
    emit: (value: string) => data.forEach(handler => handler(value)),
    exit: () => [...exits].forEach(handler => handler({ exitCode: 0, signal: null })),
  } satisfies AttachedPty & { emit(value: string): void; exit(): void };
  return pty;
}

it('keeps two observers output, resize, input and disconnect independent', async () => {
  const a = fakePty(1), b = fakePty(2);
  const outputA = vi.fn(), outputB = vi.fn(), exitA = vi.fn(), exitB = vi.fn();
  const left = new TerminalClientAttachment(async () => a, outputA, exitA);
  const right = new TerminalClientAttachment(async () => b, outputB, exitB);
  await left.open(48, 20); await right.open(80, 40);
  a.emit('left'); b.emit('right');
  expect(outputA.mock.calls).toEqual([['left']]);
  expect(outputB.mock.calls).toEqual([['right']]);
  left.resize(48, 10); right.write('input');
  expect(a.resize).toHaveBeenCalledWith(48, 10);
  expect(b.resize).not.toHaveBeenCalled();
  expect(a.write).not.toHaveBeenCalled();
  left.close(); left.close();
  expect(a.kill).toHaveBeenCalledTimes(1);
  expect(b.kill).not.toHaveBeenCalled();
  a.emit('stale'); a.exit();
  expect(outputA).toHaveBeenCalledTimes(1);
  expect(exitA).not.toHaveBeenCalled();
  b.exit(); expect(exitB).toHaveBeenCalledOnce();
});

it('detaches a late spawn after unsubscribe and never delivers its output', async () => {
  let resolve!: (process: AttachedPty) => void;
  const pty = fakePty(1), data = vi.fn();
  const client = new TerminalClientAttachment(() => new Promise(done => { resolve = done; }), data, vi.fn());
  const opening = client.open(48, 20);
  client.close();
  resolve(pty);
  expect(await opening).toBe(false);
  pty.emit('stale initialization');
  expect(data).not.toHaveBeenCalled();
  expect(pty.kill).toHaveBeenCalledOnce();
  expect(client.attached).toBe(false);
});

it('replaces a stream on resubscription without accepting stale callbacks', async () => {
  const first = fakePty(1), second = fakePty(2), output = vi.fn();
  const spawn = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const client = new TerminalClientAttachment(spawn, output, vi.fn());
  await client.open(48, 20);
  await client.open(48, 40);
  first.emit('old'); second.emit('new initialization');
  expect(output.mock.calls).toEqual([['new initialization']]);
  expect(first.kill).toHaveBeenCalledOnce();
  expect(client.pid).toBe(2);
  client.close();
});
