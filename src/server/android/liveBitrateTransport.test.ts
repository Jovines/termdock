import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createFederationRuntime } from '../federation/runtime';
import { RelayClient, RelayRouter } from '../federation/relay';
import { RelaySocket } from '../../lib/federation/relaySocket';
import { connect } from '../../lib/federation/secureClient';
import router, { handleAndroidWebSocket } from '../routes/android';
import * as scrcpy from './scrcpy';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function endpoint() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  cleanup.push(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function dial(url: string) { const ws = new WebSocket(url); cleanup.push(() => ws.terminate()); await once(ws, 'open'); return ws; }

describe('live bitrate encrypted stream', () => {
  it.each([false, true])('works without a service worker, including relay-only target=%s and offline failure', async relayed => {
    vi.stubGlobal('CloseEvent', class extends Event { code = 1000; reason = ''; });
    const directory = mkdtempSync(join(tmpdir(), 'td-recording-transport-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const app = express(); app.use(express.json()); app.use('/api/android', router);
    const runtime = await createFederationRuntime(app, directory, { terminal() {}, control() {}, android: handleAndroidWebSocket });
    cleanup.push(() => runtime.close());
    const target = await endpoint();
    const wire: string[] = [];
    target.server.on('connection', ws => { ws.on('message', data => wire.push(String(data))); void runtime.accept(ws); });
    let url = target.url;
    let socketFactory = (address: string) => new WebSocket(address) as unknown as globalThis.WebSocket;
    if (relayed) {
      const entry = await endpoint();
      const relay = new RelayRouter({ authenticate: context => context as string, allowRegister: p => p === 'target', allowRoute: p => p === 'browser' });
      cleanup.push(() => relay.close());
      entry.server.on('connection', (ws, req) => { void relay.attach(ws, req.url === '/target' ? 'target' : 'browser').then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); }); });
      const registration = await dial(entry.url + '/target');
      const client = new RelayClient(registration, { targets: new Map([[runtime.serviceId, () => dial(target.url)]]) });
      cleanup.push(() => client.close());
      const registered = once(registration, 'pong'); registration.ping(); await registered;
      url = entry.url + '/browser';
      socketFactory = address => new RelaySocket(address, runtime.serviceId, next => new WebSocket(next) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket;
    }
    const client = await connect({ url, targetPeerId: runtime.serviceId, socketFactory });
    cleanup.push(() => client.close());
    const setBitrate = vi.fn(async () => true);
    const stop = vi.fn();
    const start = vi.fn();
    let eventsRef: scrcpy.ScrcpySessionEvents | undefined;
    const create = vi.spyOn(scrcpy, 'createScrcpySession').mockImplementation((_serial, events) => { eventsRef = events; return ({
      start: async () => {
        start();
        events.onHeader({ codec: 'h264', width: 800, height: 1600, deviceName: 'private-device' });
        events.onBitrateSupport?.(true);
      },
      setBitrate, stop, pauseVideo() {}, resumeVideo() {}, sendControl() { return true; },
    } as unknown as scrcpy.ScrcpySession); });
    const denied = client.openSocket('/api/android/test-device/ws');
    await vi.waitFor(() => expect(denied.readyState).toBe(3));
    expect(create).not.toHaveBeenCalled();
    const { pairingCode } = JSON.parse(readFileSync(join(directory, 'pairing.json'), 'utf8'));
    await client.request({ type: 'pair', code: pairingCode });
    const stream = client.openSocket('/api/android/test-device/ws');
    const messages: Record<string, unknown>[] = [];
    stream.onmessage = event => messages.push(JSON.parse(String(event.data)));
    await vi.waitFor(() => expect(messages.some(m => m.type === 'bitrate-support')).toBe(true));
    for (const [requestId, bitRate] of [[1, 1800000], [2, 6000000]]) {
      stream.send(JSON.stringify({ type: 'bitrate', requestId, bitRate }));
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'bitrate-result', requestId, bitRate, applied: true }));
    }
    expect(create).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(wire.every(data => !data.includes('private-device') && !data.includes('test-device') && !data.includes('bitrate'))).toBe(true);
    stream.send(JSON.stringify({ type: 'bitrate', requestId: 3, bitRate: -1 }));
    // An ordered ping acts as a barrier after invalid input.
    stream.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() => expect(messages.some(m => m.type === 'pong')).toBe(true));
    expect(setBitrate).toHaveBeenCalledTimes(2);
    const detail = 'BITRATE_ACK_TIMEOUT: requested=4000000; no device reply';
    eventsRef!.onBitrateSupport?.(false, detail);
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'bitrate-support', supported: false, detail }));
    expect(wire.every(data => !data.includes('BITRATE_ACK_TIMEOUT'))).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    stream.close(); client.close();
    expect(() => stream.send('{}')).toThrow();

  });
});
