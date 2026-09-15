import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateNotifyContent } from '../agent/notifyCli.js';

export function progressRoutes(deps: {
  resolveSession(input: { sessionId?: unknown; backendSessionId?: unknown; tmuxSessionName?: unknown }): string | null;
  sessionName(id: string): string | undefined;
  send(event: { type: 'session-notice'; id: string; sessionId: string; sessionName: string; message: string; title?: string; createdAt: number }): number;
}) {
  const router = Router();
  router.post('/', (req, res) => {
    try {
      const input = req.body ?? {};
      validateNotifyContent(input);
      const sessionId = deps.resolveSession(input);
      const sessionName = sessionId ? deps.sessionName(sessionId) : undefined;
      if (!sessionId || sessionName === undefined) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: 'Cannot identify the session; run inside Termdock or pass --session <full-session-id>.' });
      const id = randomUUID();
      const connections = deps.send({ type: 'session-notice', id, sessionId, sessionName,
        message: input.message.trim(), ...(input.title === undefined ? {} : { title: input.title.trim() }), createdAt: Date.now() });
      if (!connections) return res.status(409).json({ ok: false, code: 'NO_CONNECTED_CLIENT', error: 'No connected Termdock page. Reminder was not stored.' });
      return res.json({ ok: true, id, sessionId, connections });
    } catch (error) {
      return res.status(400).json({ ok: false, code: 'INVALID_ARGUMENT', error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
