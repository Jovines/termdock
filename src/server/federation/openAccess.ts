import express from 'express';
import { isAuthEnabled } from '../utils/authProtection.js';
import { bootstrapCors } from './bootstrapCors.js';

/** Open mode is per connection and transient; it must never create persisted grants. */
export function openAccessAllowed(direct: boolean, authEnabled: boolean, action?: string): boolean {
  return direct && !authEnabled && (!action || !action.startsWith('authorization.') && !action.startsWith('route.'));
}
export function createOpenAccessRouter(serviceIdentity: () => string | undefined) {
  const router = express.Router();
  router.use(bootstrapCors);
  router.get('/parameters', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isAuthEnabled()) { res.status(403).json({ error: 'Password authentication required' }); return; }
    const identity = serviceIdentity();
    if (!identity) { res.status(503).json({ error: 'Encrypted access is starting' }); return; }
    res.json({ serviceIdentity: identity });
  });
  return router;
}
