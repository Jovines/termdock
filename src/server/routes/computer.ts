import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { hostname } from 'node:os';
import { Socket } from 'node:net';
import { resolveComputerHost } from './computerTarget.js';
import { handleRdpWebSocket, rdpBackendAvailable, stopRdpBridges } from './rdp.js';
import type { WebSocket } from 'ws';
import { computerLoginKey, computerPreferences } from '../shared/computerPreferences.js';
import { loadSettings, updateSettings, type SettingsDoc } from '../utils/settings.js';
import { ComputerCredentialStore } from '../utils/computerCredentials.js';

export function createComputerRouter(read = loadSettings, update = updateSettings, credentials = new ComputerCredentialStore()) {
  const router = Router();
  router.get('/status', async (_req, res) => res.json({ platform: process.platform, hostname: hostname(), rdpAvailable: await rdpBackendAvailable() }));
  router.get('/preferences', (_req, res) => {
    try {
      const saved = read().computerControl;
      const preferences = computerPreferences(saved, process.platform);
      let credentialKeys: string[] = [], credentialError = false;
      try { credentialKeys = [preferences.local, preferences.remote].filter(profile => profile.rememberLogin && credentials.has(profile)).map(computerLoginKey); }
      catch { credentialError = true; }
      res.set('Cache-Control', 'no-store').json({ preferences, configured: Boolean(saved), credentialKeys, credentialError });
    } catch { res.status(500).json({ error: 'COMPUTER_PREFERENCES_READ_FAILED' }); }
  });
  // The full-service encrypted API boundary applies to every credential route.
  router.post('/credentials/:action', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { profile, password } = req.body ?? {};
      const preferences = computerPreferences(read().computerControl, process.platform);
      const matched = [preferences.local, preferences.remote].find(value => isDeepStrictEqual(value, profile));
      const action = req.params.action;
      const allowedKeys = action === 'save' ? ['profile', 'password'] : ['profile'];
      if (!matched || !['save', 'use', 'forget'].includes(action) || Object.keys(req.body).some(key => !allowedKeys.includes(key))) {
        res.status(400).json({ error: 'INVALID_COMPUTER_CREDENTIALS' }); return;
      }
      if (action === 'forget') { credentials.forget(matched); res.json({ saved: false }); return; }
      if (!matched.rememberLogin) { res.status(400).json({ error: 'COMPUTER_LOGIN_NOT_REMEMBERED' }); return; }
      if (action === 'save') {
        if (typeof password !== 'string' || !password || password.length > 1024 || password.includes('\0')) {
          res.status(400).json({ error: 'INVALID_COMPUTER_CREDENTIALS' }); return;
        }
        credentials.save(matched, password); res.json({ saved: true }); return;
      }
      const secret = credentials.get(matched);
      if (!secret) { res.status(404).json({ error: 'COMPUTER_CREDENTIALS_MISSING' }); return; }
      // Only the authenticated service page receives it, in memory, over Noise.
      res.json({ password: secret });
    } catch { res.status(500).json({ error: 'COMPUTER_CREDENTIALS_FAILED' }); }
  });
  router.put('/preferences', (req, res) => {
    const preferences = computerPreferences(req.body, process.platform);
    // Strict projection prevents credentials and unknown fields entering settings.
    if (!req.body || !isDeepStrictEqual(preferences, req.body)) {
      res.status(400).json({ error: 'INVALID_COMPUTER_PREFERENCES' }); return;
    }
    try {
      update((settings: SettingsDoc) => { settings.computerControl = preferences; });
      res.json({ preferences });
    } catch { res.status(500).json({ error: 'COMPUTER_PREFERENCES_WRITE_FAILED' }); }
  });
  return router;
}
export default createComputerRouter();

const bridges = new Set<Socket>();
export function stopComputerBridges(): void {
  stopRdpBridges();
  for (const bridge of bridges) bridge.destroy();
  bridges.clear();
}

/** RFB bytes are base64 records inside the existing authenticated Noise tunnel.
 * The eight-record receive window applies TCP backpressure without dropping bytes. */
export function handleComputerWebSocket(socket: WebSocket, host: string, options?: { protocol?: string; port?: string }): void {
  if (options?.protocol === 'rdp') {
    handleRdpWebSocket(socket, host, Number(options.port ?? 3389)); return;
  }
  if (options?.protocol && options.protocol !== 'vnc') { socket.close(4400, 'COMPUTER_INVALID_PROTOCOL'); return; }
  let closed = false;
  let tcp: Socket | undefined;
  let sent = 0;
  let acked = 0;
  let lastAckAt = Date.now();
  let connected = false;
  const finish = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    clearInterval(flowTimer);
    if (tcp) { bridges.delete(tcp); tcp.destroy(); }
    socket.close(code, reason);
  };
  const connectTimer = setTimeout(() => finish(4408, 'COMPUTER_CONNECT_TIMEOUT'), 10_000);
  const flowTimer = setInterval(() => {
    if (sent > acked && Date.now() - lastAckAt > 30_000) finish(4408, 'COMPUTER_STREAM_TIMEOUT');
  }, 5000);
  const pump = () => {
    if (closed || !tcp) return;
    while (sent - acked < 8 && tcp.readableLength > 0) {
      const bytes = tcp.read(Math.min(tcp.readableLength, 32 * 1024)) as Buffer | null;
      if (!bytes) break;
      if (sent === acked) lastAckAt = Date.now();
      socket.send(JSON.stringify({ type: 'data', seq: ++sent, data: bytes.toString('base64') }));
      if (closed) break;
    }
  };
  socket.on('close', () => finish());
  socket.on('error', () => finish());
  socket.on('message', raw => {
    if (closed) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ack') {
        if (!Number.isSafeInteger(message.seq) || message.seq <= acked || message.seq > sent) throw new Error('INVALID_ACK');
        acked = message.seq;
        lastAckAt = Date.now();
        pump();
      } else if (message.type === 'data') {
        if (!connected || !tcp || typeof message.data !== 'string' || message.data.length > 88_000
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) throw new Error('INVALID_DATA');
        const bytes = Buffer.from(message.data, 'base64');
        if (!bytes.length || bytes.length > 64 * 1024 || tcp.writableLength + bytes.length > 1024 * 1024) throw new Error('INPUT_LIMIT');
        tcp.write(bytes);
      } else throw new Error('INVALID_MESSAGE');
    } catch { finish(4400, 'COMPUTER_INVALID_MESSAGE'); }
  });
  void (async () => {
    try {
      const address = await resolveComputerHost(host);
      if (closed) return;
      tcp = new Socket();
      bridges.add(tcp);
      tcp.setNoDelay(true);
      tcp.on('readable', pump);
      tcp.on('connect', () => { connected = true; clearTimeout(connectTimer); });
      tcp.on('end', () => finish(1000, 'COMPUTER_DISCONNECTED'));
      tcp.on('close', () => finish(1000, 'COMPUTER_DISCONNECTED'));
      tcp.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        finish(4502, code === 'ECONNREFUSED' ? 'COMPUTER_SCREEN_SHARING_OFF' : 'COMPUTER_UNREACHABLE');
      });
      tcp.connect({ host: address.address, family: address.family, port: 5900 });
    } catch (reason) { finish(4502, reason instanceof Error && /^COMPUTER_(?:INVALID_HOST|PRIVATE_HOST_ONLY)$/.test(reason.message) ? reason.message : 'COMPUTER_UNREACHABLE'); }
  })();
}
