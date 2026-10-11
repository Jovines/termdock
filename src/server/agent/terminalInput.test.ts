import { afterEach, expect, it, vi } from 'vitest';
import { captureTerminalInputGuard, waitAndWriteTerminalInput } from './terminalInput.js';

afterEach(() => vi.useRealTimers());

it('awaits readiness and the actual write before finishing automation', async () => {
  vi.useFakeTimers();
  let finishWrite!: () => void;
  const write = vi.fn(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const ready = vi.fn(async attempt => attempt === 1);
  let finished = false;
  const operation = waitAndWriteTerminalInput({ assertCurrent: () => {}, ready, write })
    .then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(249);
  expect(write).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(finished).toBe(false);
  finishWrite();
  await operation;
  expect(finished).toBe(true);
});

it('rejects an old waiting automation instead of sending its prompt to a new launch', async () => {
  vi.useFakeTimers();
  let generation = 'original';
  const write = vi.fn(async () => {});
  const ready = vi.fn(async () => false);
  const operation = waitAndWriteTerminalInput({
    assertCurrent: captureTerminalInputGuard(() => generation), ready, write,
  });
  const failure = expect(operation).rejects.toThrow('TERMINAL_INPUT_TARGET_CHANGED');
  await vi.advanceTimersByTimeAsync(0);
  generation = 'replacement';
  await vi.advanceTimersByTimeAsync(250);
  await failure;
  expect(write).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledTimes(1);
});

it('rechecks runtime after an asynchronous observation, even when it reported ready', async () => {
  let generation = 'original';
  const write = vi.fn(async () => {});
  const assertCurrent = captureTerminalInputGuard(() => generation);
  await expect(waitAndWriteTerminalInput({ assertCurrent, write, ready: async () => {
    generation = 'replacement';
    return true;
  } })).rejects.toThrow('TERMINAL_INPUT_TARGET_CHANGED');
  expect(write).not.toHaveBeenCalled();
});
