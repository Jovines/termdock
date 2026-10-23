// @vitest-environment node
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { serverCleanup } from './serverCleanup.js';

it('closes all resources once with a single server listener', async () => {
  const server = createServer();
  const cleanup = serverCleanup(server);
  const callbacks = Array.from({ length: 20 }, () => vi.fn());
  for (const callback of callbacks) cleanup(callback);
  expect(server.listenerCount('close')).toBe(1);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1);
  server.emit('close');
  for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1);
  // Resources whose asynchronous initialization finishes after close still stop.
  const late = vi.fn(); cleanup(late);
  expect(late).toHaveBeenCalledTimes(1);
});

it('continues releasing resources when one cleanup fails', () => {
  const server = createServer(), onError = vi.fn();
  const cleanup = serverCleanup(server, onError), next = vi.fn();
  const error = new Error('cleanup failed');
  cleanup(() => { throw error; }); cleanup(next);
  server.emit('close');
  expect(onError).toHaveBeenCalledWith(error);
  expect(next).toHaveBeenCalledTimes(1);
});
