// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchFileSystem, type FileWatchEvent } from './api.js';

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchFileSystem degradation', () => {
  it('delivers the rescan event and preserves the native failure for reconnect backoff', async () => {
    const events: FileWatchEvent[] = [{
      type: 'rescan-required',
      path: '/repo',
      reason: 'EMFILE: too many open files',
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([{ type: 'events', events }])));
    const received: FileWatchEvent[][] = [];

    await expect(watchFileSystem(['/repo'], (batch) => received.push(batch))).rejects.toThrow('EMFILE: too many open files');
    expect(received).toEqual([events]);
  });

  it.each(['event-storm', 'reconnected'])('treats %s rescans as healthy stream events', async (reason) => {
    const events: FileWatchEvent[] = [{ type: 'rescan-required', path: '/repo', reason }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([{ type: 'events', events }])));

    await expect(watchFileSystem(['/repo'], () => undefined)).resolves.toBeUndefined();
  });
});
