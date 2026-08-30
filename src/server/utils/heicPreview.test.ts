import { describe, expect, it } from 'vitest';
import { HEIC_PREVIEW_MIME_TYPES, isHeicPreviewPath } from './heicPreview.js';

describe('HEIC preview helpers', () => {
  it('recognizes both HEIC extensions case-insensitively', () => {
    expect(HEIC_PREVIEW_MIME_TYPES).toEqual({ '.heic': 'image/heic', '.heif': 'image/heif' });
    expect(isHeicPreviewPath('/photos/IMG_0001.HEIC')).toBe(true);
    expect(isHeicPreviewPath('/photos/depth.HeIf')).toBe(true);
    expect(isHeicPreviewPath('/photos/not-heic.jpg')).toBe(false);
  });
});
