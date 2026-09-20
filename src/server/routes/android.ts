import { Router } from 'express';
import type { WebSocket } from 'ws';
import { connectDevice, disconnectDevice, listDevices, resolveAdbBinary } from '../android/adb.js';
import { createScrcpySession, resolveScrcpyBinaries, type ScrcpySession } from '../android/scrcpy.js';

import { androidRecordings } from '../android/recording.js';
import { pathValidator } from '../utils/pathValidator.js';

const router = Router();

const SERIAL_PATTERN = /^[0-9a-zA-Z_.:\-]{1,128}$/;
/** 逐帧/逐控件的诊断日志默认关闭，需要时 TERMDOCK_ANDROID_DEBUG=1 打开。 */
const DEBUG_ANDROID = process.env.TERMDOCK_ANDROID_DEBUG === '1';

export function isValidAndroidSerial(serial: string): boolean {
  return SERIAL_PATTERN.test(serial);
}

router.get('/devices', async (_req, res) => {
  try {
    const devices = await listDevices();
    let scrcpyVersion: string | null = null;
    const adbAvailable = resolveAdbBinary() !== null;
    try { scrcpyVersion = (await resolveScrcpyBinaries()).version; } catch { scrcpyVersion = null; }
    res.json({ adbAvailable, scrcpyVersion, devices });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'ADB_UNAVAILABLE', code: 'ADB_UNAVAILABLE' });
  }
});

router.post('/connect', async (req, res) => {
  const address = typeof req.body?.address === 'string' ? req.body.address : '';
  try {
    const result = await connectDevice(address);
    res.json({ ok: true, serial: result.serial, output: result.output });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ADB_CONNECT_FAILED';
    res.status(400).json({ error: message, code: message });
  }
});

