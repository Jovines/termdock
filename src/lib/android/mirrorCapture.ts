/** 投屏画面的截图/录屏采集：只碰 canvas，不依赖屏幕共享授权，手机上也能用。 */

/** 录屏编解码器偏好：MP4(H.264) 在 Safari 与各类播放器/agent 侧兼容性最好，
 * 只有 Chrome 系支持；Firefox 回退 WebM。 */
export const MIRROR_RECORDING_MIME_PREFERENCES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
] as const;

/** 录屏上限：超过自动停止，避免误开后录出无法插入的超大文件。 */
export const MIRROR_RECORDING_MAX_MS = 5 * 60 * 1000;

function randomSuffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

export function pickMirrorRecordingMime(supported: (mime: string) => boolean): string | null {
  return MIRROR_RECORDING_MIME_PREFERENCES.find(mime => supported(mime)) ?? null;
}

export function recordingExtension(mime: string): 'mp4' | 'webm' {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export function mirrorCaptureName(kind: 'shot' | 'rec', mime?: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const extension = mime ? recordingExtension(mime) : 'png';
  return `termdock-mirror-${kind}-${stamp}-${randomSuffix()}.${extension}`;
}

export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 当前画面存成 PNG。同步拷贝一份是廉价的保险：即便采集时正好撞上解码线程
 * 重绘，也不会存下画到一半的帧。 */
export async function captureMirrorScreenshot(canvas: HTMLCanvasElement, name = mirrorCaptureName('shot')): Promise<File> {
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) throw new Error('投屏画面尚未就绪');
  const snapshot = document.createElement('canvas');
  snapshot.width = width;
  snapshot.height = height;
  const context = snapshot.getContext('2d');
  if (!context) throw new Error('无法读取投屏画面');
  context.drawImage(canvas, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => snapshot.toBlob(resolve, 'image/png'));
  if (!blob || blob.size === 0) throw new Error('截图失败，请重试');
  return new File([blob], name, { type: 'image/png' });
}

export interface MirrorRecordingHandle {
  readonly mime: string;
  /** 停止并按录制内容生成文件；无有效帧时 reject。 */
  stop(): Promise<File>;
  cancel(): void;
}

/** 开始录屏。canvas 是真视频在持续重绘，直接采流即可；
 * 帧率取投屏实际配置，未设上限时按 30fps 采。 */
export function startMirrorRecording(canvas: HTMLCanvasElement, fps = 30): MirrorRecordingHandle {
  const mime = pickMirrorRecordingMime(candidate => (
    typeof MediaRecorder !== 'undefined' ? MediaRecorder.isTypeSupported(candidate) : false
  ));
  if (!mime) throw new Error('当前浏览器不支持录屏');
  const capture = canvas.captureStream(Math.max(1, Math.min(60, Math.round(fps) || 30)));
  const recorder = new MediaRecorder(capture, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  // MP4 分片无法简单拼接，必须整段收；WebM 分段反而更稳。
  recorder.start(recordingExtension(mime) === 'webm' ? 1000 : undefined);
  const name = mirrorCaptureName('rec', mime);
  return {
    mime,
    stop: () => new Promise<File>((resolve, reject) => {
      const finish = () => {
        capture.getTracks().forEach(track => track.stop());
        const blob = new Blob(chunks, { type: mime });
        if (!blob.size) { reject(new Error('没有录到画面')); return; }
        resolve(new File([blob], name, { type: mime }));
      };
      recorder.onstop = finish;
      recorder.onerror = () => { capture.getTracks().forEach(track => track.stop()); reject(new Error('录屏失败')); };
      if (recorder.state === 'inactive') finish();
      else recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      capture.getTracks().forEach(track => track.stop());
    },
  };
}
