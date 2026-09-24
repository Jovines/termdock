import { readVideoCoreCache, writeVideoCoreCache } from './videoCompressionCache';
import type { VideoDimension } from './mediaCompressionOptions';

export type VideoCompressionOptions = {
  maxHeight: VideoDimension;
  videoBitrate: number;
  onProgress?: (percent: number) => void;
};

// Versioned path bypasses older service workers that handled the large WASM
// response themselves. Change this only when @ffmpeg/core changes, not on deploy.
const CORE_BASE_URL = '/assets/video-compression/v2';
const CORE_WASM_SIZE = 32_232_419;

export type VideoCompressionPreparationState = {
  phase: 'checking-cache' | 'loading' | 'saving' | 'initializing' | 'ready';
  progress?: number;
  source?: 'local' | 'fetch';
  saved?: boolean;
};

let preparedFfmpeg: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;
let preparationState: VideoCompressionPreparationState = { phase: 'checking-cache' };
const preparationListeners = new Set<(state: VideoCompressionPreparationState) => void>();

function reportPreparation(state: VideoCompressionPreparationState): void {
  if (state.phase === preparationState.phase && state.progress === preparationState.progress
    && state.source === preparationState.source && state.saved === preparationState.saved) return;
  preparationState = state;
  preparationListeners.forEach(listener => listener(state));
}

/** The caller imports this module only after enabling compression. */
export function prepareLocalVideoCompression(onState?: (state: VideoCompressionPreparationState) => void): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    return Promise.reject(new Error('This browser cannot run local video compression.'));
  }
  if (!preparedFfmpeg) {
    reportPreparation({ phase: 'checking-cache' });
    preparedFfmpeg = preloadCoreWasm().then(async ({ blob, source, saved }) => {
      reportPreparation({ phase: 'initializing', source, saved });
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ffmpeg = new FFmpeg();
      const wasmURL = URL.createObjectURL(blob);
      try {
        await ffmpeg.load({
          coreURL: `${CORE_BASE_URL}/ffmpeg-core.js`,
          // The worker reads the bytes already downloaded by this page.
          wasmURL,
        });
        reportPreparation({ phase: 'ready', source, saved });
        return ffmpeg;
      } catch (error) {
        ffmpeg.terminate();
        throw error;
      } finally {
        URL.revokeObjectURL(wasmURL);
      }
    }).catch(error => {
      preparedFfmpeg = null;
      throw error;
    });
  }
  if (!onState) return preparedFfmpeg;
  preparationListeners.add(onState);
  onState(preparationState);
  // Reopening a sheet joins the existing download and sees its real progress.
  return preparedFfmpeg.finally(() => { preparationListeners.delete(onState); });
}

/**
 * Read the whole file before caching it, then pass those bytes to the worker.
 * This avoids two consumers caching the same large response stream on iOS.
 */
async function preloadCoreWasm(): Promise<{ blob: Blob; source: 'local' | 'fetch'; saved: boolean }> {
  const url = `${CORE_BASE_URL}/ffmpeg-core.wasm`;
  const cached = await readVideoCoreCache(url, CORE_WASM_SIZE);
  if (cached) return { blob: cached, source: 'local', saved: true };

  // This request may itself hit the HTTP cache. Report loading, not an
  // unverified network download, when no app-managed copy was found.
  reportPreparation({ phase: 'loading', progress: 0, source: 'fetch' });
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok || !response.body) throw new Error(`Unable to download local video compression (${response.status}).`);
  const total = Number(response.headers.get('Content-Length'));
  const reader = response.body.getReader();
  let received = 0;
  const chunks: BlobPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks.push(asBlobBytes(value));
    if (Number.isFinite(total) && total > 0) reportPreparation({ phase: 'loading', progress: Math.min(99, Math.round(received / total * 100)), source: 'fetch' });
  }
  const blob = new Blob(chunks, { type: 'application/wasm' });
  chunks.length = 0;
  if (blob.size !== CORE_WASM_SIZE) throw new Error('本地转码器下载不完整，请重试。');
  reportPreparation({ phase: 'saving', progress: 100, source: 'fetch' });
  const saved = await writeVideoCoreCache(url, blob);
  return { blob, source: 'fetch', saved };
}

/**
 * The FFmpeg core (~30 MB) is fetched only by prepareLocalVideoCompression,
 * never at application startup or for a normal upload.
 */
export async function compressVideoLocally(file: File, options: VideoCompressionOptions): Promise<File> {
  const [{ fetchFile }, ffmpeg] = await Promise.all([
    import('@ffmpeg/util'),
    prepareLocalVideoCompression(),
  ]);
  const inputName = `input-${crypto.randomUUID()}${extensionFor(file)}`;
  const outputName = `compressed-${crypto.randomUUID()}.mp4`;
  let latestProgress = 0;
  const recentLogs: string[] = [];
  const handleLog = ({ message }: { message: string }) => {
    recentLogs.push(message.slice(0, 500));
    if (recentLogs.length > 10) recentLogs.shift();
  };

  const handleProgress = ({ progress }: { progress: number }) => {
    // 5–95 is reserved for the locally-visible transcoding phase.
    const next = Math.max(latestProgress, Math.min(95, Math.round(5 + progress * 90)));
    latestProgress = next;
    options.onProgress?.(next);
  };
  ffmpeg.on('progress', handleProgress);
  ffmpeg.on('log', handleLog);

  try {
    options.onProgress?.(1);
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    const exitCode = await ffmpeg.exec([
      '-i', inputName,
      '-map', '0:v:0', '-map', '0:a?',
      // Commas inside expressions must be quoted for FFmpeg's filtergraph
      // parser, even though exec receives an argv array rather than a shell.
      // Bound both sides for portrait recordings and keep H.264 dimensions even.
      '-vf', `scale=w='min(${options.maxHeight},iw)':h='min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', String(options.videoBitrate), '-maxrate', String(options.videoBitrate), '-bufsize', String(options.videoBitrate * 2),
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputName,
    ]);
    if (exitCode !== 0) throw new Error(`视频转码失败（退出码 ${exitCode}）。`);
    const output = await ffmpeg.readFile(outputName);
    if (!(output instanceof Uint8Array) || output.byteLength === 0) throw new Error('转码器未生成有效的视频文件。');
    options.onProgress?.(100);
    return new File([asBlobBytes(output)], compressedName(file.name), { type: 'video/mp4' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error([message, recentLogs.join('\n')].filter(Boolean).join('\n').slice(0, 3000));
  } finally {
    ffmpeg.off('progress', handleProgress);
    ffmpeg.off('log', handleLog);
    await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)]);
  }
}

function asBlobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // Blob cannot wrap shared memory. Avoid copying ordinary download/worker
  // buffers, which can be large on a phone.
  return bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
}

function extensionFor(file: File): string {
  const matched = /\.[A-Za-z0-9]{1,10}$/.exec(file.name)?.[0];
  return matched ?? (file.type === 'video/quicktime' ? '.mov' : '.mp4');
}

function compressedName(name: string): string {
  return `${name.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`;
}