router.post('/disconnect', async (req, res) => {
  const address = typeof req.body?.address === 'string' ? req.body.address : '';
  try {
    res.json({ ok: true, output: await disconnectDevice(address) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ADB_DISCONNECT_FAILED';
    res.status(400).json({ error: message, code: message });
  }
});

router.get('/recordings', async (req, res) => {
  const serial = typeof req.query.serial === 'string' ? req.query.serial : '';
  if (!isValidAndroidSerial(serial)) { res.status(400).json({ error: 'INVALID_SERIAL' }); return; }
  try { res.json({ recordings: await androidRecordings.list(serial) }); }
  catch (error) { res.status(500).json({ error: String(error) }); }
});
router.post('/recordings', async (req, res) => {
  const serial = typeof req.body?.serial === 'string' ? req.body.serial : '';
  if (!isValidAndroidSerial(serial)) { res.status(400).json({ error: 'INVALID_SERIAL' }); return; }
  try { res.json(await androidRecordings.start(serial)); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/recordings/:id/stop', async (req, res) => {
  try { res.json(await androidRecordings.stop(req.params.id)); }
  catch (error) { res.status(400).json({ error: String(error) }); }
});
router.post('/recordings/:id/save', async (req, res) => {
  try {
    const directory = req.body?.directory === undefined ? undefined
      : await (req.pathValidator ?? pathValidator).validateAsync(req.body.directory);
    res.json({ path: await androidRecordings.save(req.params.id, directory) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.delete('/recordings/:id', async (req, res) => {
  try { await androidRecordings.discard(req.params.id); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: String(error) }); }
});

export default router;

interface AndroidSocketMessage { type?: unknown; data?: unknown; seq?: unknown; bitRate?: unknown; requestId?: unknown }

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 加密隧道打开 `/api/android/:serial/ws` 后的桥接：视频帧下发、控制消息回写。 */
export function handleAndroidWebSocket(
  socket: WebSocket,
  serial: string,
  _clientId: string,
  requested: { maxSize?: number; bitRate?: number; maxFps?: number } = {},
): void {
  if (!isValidAndroidSerial(serial)) { socket.close(4400, 'INVALID_SERIAL'); return; }
  // 网络差时客户端可主动降码率/分辨率；这里对入参做边界收敛。
  const quality = {
    maxSize: clampInt(requested.maxSize, 360, 2160, 1600),
    videoBitRate: clampInt(requested.bitRate, 300_000, 30_000_000, 8_000_000),
    maxFps: clampInt(requested.maxFps, 0, 60, 0),
  };
  let closed = false;
  let inflight = 0;
  let seq = 0;
  let sent = 0;
  let acked = 0;
  let controlCount = 0;
  let lastAckAt = 0;
  let lastFrameAt = Date.now();
  let videoPaused = false;
  let androidSendSkipLogged = false;
  let session: ScrcpySession | null = null;
  // 客户端 ack 丢失时不能让视频永久暂停：超时视为丢包并恢复。
  const flowTimer = setInterval(() => {
    if (videoPaused && Date.now() - Math.max(lastAckAt, lastFrameAt) > 3000) {
      if (DEBUG_ANDROID) console.log(`[android] flow resume after ack timeout serial=${serial} inflight=${inflight} sent=${sent} acked=${acked}`);
      videoPaused = false;
      session?.resumeVideo();
    }
  }, 1000);
  const statsTimer = DEBUG_ANDROID ? setInterval(() => {
    if (sent > 0) console.log(`[android] stats serial=${serial} sent=${sent} acked=${acked} inflight=${inflight} controls=${controlCount} paused=${videoPaused}`);
  }, 10_000) : null;
  const FRAME_WINDOW = 3;

  const send = (payload: Record<string, unknown>) => {
    if (closed || socket.readyState !== 1) {
      if (!androidSendSkipLogged) { androidSendSkipLogged = true; console.log(`[android] send skipped serial=${serial} closed=${closed} readyState=${socket.readyState} type=${String(payload.type)}`); }
      return;
    }
    try { socket.send(JSON.stringify(payload)); } catch (error) {
      console.log(`[android] send failed serial=${serial} type=${String(payload.type)} ${error instanceof Error ? error.message : 'unknown'}`);
    }
  };
  const shutdown = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearInterval(flowTimer);
    if (statsTimer) clearInterval(statsTimer);
    if (DEBUG_ANDROID) console.log(`[android] session end serial=${serial} sent=${sent} acked=${acked} reason=${reason ?? 'ok'}`);
    if (reason) send({ type: 'error', message: reason });
    try { session?.stop(); } catch { /* ignore */ }
    session = null;
    try { socket.close(1000, reason ? 'error' : 'closed'); } catch { /* ignore */ }
  };

  socket.on('close', () => { closed = true; clearInterval(flowTimer); if (statsTimer) clearInterval(statsTimer); void session?.stop(); session = null; });
  socket.on('error', () => { closed = true; clearInterval(flowTimer); if (statsTimer) clearInterval(statsTimer); void session?.stop(); session = null; });

  session = createScrcpySession(serial, {
    onBitrateSupport: (supported, detail) => send({ type: 'bitrate-support', supported, detail }),
    onHeader: header => { send({ type: 'header', ...header }); },
    onFrame: frame => {
      if (closed) return;
      // 不丢任何帧：客户端慢时暂停视频 socket，用反压换低延迟。
      inflight++;
      if (DEBUG_ANDROID && (sent < 12 || frame.keyFrame)) console.log(`[android] send frame #${sent} serial=${serial} config=${frame.config} key=${frame.keyFrame} bytes=${frame.data.length}`);
      sent++;
      lastFrameAt = Date.now();
      send({
        type: 'frame', seq: ++seq, config: frame.config, key: frame.keyFrame,
        pts: frame.pts.toString(), data: frame.data.toString('base64'),
      });
      if (!videoPaused && inflight >= FRAME_WINDOW) { videoPaused = true; session?.pauseVideo(); }
    },
    onError: error => shutdown(error.message || 'SCRCPY_ERROR'),
    onClose: () => { if (!closed) { send({ type: 'closed' }); closed = true; try { socket.close(1000, 'closed'); } catch { /* ignore */ } } },
  }, quality);

  void session.start().catch(error => shutdown(error instanceof Error ? error.message : 'SCRCPY_START_FAILED'));

  socket.on('message', raw => {
    if (closed || !session) return;
    let message: AndroidSocketMessage;
    try { message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as AndroidSocketMessage; }
    catch { return; }
    switch (message.type) {
      case 'bitrate': {
        if (typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
          || typeof message.bitRate !== 'number' || !Number.isInteger(message.bitRate)
          || message.bitRate < 300_000 || message.bitRate > 30_000_000) return;
        const requestId = message.requestId, bitRate = message.bitRate;
        const current = session;
        void current.setBitrate(bitRate).then(applied => send({ type: 'bitrate-result', requestId, bitRate, applied, detail: current.bitrateFailure }));
        break;
      }
      case 'control': {
        if (typeof message.data !== 'string' || message.data.length > 64 * 1024) return;
        const bytes = Buffer.from(message.data, 'base64');
        const ok = session.sendControl(bytes);
        if (DEBUG_ANDROID && controlCount++ < 8) {
          const detail = bytes[0] === 2 && bytes.length >= 32
            ? ` touch action=${bytes[1]} x=${bytes.readUInt32BE(10)} y=${bytes.readUInt32BE(14)} size=${bytes.readUInt16BE(18)}x${bytes.readUInt16BE(20)}`
            : ` type=${bytes[0]}`;
          console.log(`[android] control #${controlCount} serial=${serial} bytes=${bytes.length} written=${ok}${detail}`);
        }
        break;
      }
      case 'ack': {
        if (typeof message.seq === 'number') {
          inflight = Math.max(0, inflight - 1);
          acked++;
          lastAckAt = Date.now();
          if (videoPaused && inflight < FRAME_WINDOW) { videoPaused = false; session?.resumeVideo(); }
        }
        break;
      }
      case 'ping': send({ type: 'pong' }); break;
      default: break;
    }
  });
}
