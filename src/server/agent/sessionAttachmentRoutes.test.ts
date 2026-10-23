import { afterEach, expect, it, vi } from 'vitest';
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
import { sessionAttachmentRoutes } from './sessionAttachmentRoutes';
import androidRouter from '../routes/android';
import { androidRecordings } from '../android/recording';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function endpoint() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  cleanup.push(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  return { server, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function dial(url: string, ready = false) {
  const ws = new WebSocket(url); cleanup.push(() => ws.terminate());
  const opened = once(ws, 'open');
  if (ready) await Promise.all([opened, once(ws, 'message')]); else await opened;
  return ws;
}
it.each([false, true])('uploads Session attachments without directory grants, encrypted and relay-only=%s', async relayed => {
  vi.stubGlobal('CloseEvent', class extends Event { code = 1000; reason = ''; });
  const directory = mkdtempSync(join(tmpdir(), 'td-session-attachment-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = express(); app.use(express.json()); app.use('/api/terminal', sessionAttachmentRoutes(join(directory, 'attachments'), id => id === 'one' ? 'stable-one' : undefined)); app.use('/api/android', androidRouter);
  const runtime = await createFederationRuntime(app, join(directory, 'federation'), { terminal() {}, control() {} }, { resolveSessionId: id => id }); cleanup.push(() => runtime.close());
  const target = await endpoint(), wire: string[] = [];
  target.server.on('connection', ws => { ws.on('message', data => wire.push(String(data))); void runtime.accept(ws); });
  let url = target.url, socketFactory = (address: string) => new WebSocket(address) as unknown as globalThis.WebSocket;
  if (relayed) {
    const entry = await endpoint();
    const router = new RelayRouter({ authenticate: context => context as string, allowRegister: id => id === 'target', allowRoute: id => id === 'browser' }); cleanup.push(() => router.close());
    entry.server.on('connection', (ws, req) => { void router.attach(ws, req.url === '/target' ? 'target' : 'browser').then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); }); });
    const registration = await dial(entry.url + '/target', true), relay = new RelayClient(registration, { targets: new Map([[runtime.serviceId, () => dial(target.url)]]) }); cleanup.push(() => relay.close());
    const registered = once(registration, 'pong'); registration.ping(); await registered;
    url = entry.url + '/browser'; socketFactory = address => new RelaySocket(address, runtime.serviceId, next => new WebSocket(next) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket;
  }
  const client = await connect({ url, targetPeerId: runtime.serviceId, socketFactory }); cleanup.push(() => client.close());
  const upload = (session = 'one', query = '') => { const body = new FormData(); body.append('files', new Blob(['private-chat-attachment']), 'image.png'); return client.fetch(`/api/terminal/${session}/chat/attachments?fileCount=1${query}`, { method: 'POST', body }); };
  await expect(upload()).rejects.toThrow();
  const grant = runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'], resources: { android: [{ serial: 'phone', access: 'view' }] } });
  const response = await upload(); expect(response.status).toBe(200); const { files } = await response.json();
  expect(files).toHaveLength(1); expect(files[0].path.startsWith(join(directory, 'attachments') + '/')).toBe(true); expect(readFileSync(files[0].path, 'utf8')).toBe('private-chat-attachment');
  const second = await upload(); expect((await second.json()).files[0].path).not.toBe(files[0].path);
  await expect(upload('one', '&dir=/tmp')).rejects.toThrow('400');
  await expect(upload('other')).rejects.toThrow();
  await expect(client.fetch('/api/terminal/fs/list?path=/tmp')).rejects.toThrow();
  const job = { id: '12345678-1234-1234-1234-123456789abc', serial: 'phone', name: 'private-recording.mp4', size: 123, startedAt: 0, status: 'recording' as const };
  const start = vi.spyOn(androidRecordings, 'start').mockResolvedValue(job);
  vi.spyOn(androidRecordings, 'info').mockImplementation(async (id, owner) => { if (id !== job.id || owner !== client.identity.peerId) throw new Error('not owned'); return job; });
  vi.spyOn(androidRecordings, 'stop').mockResolvedValue({ ...job, status: 'ready' });
  vi.spyOn(androidRecordings, 'save').mockResolvedValue('/server/private-recording.mp4');
  const post = (path: string, data = {}) => client.fetch('/api/android' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  expect((await post('/recordings', { serial: 'phone' })).status).toBe(200); expect(start).toHaveBeenCalledWith('phone', client.identity.peerId);
  expect((await post('/recordings', { serial: 'not-shared' })).status).toBe(403);
  expect((await post(`/recordings/${job.id}/stop`)).status).toBe(200);
  expect((await post(`/recordings/${job.id}/save`, { directory: '/tmp' })).status).toBe(403);
  expect((await post(`/recordings/${job.id}/save`)).status).toBe(200);
  expect((await post('/recordings/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/stop')).status).toBe(403);
  runtime.store.revoke(grant.id);
  runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
  await expect(upload()).rejects.toThrow();
  expect(wire.every(chunk => !chunk.includes('private-chat-attachment') && !chunk.includes('image.png'))).toBe(true);
  client.close(); await expect(upload()).rejects.toThrow();
});
