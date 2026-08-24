import { describe, expect, it } from 'vitest';
import { EdaPreviewCache, requestAcceptsEtag } from './edaPreviewCache.js';

describe('EdaPreviewCache', () => {
  it('keeps recently used renders and evicts the least recently used bytes', () => {
    const cache = new EdaPreviewCache(8);
    cache.set('front', { body: Buffer.alloc(4), mimeType: 'image/svg+xml' });
    cache.set('back', { body: Buffer.alloc(4), mimeType: 'image/svg+xml' });
    expect(cache.get('front')).toBeTruthy();
    cache.set('3d', { body: Buffer.alloc(4), mimeType: 'model/gltf-binary' });

    expect(cache.get('back')).toBeUndefined();
    expect(cache.get('front')).toBeTruthy();
    expect(cache.get('3d')?.mimeType).toBe('model/gltf-binary');
    expect(cache.sizeBytes).toBe(8);
  });

  it('does not retain a single render larger than the cache budget', () => {
    const cache = new EdaPreviewCache(3);
    cache.set('large', { body: Buffer.alloc(4), mimeType: 'model/gltf-binary' });
    expect(cache.get('large')).toBeUndefined();
    expect(cache.sizeBytes).toBe(0);
  });
});

describe('requestAcceptsEtag', () => {
  it('accepts exact, weak, comma-separated and wildcard validators', () => {
    expect(requestAcceptsEtag('"eda-v1"', '"eda-v1"')).toBe(true);
    expect(requestAcceptsEtag('W/"eda-v1"', '"eda-v1"')).toBe(true);
    expect(requestAcceptsEtag('"old", W/"eda-v1"', '"eda-v1"')).toBe(true);
    expect(requestAcceptsEtag('*', '"eda-v1"')).toBe(true);
    expect(requestAcceptsEtag('"old"', '"eda-v1"')).toBe(false);
  });
});
