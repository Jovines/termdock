import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { TmuxPaneOutputObserver, TmuxPaneOutputParser } from './tmuxPaneOutput.js';
afterEach(() => vi.useRealTimers());
it('counts only pane output, excluding snapshots, status, session metadata, command responses and empty output', () => {
  const parser = new TmuxPaneOutputParser();
  expect(parser.feed(Buffer.from('%begin 1 1 0\n%end 1 1 0\n%session-changed $0 work\n%layout-change @1 layout\n%output %0 \n'))).toBe(false);
  expect(parser.feed(Buffer.from('%out'))).toBe(false);
  expect(parser.feed(Buffer.from('put %12 '))).toBe(false);
  expect(parser.feed(Buffer.from('hello\\012world\\134text\n'))).toBe(true);
  expect(parser.feed(Buffer.from('%session-changed $0 work\n'))).toBe(false);
});
it('bounds framing memory independently of output volume and handles arbitrary chunk boundaries', () => {
  const parser = new TmuxPaneOutputParser();
  expect(parser.feed(Buffer.from('%output %7 '))).toBe(false);
  for (let i = 0; i < 8; i++) expect(parser.feed(Buffer.alloc(1_000_000, 97))).toBe(true);
  expect(JSON.stringify(parser).length).toBeLessThan(256);
  expect(parser.feed(Buffer.from('\n%window-add @2\n'))).toBe(false);
  expect(parser.feed(Buffer.alloc(1_000_000, 97))).toBe(false); // Unknown line, not output.
  expect(JSON.stringify(parser).length).toBeLessThan(256);
  expect(parser.feed(Buffer.from('\n%output %3 real\n'))).toBe(true);
});
function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
}
it('uses one read-only, size-neutral connection and no commands, then drops stale data and reconnects with backoff', () => {
  vi.useFakeTimers();
  const children: ReturnType<typeof child>[] = [];
  const spawn = vi.fn(() => { const c = child(); children.push(c); return c as unknown as ChildProcess; });
  const output = vi.fn(), unavailable = vi.fn();
  const observer = new TmuxPaneOutputObserver('tmux', '=work', output, unavailable, spawn);
  observer.start(); observer.start();
  expect(spawn).toHaveBeenCalledExactlyOnceWith('tmux', ['-u', '-C', 'attach-session', '-r', '-t', '=work'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'], env: expect.not.objectContaining({ TMUX: expect.anything(), TMUX_PANE: expect.anything() }) }));
  expect(children[0].stdin.read()).toBeNull();
  children[0].stdout.write('%session-changed $0 work\n'); expect(output).not.toHaveBeenCalled();
  children[0].stdout.write('%output %0 first\n'); expect(output).toHaveBeenCalledOnce();
  children[0].emit('error', new Error('connection lost')); children[0].emit('exit', 1);
  expect(unavailable).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
  children[0].stdout.write('%output %0 late\n'); expect(output).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000); expect(spawn).toHaveBeenCalledTimes(2);
  children[1].emit('exit', 1); vi.advanceTimersByTime(1999); expect(spawn).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1); expect(spawn).toHaveBeenCalledTimes(3);
  children[2].stdout.write('%output %0 fresh\n'); expect(output).toHaveBeenCalledTimes(2);
  observer.dispose(); children[2].emit('exit', 0); vi.advanceTimersByTime(60_000);
  expect(spawn).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  expect(children[2].kill).toHaveBeenCalledOnce();
});
it('backs off synchronous spawn failures and cancels retries when disposed', () => {
  vi.useFakeTimers(); const spawn = vi.fn(() => { throw new Error('missing binary'); });
  const observer = new TmuxPaneOutputObserver('missing', '=work', vi.fn(), vi.fn(), spawn);
  observer.start(); expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(1000); expect(spawn).toHaveBeenCalledTimes(2);
  observer.dispose(); vi.advanceTimersByTime(60_000); expect(spawn).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
