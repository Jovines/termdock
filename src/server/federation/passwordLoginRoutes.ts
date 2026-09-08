import express from 'express';
import { PasswordBootstrapServer } from './passwordBootstrap.js';
import { getLoginBlockMs, getPasswordVerifier, recordLoginFailure, recordLoginSuccess } from '../utils/authProtection.js';
import { getPublicOrigin } from '../utils/publicSecurity.js';
import { bootstrapCors } from './bootstrapCors.js';
import type { FederationRuntime } from './runtime.js';

type Runtime = Pick<FederationRuntime, 'serviceId' | 'store'>;
export function createPasswordLoginRouter(getRuntime: () => Runtime | undefined) {
  const router = express.Router();
  let bootstrap: PasswordBootstrapServer | undefined;
  let runtime: Runtime | undefined;
  let computing = 0;
  const starts: number[] = [];
  const pending = new Map<string, { ip: string; origin: string; expiresAt: number }>();
  router.use(bootstrapCors);
  router.use((_req, res, next) => {
    const ready = getRuntime();
    if (!ready) { res.status(503).json({ error: 'Encrypted login is starting' }); return; }
    if (ready !== runtime) {
      runtime = ready; bootstrap = new PasswordBootstrapServer({ getPasswordHash: getPasswordVerifier, serverIdentity: ready.serviceId });
      pending.clear();
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/parameters', (_req, res) => {
    try { res.json(bootstrap!.parameters()); } catch { res.status(503).json({ error: 'Password login unavailable' }); }
  });
  router.use(express.json({ limit: '8kb' }));
  router.post('/start', async (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    while (starts.length && starts[0] <= now - 60_000) starts.shift();
    for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id);
    if (getLoginBlockMs(ip) > 0 || starts.length >= 30 || computing >= 2) {
      res.status(429).json({ error: 'Too many login attempts' }); return;
    }
    if (typeof req.body?.clientIdentity !== 'string' || typeof req.body?.startLoginRequest !== 'string' ||
        Object.keys(req.body).some(key => !['clientIdentity', 'startLoginRequest'].includes(key))) {
      res.status(400).json({ error: 'Invalid login request' }); return;
    }
    const origin = req.headers.origin ?? getPublicOrigin() ?? `${req.protocol}://${req.headers.host}`;
    starts.push(now); computing++; recordLoginFailure(ip);
    try {
      const result = await bootstrap!.start({ ...req.body, origin });
      pending.set(result.attemptId, { ip, origin, expiresAt: Date.now() + 60_000 });
      res.json(result);
    } catch { res.status(401).json({ error: 'Password authentication failed' }); }
    finally { computing--; }
  });
  router.post('/finish', async (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const origin = req.headers.origin ?? getPublicOrigin() ?? `${req.protocol}://${req.headers.host}`;
    if (typeof req.body?.attemptId !== 'string' || typeof req.body?.finishLoginRequest !== 'string' ||
        Object.keys(req.body).some(key => !['attemptId', 'finishLoginRequest'].includes(key))) {
      res.status(400).json({ error: 'Invalid login request' }); return;
    }
    const entry = pending.get(req.body.attemptId);
    if (!entry || entry.ip !== ip || entry.origin !== origin || entry.expiresAt <= Date.now()) {
      res.status(401).json({ error: 'Password authentication failed' }); return;
    }
    pending.delete(req.body.attemptId);
    try {
      const credential = getPasswordVerifier();
      const result = await bootstrap!.finish(req.body);
      if (!credential || credential !== getPasswordVerifier()) throw new Error('Password changed');
      runtime!.store.grantPassword(result.clientIdentity);
      recordLoginSuccess(ip);
      res.json({ ok: true });
    } catch { res.status(401).json({ error: 'Password authentication failed' }); }
  });
  return router;
}
