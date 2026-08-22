// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  TEMPORARY_IMAGE_UPLOAD_DIRECTORY,
  uploadTemporaryImageAndInsertReference,
} from './temporaryImageUpload';

describe('temporary image upload', () => {
  it('uploads one selected image to /tmp and inserts the returned unique path', async () => {
    const image = new File(['image-bytes'], '手机截图.png', { type: 'image/png' });
    const upload = vi.fn().mockResolvedValue({
      files: [{ name: '手机截图.png', path: '/tmp/手机截图_1.png', size: 11 }],
    });
    const insertReference = vi.fn();

    const uploaded = await uploadTemporaryImageAndInsertReference(image, upload, insertReference);

    expect(upload).toHaveBeenCalledWith(TEMPORARY_IMAGE_UPLOAD_DIRECTORY, [image]);
    expect(insertReference).toHaveBeenCalledWith('/tmp/手机截图_1.png');
    expect(uploaded.path).toBe('/tmp/手机截图_1.png');
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(insertReference.mock.invocationCallOrder[0]);
  });

  it('does not insert a reference when the upload returns no file', async () => {
    const image = new File(['image-bytes'], 'photo.jpg', { type: 'image/jpeg' });
    const upload = vi.fn().mockResolvedValue({ files: [] });
    const insertReference = vi.fn();

    await expect(uploadTemporaryImageAndInsertReference(image, upload, insertReference))
      .rejects.toThrow('Upload did not return a file path');
    expect(insertReference).not.toHaveBeenCalled();
  });
});
