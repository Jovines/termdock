import type { RequestHandler } from 'express';

const VALIDATED_PREVIEWS = new Set(['/terminal/fs/read', '/terminal/fs/blob', '/terminal/fs/eda-preview']);
/** Ordinary JSON callers require bodies. Preview callers explicitly handle 304. */
export const apiCachePolicy: RequestHandler = (req, res, next) => {
  if (!VALIDATED_PREVIEWS.has(req.path)) {
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
};
