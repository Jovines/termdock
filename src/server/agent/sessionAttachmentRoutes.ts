import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { encryptedRequestSubject } from '../federation/requestContext.js';
import { handleFileUpload } from '../routes/filesystem.js';

/** A Session input capability may add new attachments, never choose a server path. */
export function sessionAttachmentRoutes(directory: string, resolve: (id: string) => string | null | undefined) {
  const router = Router();
  router.post('/:sessionId/chat/attachments', async (req, res) => {
    const subject = encryptedRequestSubject(req), session = subject && resolve(req.params.sessionId);
    if (!session) { res.status(404).json({ error: '会话不可用' }); return; }
    if (Object.keys(req.query).some(key => key !== 'fileCount')) { res.status(400).json({ error: '附件不能指定服务端保存目录' }); return; }
    let destination: string | undefined;
    try {
      const root = path.resolve(directory, createHash('sha256').update(session).digest('hex'));
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      if (await fs.realpath(root) !== root) throw new Error('附件目录不可用');
      destination = await fs.mkdtemp(path.join(root, 'upload-'));
      await handleFileUpload(req, res, destination);
    } catch { if (!res.headersSent && !res.destroyed) res.status(500).json({ error: '附件上传失败，请重试' }); }
    finally { if (destination) await fs.rmdir(destination).catch(() => {}); }
  });
  return router;
}
