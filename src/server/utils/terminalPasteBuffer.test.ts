// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalPasteBuffer } from './terminalPasteBuffer.js';
const start = '\x1b[200~', end = '\x1b[201~';
afterEach(() => vi.useRealTimers());

it('never writes an unfinished paste opener or its buffered keyboard/mouse bytes', () => {
  const write = vi.fn(), buffer = new TerminalPasteBuffer(vi.fn());
  for (const fragment of [start, '/tmp/image.png', 'x', '\x1b[<64;1;1M']) {
    buffer.push(fragment).forEach(write);
  }
  expect(write).not.toHaveBeenCalled();
  buffer.clear(); // disconnect: the next connection starts with normal input
  expect(buffer.push('keyboard')).toEqual(['keyboard']);
});

it('delivers a paste once, including a fragmented end, keeping Enter outside it', () => {
  const buffer = new TerminalPasteBuffer(vi.fn());
  expect(buffer.push(`key${start}一\rtwo`)).toEqual(['key']);
  expect(buffer.push('\x1b[20')).toEqual([]);
  expect(buffer.push('1~\r')).toEqual([`${start}一\rtwo${end}`, '\r']);
  expect(buffer.push('\x1b[<64;1;1M')).toEqual(['\x1b[<64;1;1M']);
});

it('keeps simultaneous clients and complete consecutive pastes independent', () => {
  const left = new TerminalPasteBuffer(vi.fn()), right = new TerminalPasteBuffer(vi.fn());
  expect(left.push(`${start}left`)).toEqual([]);
  expect(right.push(`${start}right${end}`)).toEqual([`${start}right${end}`]);
  expect(left.push(`${end}${start}next${end}`)).toEqual([`${start}left${end}`, `${start}next${end}`]);
});

it('cancels and reports an abandoned paste instead of flushing it on timeout', () => {
  vi.useFakeTimers();
  const fail = vi.fn(), buffer = new TerminalPasteBuffer(fail);
  expect(buffer.push(`${start}pending`)).toEqual([]);
  vi.advanceTimersByTime(9_000);
  expect(buffer.push('more typing')).toEqual([]);
  vi.advanceTimersByTime(1_000); // more input must not prolong a broken paste
  expect(fail).toHaveBeenCalledOnce();
  buffer.clear();
  vi.advanceTimersByTime(10_000);
  expect(fail).toHaveBeenCalledOnce();
});

it('cancels the timeout on disconnect or completed paste', () => {
  vi.useFakeTimers();
  const fail = vi.fn(), buffer = new TerminalPasteBuffer(fail);
  buffer.push(start); buffer.clear();
  buffer.push(start); buffer.push(end);
  vi.advanceTimersByTime(20_000);
  expect(fail).not.toHaveBeenCalled();
});

it('rejects nested/oversized pastes without releasing a partial transaction', () => {
  const buffer = new TerminalPasteBuffer(vi.fn());
  expect(() => buffer.push(`${start}body${start}nested${end}`)).toThrow();
  expect(() => buffer.push(`${start}${'界'.repeat(400_000)}`)).toThrow('1 MiB');
  expect(buffer.push('normal')).toEqual(['normal']);
});

it('requires each HTTP body to contain complete pastes before any writes', () => {
  const buffer = new TerminalPasteBuffer(vi.fn());
  expect(() => buffer.complete(`prefix${start}incomplete`)).toThrow();
  expect(buffer.complete(`${start}body${end}`)).toEqual([`${start}body${end}`]);
  // A closing marker alone remains available for explicit user recovery.
  expect(buffer.complete(end)).toEqual([end]);
});
