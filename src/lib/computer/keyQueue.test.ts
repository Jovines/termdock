import { afterEach, expect, it, vi } from 'vitest';
import { computerKeyQueue, type ComputerKeyEvent } from './keyQueue';
afterEach(() => vi.unstubAllGlobals());
it('sends short input immediately and orders long text before following keys without flooding one frame', () => {
  const frames: Array<FrameRequestCallback> = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frames.push(callback); return frames.length; })); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const send = vi.fn(), queue = computerKeyQueue(send);
  const text = Array.from({ length: 500 }, (_, i): ComputerKeyEvent[] => [[i, null, true], [i, null, false]]).flat();
  queue.send(text); expect(send).toHaveBeenCalledTimes(32);
  queue.send([[0xff0d, 'Enter', true], [0xff0d, 'Enter', false]]); expect(send).toHaveBeenCalledTimes(32);
  for (let i = 0; i < frames.length; i++) frames[i](i);
  expect(send.mock.calls.map(call => call[0])).toEqual([...text, [0xff0d, 'Enter', true], [0xff0d, 'Enter', false]]);
  send.mockClear(); queue.send([[97, null, true], [97, null, false]]); expect(send).toHaveBeenCalledTimes(2);
  queue.send(text); const count = send.mock.calls.length; queue.clear(); frames.at(-1)!(0); expect(send).toHaveBeenCalledTimes(count);
});

it('releases keys already sent when a frame boundary leaves their keyups queued', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const send = vi.fn(), queue = computerKeyQueue(send);
  const filler = Array.from({ length: 15 }, (): ComputerKeyEvent[] => [[97, null, true], [97, null, false]]).flat();
  queue.send([...filler, [0xffe3, 'ControlLeft', true], [98, 'KeyB', true], [98, 'KeyB', false], [0xffe3, 'ControlLeft', false]]);
  expect(send).toHaveBeenCalledTimes(32);
  queue.clear();
  expect(send.mock.calls.slice(-2).map(call => call[0])).toEqual([[98, 'KeyB', false], [0xffe3, 'ControlLeft', false]]);
});
it('continues releasing held keys if a disconnected transport throws for one release', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const send = vi.fn(), queue = computerKeyQueue(send);
  queue.send([[0xffe3, 'ControlLeft', true], [98, 'KeyB', true]]);
  send.mockImplementation(([key, , down]) => { if (key === 98 && !down) throw new Error('disconnected'); });
  expect(() => queue.clear()).not.toThrow();
  expect(send).toHaveBeenLastCalledWith([0xffe3, 'ControlLeft', false]);
});
