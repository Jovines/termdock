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
import { startAndroidRecording, stopAndroidRecording, saveAndroidRecording, listAndroidRecordings, discardAndroidRecording } from '../../lib/android/api';
import { androidRecordings } from './recording';
import router from '../routes/android';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function endpoint() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  cleanup.push(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function dial(url: string) { const ws = new WebSocket(url); cleanup.push(() => ws.terminate()); await once(ws, 'open'); return ws; }

describe('server recording encrypted API', () => {
  it.each([false, true])('works without a service worker, including relay-only target=%s and offline failure', async relayed => {
    vi.stubGlobal('CloseEvent', class extends Event { code = 1000; reason = ''; });
    const directory = mkdtempSync(join(tmpdir(), 'td-recording-transport-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const app = express(); app.use(express.json()); app.use('/api/android', router);
    const runtime = await createFederationRuntime(app, directory, { terminal() {}, control() {} });
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
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => typeof input === 'string' && input.startsWith('/api/')
      ? client.fetch(input, init) : nativeFetch(input, init));
    const job = { id: 'secret-recording', serial: 'test-device', name: 'private-video.mp4', size: 123, startedAt: 0, status: 'recording' as const };
    const start = vi.spyOn(androidRecordings, 'start').mockResolvedValue(job);
    vi.spyOn(androidRecordings, 'stop').mockResolvedValue({ ...job, status: 'ready' });
    vi.spyOn(androidRecordings, 'list').mockResolvedValue([job]);
    vi.spyOn(androidRecordings, 'save').mockResolvedValue('/server/private-video.mp4');
    vi.spyOn(androidRecordings, 'discard').mockResolvedValue();
    await expect(startAndroidRecording('test-device')).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    const { pairingCode } = JSON.parse(readFileSync(join(directory, 'pairing.json'), 'utf8'));
    await client.request({ type: 'pair', code: pairingCode });
    expect((await startAndroidRecording('test-device')).id).toBe(job.id);
    expect((await listAndroidRecordings('test-device')).recordings).toHaveLength(1);
    expect((await stopAndroidRecording(job.id)).status).toBe('ready');
    expect((await saveAndroidRecording(job.id)).path).toBe('/server/private-video.mp4');
    await discardAndroidRecording(job.id);
    expect(wire.every(data => !data.includes('private-video') && !data.includes('test-device'))).toBe(true);
    client.close();
    await expect(startAndroidRecording('test-device')).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
  });
});
