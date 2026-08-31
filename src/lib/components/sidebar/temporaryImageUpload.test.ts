// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  TEMPORARY_FILE_UPLOAD_DIRECTORY,
  uploadTemporaryFileAndInsertReference,
} from './temporaryImageUpload';

describe('temporary file upload', () => {
  it.each([
    ['image', new File(['image-bytes'], '手机截图.png', { type: 'image/png' })],
    ['video', new File(['video-bytes'], '现场视频.mov', { type: 'video/quicktime' })],
    ['document', new File(['document-bytes'], '需求说明.pdf', { type: 'application/pdf' })],
  ])('uploads one selected %s to /tmp and inserts the returned unique path', async (_kind, file) => {
    const upload = vi.fn().mockResolvedValue({
      files: [{ name: file.name, path: `/tmp/${file.name}`, size: file.size }],
    });
    const insertReference = vi.fn();

    const uploaded = await uploadTemporaryFileAndInsertReference(file, upload, insertReference);

    expect(upload).toHaveBeenCalledWith(TEMPORARY_FILE_UPLOAD_DIRECTORY, [file]);
    expect(insertReference).toHaveBeenCalledWith(`/tmp/${file.name}`);
    expect(uploaded.path).toBe(`/tmp/${file.name}`);
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(insertReference.mock.invocationCallOrder[0]);
  });

  it('does not insert a reference when the upload returns no file', async () => {
    const image = new File(['image-bytes'], 'photo.jpg', { type: 'image/jpeg' });
    const upload = vi.fn().mockResolvedValue({ files: [] });
    const insertReference = vi.fn();

    await expect(uploadTemporaryFileAndInsertReference(image, upload, insertReference))
      .rejects.toThrow('Upload did not return a file path');
    expect(insertReference).not.toHaveBeenCalled();
  });
});
