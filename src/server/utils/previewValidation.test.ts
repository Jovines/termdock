// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Stats } from 'node:fs';
import type { Request, Response } from 'express';
import { validatePreview } from './previewValidation.js';

describe('preview conditional requests', () => {
  it('invalidates on replacement even if file size and mtime are preserved', () => {
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v), status: vi.fn().mockReturnThis(), end: vi.fn() };
    const stat = { size: 100, mtimeMs: 10, ctimeMs: 11, mtime: new Date(10) } as Stats;
    expect(validatePreview({ headers: {} } as Request, res as unknown as Response, '/file', stat, 'text-v1')).toBe(false);
    const etag = headers.get('ETag');
    expect(headers.get('Cache-Control')).toBe('private, no-cache');
    const req = { headers: { 'if-none-match': etag } } as Request;
    expect(validatePreview(req, res as unknown as Response, '/file', stat, 'text-v1')).toBe(true);
    expect(res.status).toHaveBeenCalledWith(304);
    expect(validatePreview(req, res as unknown as Response, '/file', { ...stat, ctimeMs: 12 } as Stats, 'text-v1')).toBe(false);
    expect(validatePreview(req, res as unknown as Response, '/file', stat, 'image-v1')).toBe(false);
  });
});
