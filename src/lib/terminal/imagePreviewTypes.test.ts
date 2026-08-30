import { describe, expect, it } from 'vitest';
import { getImageMimeTypeForPath, isHeicImagePath, isPreviewableImagePath } from './api';

describe('HEIC image preview types', () => {
  it('recognizes HEIC and HEIF paths case-insensitively', () => {
    expect(getImageMimeTypeForPath('/photos/IMG_0001.HEIC')).toBe('image/heic');
    expect(getImageMimeTypeForPath('/photos/depth.heif')).toBe('image/heif');
    expect(isPreviewableImagePath('/photos/IMG_0001.HeIc')).toBe(true);
    expect(isHeicImagePath('/photos/IMG_0001.HeIc')).toBe(true);
    expect(isHeicImagePath('/photos/IMG_0001.jpg')).toBe(false);
  });
});
