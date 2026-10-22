import { expect, it, vi } from 'vitest';
import { TerminalInputQueue } from './terminalInputQueue.js';

it('writes ordinary keys synchronously and keeps later keys behind copy-mode exit', async () => {
  const written: string[] = [], failed = vi.fn();
  const queue = new TerminalInputQueue(data => { written.push(data); }, failed);
  queue.push(['plain']); expect(written).toEqual(['plain']);
  let ready!: () => void;
  queue.push(['first'], () => new Promise(resolve => { ready = resolve; }));
  queue.push(['\x1b[200~paste\x1b[201~']); queue.push(['last']);
  expect(written).toEqual(['plain']);
  ready(); await Promise.resolve(); await Promise.resolve();
  expect(written).toEqual(['plain', 'first', '\x1b[200~paste\x1b[201~', 'last']);
  expect(failed).not.toHaveBeenCalled();
});

it('drops pending keys after preparation fails or the display disconnects', async () => {
  const write = vi.fn(), failed = vi.fn();
  const queue = new TerminalInputQueue(write, failed);
  let reject!: (error: Error) => void;
  queue.push(['unsafe'], () => new Promise((_resolve, fail) => { reject = fail; })); queue.push(['later']);
  reject(new Error('copy-mode exit failed')); await Promise.resolve(); await Promise.resolve();
  queue.push(['after-failure']);
  expect(write).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  let ready!: () => void;
  const closing = new TerminalInputQueue(write, failed);
  closing.push(['after-disconnect'], () => new Promise(resolve => { ready = resolve; })); closing.close(); ready();
  await Promise.resolve(); expect(write).not.toHaveBeenCalled();
});

it('bounds blocked input by bytes and item count', () => {
  const write = vi.fn(), failed = vi.fn();
  const queue = new TerminalInputQueue(write, failed);
  queue.push([], () => new Promise(() => {}));
  for (let index = 0; index < 256; index++) queue.push(['x']);
  expect(failed).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
  const bytes = new TerminalInputQueue(write, failed);
  bytes.push(['x'.repeat(1024 * 1024 + 1)]);
  expect(failed).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled();
});
