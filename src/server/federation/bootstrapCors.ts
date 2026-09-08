import type { RequestHandler } from 'express';
import { isAllowedOrigin } from '../utils/requestSecurity.js';
import { secureChannelOriginAllowed } from './originPolicy.js';

/** These endpoints exchange explicit password proofs, never cookies or grants
 * from the caller's browser session. Business routes retain their strict policy. */
export const bootstrapCors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (!secureChannelOriginAllowed(origin, () => isAllowedOrigin(origin, req.headers.host))) {
    res.status(403).json({ error: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' }); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end(); return;
  }
  next();
};
