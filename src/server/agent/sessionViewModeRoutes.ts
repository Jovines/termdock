import { Router } from 'express';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptedRequestSubject } from '../federation/requestContext.js';
export type SessionViewMode = 'terminal' | 'chat';
interface Preference { mode: SessionViewMode; updatedAt: number }
export class SessionViewModeStore {
  constructor(private filePath: string) {}
  private read(): Record<string, Preference> {
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw new Error('Invalid session view preferences');
      for (const value of Object.values(data.sessions) as Preference[]) if (!value || !['terminal', 'chat'].includes(value.mode) || !Number.isSafeInteger(value.updatedAt)) throw new Error('Invalid session view preference');
      return data.sessions;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  get(id: string): Preference | null { const records = this.read(); return Object.prototype.hasOwnProperty.call(records, id) ? records[id] : null; }
  set(id: string, mode: SessionViewMode): Preference {
    const records = this.read(), previous = Object.prototype.hasOwnProperty.call(records, id) ? records[id] : null;
    const next = { mode, updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1) };
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify({ version: 1, sessions: { ...records, [id]: next } }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filePath); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return next;
  }
}
export function sessionViewModeRoutes(store: SessionViewModeStore, resolve: (id: string) => string | null | undefined) {
  const router = Router();
  router.route('/:sessionId/view-mode').get((req, res) => {
    const id = encryptedRequestSubject(req) && resolve(req.params.sessionId);
    if (!id) { res.status(404).json({ error: '会话不可用' }); return; }
    res.setHeader('Cache-Control', 'no-store'); res.json(store.get(id) || { mode: null, updatedAt: 0 });
  }).put((req, res) => {
    const id = encryptedRequestSubject(req) && resolve(req.params.sessionId);
    if (!id) { res.status(404).json({ error: '会话不可用' }); return; }
    if (!req.body || Object.keys(req.body).some(key => key !== 'mode') || !['chat', 'terminal'].includes(req.body.mode)) { res.status(400).json({ error: '显示模式无效' }); return; }
    res.json(store.set(id, req.body.mode));
  });
  return router;
}
