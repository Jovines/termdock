import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';

interface HeicPreviewWorkerData {
  filePath: string;
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error('HEIC preview worker requires a parent port');
  const { filePath } = workerData as HeicPreviewWorkerData;
  const input = await fs.readFile(filePath);
  const output = await convert({ buffer: input, format: 'JPEG', quality: 0.9 });
  parentPort.postMessage({ output });
}

run().catch((error) => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Failed to convert HEIC preview' });
});
