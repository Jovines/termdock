// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installServiceActivityObserver } from './serviceActivityObserver.js';

const marker = '__termdockDesktopActivityObserverV1';
const originalWebSocket = window.WebSocket;

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  close(): void {
    this.dispatchEvent(new CloseEvent('close'));
  }
}

afterEach(() => {
  window.WebSocket = originalWebSocket;
  delete (window as typeof window & Record<string, unknown>)[marker];
});

describe('service activity compatibility observer', () => {
  it('derives current counts from an old page existing terminal stream', async () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const updates: Array<{ runningCount: number; reviewCount: number }> = [];
    window.addEventListener('message', (event) => {
      if (event.data?.source === 'termdock-desktop-activity-v1') updates.push(event.data.activity);
    });

    installServiceActivityObserver();
    const socket = new window.WebSocket('ws://localhost/api/terminal/agent-1/ws');
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'agent-status', agentStatus: 'working', reviewed: true }),
    }));
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'agent-status', agentStatus: 'waiting', reviewed: false }),
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(updates).toContainEqual({ runningCount: 1, reviewCount: 0 });
    expect(updates.at(-1)).toEqual({ runningCount: 0, reviewCount: 1 });
  });
});
