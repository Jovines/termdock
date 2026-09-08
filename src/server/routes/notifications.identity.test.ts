import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { markEncryptedRequest } from '../federation/requestContext';
const store = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(() => ({ updatedAt: 1 })) }));
vi.mock('../notifications/pushService', () => ({ getPushSubscription: store.get, upsertPushSubscription: store.save, getVapidPublicKey: () => 'public', removePushSubscription: vi.fn(), updatePushPreferences: vi.fn() }));
import router from './notifications';
afterEach(() => vi.clearAllMocks());
it('keys subscription reads and writes by verified device identity, not an absent or forged cookie', async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.cookies = { 'termdock-client': 'spoofed-cookie' }; markEncryptedRequest(req, 'verified-device'); next(); });
  app.use(router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(base + '/status')).status).toBe(200);
    expect(store.get).toHaveBeenCalledWith('device:verified-device');
    const response = await fetch(base + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://push.test/device', keys: { p256dh: 'key', auth: 'auth' } }, alertStyle: 'normal' }) });
    expect(response.status).toBe(200);
    expect(store.save).toHaveBeenCalledWith('device:verified-device', expect.objectContaining({ endpoint: 'https://push.test/device' }));
  } finally { server.closeAllConnections(); server.close(); }
});
