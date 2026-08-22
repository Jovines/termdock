import fs from 'fs';
import path from 'path';
import { pathValidator } from './pathValidator.js';

/**
 * Delete one regular file or symbolic link without ever recursively removing a
 * directory. Final-component symlinks are unlinked rather than followed.
 */
export async function deleteFilesystemFile(requestedPath: string): Promise<string> {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  const absolutePath = path.resolve(requestedPath);
  const requestedStat = await fs.promises.lstat(absolutePath);
  let deletionPath: string;

  if (requestedStat.isSymbolicLink()) {
    const validatedParent = await pathValidator.validateAsync(path.dirname(absolutePath));
    deletionPath = path.join(validatedParent, path.basename(absolutePath));
  } else {
    deletionPath = await pathValidator.validatePathAsync(absolutePath);
  }

  const stat = await fs.promises.lstat(deletionPath);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('Path is not a file');
  }

  await fs.promises.unlink(deletionPath);
  return deletionPath;
}
