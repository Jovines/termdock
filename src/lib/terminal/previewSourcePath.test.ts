import { describe, expect, it } from 'vitest';
import { readPreviewSourcePath } from './api';
describe('canonical preview source header', () => {
  it('decodes Unicode real paths and falls back for old or malformed responses', () => {
    expect(readPreviewSourcePath(new Response('', { headers: { 'X-Termdock-Source-Path': encodeURIComponent('/repo/模型/part.glb') } }), '/alias.glb')).toBe('/repo/模型/part.glb');
    for (const header of ['', '%broken', 'relative.glb', '%2Fbad%0Apath']) {
      expect(readPreviewSourcePath(new Response('', { headers: { 'X-Termdock-Source-Path': header } }), '/alias.glb')).toBe('/alias.glb');
    }
  });
});
