import fs from 'fs';

export const BINARY_DETECTION_PREFIX_BYTES = 8 * 1024;

export interface BinaryFileInspection {
  binary: boolean;
  size: number;
}

/**
 * Match Git's cheap binary heuristic without asking Git to scan the whole file.
 * Missing/non-regular files return null so deleted paths can fall back to Git.
 */
export async function inspectBinaryFile(filePath: string): Promise<BinaryFileInspection | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;

    const bytesToRead = Math.min(stat.size, BINARY_DETECTION_PREFIX_BYTES);
    if (bytesToRead === 0) return { binary: false, size: stat.size };

    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return {
        binary: buffer.subarray(0, bytesRead).includes(0),
        size: stat.size,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
