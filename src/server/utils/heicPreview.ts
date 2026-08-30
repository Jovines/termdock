import { Worker } from 'node:worker_threads';

export const HEIC_PREVIEW_MIME_TYPES: Record<string, string> = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function isHeicPreviewPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith('.heic') || normalized.endsWith('.heif');
}

export function convertHeicPreview(filePath: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/heicPreviewWorker.js', import.meta.url), {
      workerData: { filePath },
    });
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      void worker.terminate();
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('HEIC preview conversion was cancelled')));
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { output?: Uint8Array; error?: string }) => {
      if (message.error) {
        finish(() => reject(new Error(message.error)));
        return;
      }
      const { output } = message;
      if (!output) {
        finish(() => reject(new Error('HEIC preview worker returned no image data')));
        return;
      }
      finish(() => resolve(Buffer.from(output)));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`HEIC preview worker exited with code ${code}`)));
    });
  });
}
