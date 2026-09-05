import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import type { Request, Response } from 'express';
import { requestAcceptsEtag } from './edaPreviewCache.js';

/** Call only after authentication, path validation and file-type/size checks. */
export function validatePreview(req: Request, res: Response, file: string, stat: Stats, representation: string): boolean {
  const revision = crypto.createHash('sha256')
    .update(JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs, representation]))
    .digest('base64url').slice(0, 24);
  const etag = `W/"preview-${revision}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'private, no-cache');
  if (!requestAcceptsEtag(req.headers['if-none-match'], etag)) return false;
  res.status(304).end();
  return true;
}
