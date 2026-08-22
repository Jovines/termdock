import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteFilesystemFile } from './deleteFilesystemFile.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termdock-delete-file-'));
  temporaryRoots.push(root);
  return root;
}

describe('deleteFilesystemFile', () => {
  it('deletes a regular file', async () => {
    const root = await createTemporaryRoot();
    const filePath = path.join(root, 'notes.txt');
    await fs.promises.writeFile(filePath, 'temporary');

    await expect(deleteFilesystemFile(filePath)).resolves.toBe(filePath);
    await expect(fs.promises.lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to delete a directory', async () => {
    const root = await createTemporaryRoot();
    const directoryPath = path.join(root, 'keep');
    await fs.promises.mkdir(directoryPath);

    await expect(deleteFilesystemFile(directoryPath)).rejects.toThrow('Path is not a file');
    await expect(fs.promises.stat(directoryPath)).resolves.toBeTruthy();
  });

  it('unlinks a symlink without deleting its target', async () => {
    const root = await createTemporaryRoot();
    const targetPath = path.join(root, 'target.txt');
    const linkPath = path.join(root, 'shortcut.txt');
    await fs.promises.writeFile(targetPath, 'keep me');
    await fs.promises.symlink(targetPath, linkPath);

    await expect(deleteFilesystemFile(linkPath)).resolves.toBe(linkPath);
    await expect(fs.promises.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('keep me');
  });
});
