import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BINARY_DETECTION_PREFIX_BYTES, inspectBinaryFile } from './binaryFile';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termdock-binary-file-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

describe('inspectBinaryFile', () => {
  it('detects a binary marker from only the file prefix', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, 'large.bin');
    const contents = Buffer.alloc(BINARY_DETECTION_PREFIX_BYTES * 2, 65);
    contents[256] = 0;
    await fs.promises.writeFile(filePath, contents);

    await expect(inspectBinaryFile(filePath)).resolves.toEqual({
      binary: true,
      size: contents.length,
    });
  });

  it('keeps text files eligible for diff', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, 'large.txt');
    await fs.promises.writeFile(filePath, 'text diff\n'.repeat(2_000));

    await expect(inspectBinaryFile(filePath)).resolves.toMatchObject({ binary: false });
  });

  it('lets missing files fall back to Git', async () => {
    await expect(inspectBinaryFile('/definitely/missing/termdock-file')).resolves.toBeNull();
  });
});
