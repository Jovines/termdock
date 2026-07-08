import { Router } from 'express';
import { injectBranchAudit, injectChangeAudit, type BranchAuditPayload, type ChangeAuditPayload } from '../utils/changeAuditStore.js';

export function createLocalRouter(options: { token?: string | null } = {}) {
  const router = Router();

  router.post('/change-audit', (req, res) => {
    if (!options.token || req.header('X-Termdock-Local-Token') !== options.token) {
      res.status(401).json({ error: 'Unauthorized local request' });
      return;
    }

    const payload = req.body as ChangeAuditPayload;
    if (!payload || !Array.isArray(payload.records)) {
      res.status(400).json({ error: 'Expected JSON payload with records[]' });
      return;
    }

    const result = injectChangeAudit(payload);
    res.json({ ok: true, inserted: result.inserted, total: result.total });
  });

  router.post('/branch-audit', (req, res) => {
    if (!options.token || req.header('X-Termdock-Local-Token') !== options.token) {
      res.status(401).json({ error: 'Unauthorized local request' });
      return;
    }

    const payload = req.body as BranchAuditPayload;
    if (!payload || !payload.repoRoot || !payload.baseRef || !Array.isArray(payload.records)) {
      res.status(400).json({ error: 'Expected JSON payload with repoRoot, baseRef, and records[]' });
      return;
    }

    const result = injectBranchAudit(payload);
    res.json({ ok: true, inserted: result.inserted, total: result.total });
  });

  return router;
}
