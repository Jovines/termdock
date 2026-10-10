// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { Server } from 'node:http';
import filesystemRouter from './filesystem.js';

interface UploadBody {
  files: { name: string; path: string; size: number }[];
  results: { index: number; name: string; status: string; path?: string; code?: string }[];
  code?: string;
  maxFiles?: number;
}

describe('filesystem uploads preserve every selected file', () => {
  let root: string;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'td-upload-preservation-'));
    const app = express();
    app.use('/fs', filesystemRouter);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function upload(items: { name: string; content: string }[], declaredCount?: number) {
    const body = new FormData();
    for (const item of items) body.append('files', new Blob([item.content]), item.name);
    const query = new URLSearchParams({ dir: root });
    if (declaredCount !== undefined) query.set('fileCount', String(declaredCount));
    const response = await fetch(`${origin}/fs/upload?${query}`, { method: 'POST', body });
    return { status: response.status, body: await response.json() as UploadBody };
  }

  async function uploadSizedFiles(sizes: number[]) {
    const boundary = 'td-upload-size-boundary';
    const request = http.request(`${origin}/fs/upload?dir=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const responsePromise = new Promise<{ status: number; body: UploadBody }>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', async response => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { reject(error); }
      });
    });
    const write = async (data: string | Buffer) => {
      if (!request.write(data)) await once(request, 'drain');
    };
    const chunk = Buffer.alloc(1024 * 1024, 's');
    for (const [index, size] of sizes.entries()) {
      await write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sized-${index}.bin"\r\n\r\n`);
      for (let remaining = size; remaining > 0; remaining -= chunk.length) await write(chunk.subarray(0, Math.min(remaining, chunk.length)));
      await write('\r\n');
    }
    request.end(`--${boundary}--\r\n`);
    return responsePromise;
  }

  it('keeps same-batch Unicode names and existing files in distinct final paths', async () => {
    const name = '资料.txt';
    await fs.promises.writeFile(path.join(root, name), 'existing content');
    await fs.promises.writeFile(path.join(root, '资料_1.txt'), 'existing suffix');
    const items = [{ name, content: 'A'.repeat(33) }, { name, content: 'B'.repeat(65) }];
    const result = await upload(items, 2);
    expect(result.status).toBe(200);
    expect(result.body.files.map(file => file.path).sort()).toEqual([path.join(root, '资料_2.txt'), path.join(root, '资料_3.txt')]);
    expect(result.body.results.map(item => item.status)).toEqual(['uploaded', 'uploaded']);
    for (const [index, file] of result.body.files.entries()) {
      expect(file.name).toBe(name);
      expect(file.size).toBe(Buffer.byteLength(items[index].content));
      expect(await fs.promises.readFile(file.path, 'utf8')).toBe(items[index].content);
    }
    expect(await fs.promises.readFile(path.join(root, name), 'utf8')).toBe('existing content');
    expect(await fs.promises.readFile(path.join(root, '资料_1.txt'), 'utf8')).toBe('existing suffix');
  });

  it('keeps concurrent requests with repeated names and different contents', async () => {
    const requests = Array.from({ length: 6 }, (_, index) => [
      { name: 'concurrent.txt', content: `request-${index}-first\n`.repeat(4096) },
      { name: 'concurrent.txt', content: `request-${index}-second\n`.repeat(1024) },
    ]);
    const results = await Promise.all(requests.map(items => upload(items)));
    const paths = results.flatMap(result => result.body.files.map(file => file.path));
    expect(new Set(paths).size).toBe(12);
    for (const [requestIndex, result] of results.entries()) {
      expect(result.status).toBe(200);
      for (const [fileIndex, file] of result.body.files.entries()) {
        expect(await fs.promises.readFile(file.path, 'utf8')).toBe(requests[requestIndex][fileIndex].content);
      }
    }
  });

  it('accepts all 50 files in their original order', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ name: `file-${index}.txt`, content: `content-${index}` }));
    const result = await upload(items, 50);
    expect(result.status).toBe(200);
    expect(result.body.files).toHaveLength(50);
    expect(result.body.results.map(item => item.index)).toEqual(items.map((_, index) => index));
    for (const [index, file] of result.body.files.entries()) {
      expect(file.name).toBe(items[index].name);
      expect(await fs.promises.readFile(file.path, 'utf8')).toBe(items[index].content);
    }
  });

  it.each([undefined, 50])('rejects and reports all 51 actual multipart items with declared count %s', async declaredCount => {
    await fs.promises.writeFile(path.join(root, 'file-0.txt'), 'existing');
    const items = Array.from({ length: 51 }, (_, index) => ({ name: `file-${index}.txt`, content: String(index) }));
    const result = await upload(items, declaredCount);
    expect(result.status).toBe(413);
    expect(result.body.files).toEqual([]);
    expect(result.body.code).toBe('UPLOAD_LIMIT');
    expect(result.body.maxFiles).toBe(50);
    expect(result.body.results).toHaveLength(51);
    expect(result.body.results.map(item => item.name)).toEqual(items.map(item => item.name));
    expect(result.body.results.every(item => item.status === 'failed' && item.code === 'UPLOAD_LIMIT' && item.path === undefined)).toBe(true);
    expect(await fs.promises.readdir(root)).toEqual(['file-0.txt']);
    expect(await fs.promises.readFile(path.join(root, 'file-0.txt'), 'utf8')).toBe('existing');
  });

  it('rejects a declared count over 50 before opening any destination', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const result = await upload([{ name: 'not-created.txt', content: 'x' }], 51);
    expect(result.status).toBe(413);
    expect(result.body.files).toEqual([]);
    expect(result.body.results).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.promises.readdir(root)).toEqual([]);
  });

  it('accepts exactly 100MB and rolls back a batch whose aggregate is one byte over', async () => {
    const megabyte = 1024 * 1024;
    const accepted = await uploadSizedFiles([100 * megabyte]);
    expect(accepted.status).toBe(200);
    expect(accepted.body.files[0].size).toBe(100 * megabyte);
    expect((await fs.promises.stat(accepted.body.files[0].path)).size).toBe(100 * megabyte);
    const rejected = await uploadSizedFiles([60 * megabyte, 40 * megabyte + 1]);
    expect(rejected.status).toBe(413);
    expect(rejected.body.code).toBe('UPLOAD_LIMIT');
    expect(rejected.body.files).toEqual([]);
    expect(rejected.body.results).toHaveLength(2);
    expect(await fs.promises.readdir(root)).toEqual(['sized-0.bin']);
    expect((await fs.promises.stat(accepted.body.files[0].path)).size).toBe(100 * megabyte);
  }, 15000);

  it('rejects a single truncated file over 100MB and cleans its destination', async () => {
    const rejected = await uploadSizedFiles([100 * 1024 * 1024 + 1]);
    expect(rejected.status).toBe(413);
    expect(rejected.body.files).toEqual([]);
    expect(rejected.body.results).toHaveLength(1);
    expect(await fs.promises.readdir(root)).toEqual([]);
  }, 15000);

  it('rolls back a failed batch without deleting another successful request', async () => {
    const successful = await upload([{ name: 'same.txt', content: 'keep this' }]);
    expect(successful.status).toBe(200);
    // The only fault injection is a real destination open failure. Multipart
    // parsing, successful writes and cleanup all run through the real route.
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(root, 'blocked.txt')) throw Object.assign(new Error('Disk write denied'), { code: 'EACCES' });
      return originalOpen(...args);
    });
    const result = await upload([{ name: 'same.txt', content: 'rollback' }, { name: 'blocked.txt', content: 'failed' }]);
    expect(result.status).toBe(500);
    expect(result.body.files).toEqual([]);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results.every(item => item.status === 'failed')).toBe(true);
    expect(await fs.promises.readdir(root)).toEqual(['same.txt']);
    expect(await fs.promises.readFile(successful.body.files[0].path, 'utf8')).toBe('keep this');
  });

  it('cleans reserved files after malformed multipart termination', async () => {
    const boundary = 'td-upload-malformed-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="incomplete.txt"\r\n\r\npartial content`;
    const response = await fetch(`${origin}/fs/upload?dir=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
    });
    expect(response.status).toBe(500);
    expect((await response.json()).files).toEqual([]);
    expect(await fs.promises.readdir(root)).toEqual([]);
  });

  it('drains the multipart request and cleans the batch after a destination write fails', async () => {
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === path.join(root, 'disk-full.txt')) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
      }
      return handle;
    });
    const result = await upload([
      { name: 'disk-full.txt', content: 'attempted write'.repeat(4096) },
      { name: 'following.txt', content: 'must also be rejected' },
    ]);
    expect(result.status).toBe(500);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.files).toEqual([]);
    expect(await fs.promises.readdir(root)).toEqual([]);
  });

  it('cleans partial destinations when the upload connection is canceled', async () => {
    const boundary = 'td-upload-cancellation-boundary';
    const request = http.request(`${origin}/fs/upload?dir=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    request.on('error', () => {});
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="partial.txt"\r\n\r\n${'partial content'.repeat(4096)}`);
    await vi.waitFor(async () => expect(await fs.promises.readdir(root)).toEqual(['partial.txt']));
    request.destroy();
    await vi.waitFor(async () => expect(await fs.promises.readdir(root)).toEqual([]));
  });
});
