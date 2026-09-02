import { describe, expect, it, vi } from 'vitest';
import {
  buildClipboardImageFilename,
  REMOTE_FILE_DROP_DIRECTORY,
  shouldUploadDroppedFiles,
  uploadClipboardImage,
  uploadDroppedFiles,
} from './fileDropUpload.js';

describe('desktop native file drops', () => {
  it('keeps loopback drops as local paths and uploads other service drops', () => {
    expect(shouldUploadDroppedFiles('localhost')).toBe(false);
    expect(shouldUploadDroppedFiles('127.0.0.1')).toBe(false);
    expect(shouldUploadDroppedFiles('127.42.0.9')).toBe(false);
    expect(shouldUploadDroppedFiles('::1')).toBe(false);
    expect(shouldUploadDroppedFiles('[::1]')).toBe(false);
    expect(shouldUploadDroppedFiles('192.168.1.8')).toBe(true);
    expect(shouldUploadDroppedFiles('terminal.example.com')).toBe(true);
  });

  it('uploads files to the current service temporary directory and returns its paths', async () => {
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'token-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [
          { path: '/tmp/report.txt' },
          { path: '/tmp/report_1.txt' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const files = [
      new File(['first'], 'report.txt', { type: 'text/plain' }),
      new File(['second'], 'report.txt', { type: 'text/plain' }),
    ];

    await expect(uploadDroppedFiles(files, fetchRequest)).resolves.toEqual([
      '/tmp/report.txt',
      '/tmp/report_1.txt',
    ]);

    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(fetchRequest.mock.calls[1]?.[0]).toBe(
      `/api/terminal/fs/upload?dir=${encodeURIComponent(REMOTE_FILE_DROP_DIRECTORY)}`,
    );
    const request = fetchRequest.mock.calls[1]?.[1];
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({ 'X-XSRF-TOKEN': 'token-1' });
    expect(request?.body).toBeInstanceOf(FormData);
    expect((request?.body as FormData).getAll('files')).toHaveLength(2);
  });

  it('does not return partial paths when the remote upload is incomplete', async () => {
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'token-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ path: '/tmp/only-one.txt' }] }), { status: 200 }));

    await expect(uploadDroppedFiles([
      new File(['first'], 'one.txt'),
      new File(['second'], 'two.txt'),
    ], fetchRequest)).rejects.toThrow('every uploaded file path');
  });

  it('uploads a native clipboard PNG to the active service temporary directory', async () => {
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'token-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ path: '/tmp/termdock-clipboard-2026-09-02T04-05-06-000Z.png' }],
      }), { status: 200 }));
    const uploadedAt = new Date('2026-09-02T04:05:06.000Z');

    await expect(uploadClipboardImage(
      new Uint8Array([137, 80, 78, 71]).buffer,
      fetchRequest,
      uploadedAt,
    )).resolves.toBe('/tmp/termdock-clipboard-2026-09-02T04-05-06-000Z.png');

    const request = fetchRequest.mock.calls[1]?.[1];
    const file = (request?.body as FormData).get('files') as File;
    expect(file.name).toBe(buildClipboardImageFilename(uploadedAt));
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(4);
  });

  it('rejects an empty native clipboard image before making a request', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    await expect(uploadClipboardImage(new ArrayBuffer(0), fetchRequest))
      .rejects.toThrow('Clipboard image is empty');
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
