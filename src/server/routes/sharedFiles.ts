import { Router } from 'express';
import { constants, promises as fs } from 'node:fs';
import { encryptedRequestResources, hasEncryptedServiceAccess } from '../federation/requestContext.js';
import { resourceHttpAllowed } from '../federation/resourceAccess.js';
import { pathValidator } from '../utils/pathValidator.js';
/** Applied before filesystem handlers as a second boundary on their exact URL. */
export const sharedFileBoundary = Router();
sharedFileBoundary.use((req, res, next) => {
  const resources = encryptedRequestResources(req);
  if (resources && !hasEncryptedServiceAccess(req) && !resourceHttpAllowed(resources, req.method, req.originalUrl)) { res.status(403).json({ error: '此路径或操作未获分享授权', code: 'SHARE_ACCESS_DENIED' }); return; }
  next();
});
sharedFileBoundary.put('/write', async (req, res) => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    if (typeof req.body?.content !== 'string' || Buffer.byteLength(req.body.content) > 1024 * 1024 || typeof req.body?.original !== 'string') { res.status(400).json({ error: '仅支持修改 1 MB 以内的文本文件' }); return; }
    const resolved = await pathValidator.validatePathAsync(requested);
    handle = await fs.open(resolved, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) { res.status(403).json({ error: '此文件无法安全修改' }); return; }
    const before = await handle.readFile('utf8');
    if (before.includes('\0') || before !== req.body.original) { res.status(409).json({ error: '文件已更新，请重新打开后再编辑' }); return; }
    // Explicit position is required after readFile advances the descriptor.
    const bytes = Buffer.from(req.body.content); let written = 0;
    while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten;
    await handle.truncate(bytes.length); await handle.sync();
    res.json({ ok: true });
  } catch { res.status(400).json({ error: '无法保存文件，请确认目录授权和文件状态' }); }
  finally { await handle?.close(); }
});
