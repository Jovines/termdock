// @vitest-environment node
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { guardWebSocketSession } from './webSocketSecurity.js';
import { authEvents } from './authProtection.js';

const auth = vi.hoisted(() => ({ enabled: true, valid: true }));
vi.mock('./authProtection.js', async () => {
  const { EventEmitter } = await import('events');
  return {
    authEvents: new EventEmitter(),
    isAuthEnabled: () => auth.enabled,
    isUpgradeRequestAuthenticated: () => !auth.enabled || auth.valid,
  };
});

function socket() {
  const ws = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
  ws.terminate = vi.fn(() => ws.emit('close'));
  return ws;
}
beforeEach(() => { vi.useFakeTimers(); auth.enabled = true; auth.valid = true; });
afterEach(() => { vi.useRealTimers(); authEvents.removeAllListeners(); });

describe('long-lived terminal authorization', () => {
  it('terminates immediately on logout and rejects subsequent input', () => {
    const ws = socket();
    const command = vi.fn();
    ws.on('message', command);
    guardWebSocketSession(ws as unknown as WebSocket, 'cookie');
    ws.emit('message', Buffer.from('before'));
    expect(command).toHaveBeenCalledTimes(1);
    auth.valid = false;
    authEvents.emit('revoked');
    expect(ws.terminate).toHaveBeenCalled();
    ws.emit('message', Buffer.from('after'));
    expect(command).toHaveBeenCalledTimes(1);
    expect(authEvents.listenerCount('revoked')).toBe(0);
  });

  it('catches password changes even on an output-only idle connection', () => {
    const ws = socket();
    guardWebSocketSession(ws as unknown as WebSocket, 'cookie');
    auth.valid = false;
    vi.advanceTimersByTime(1000);
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('does not downgrade authenticated connections to anonymous when auth is removed', () => {
    const ws = socket();
    guardWebSocketSession(ws as unknown as WebSocket, 'cookie');
    auth.enabled = false;
    vi.advanceTimersByTime(1000);
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('rechecks previously anonymous local connections when a password is enabled', () => {
    auth.enabled = false;
    auth.valid = false;
    const ws = socket();
    const command = vi.fn();
    ws.on('message', command);
    guardWebSocketSession(ws as unknown as WebSocket, undefined);
    auth.enabled = true;
    ws.emit('message', Buffer.from('attack'));
    expect(command).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });
});
