/** 投屏画面的截图采集：只碰 canvas，不依赖屏幕共享授权，手机上也能用。 */

function randomSuffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

export function mirrorCaptureName(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `termdock-mirror-shot-${stamp}-${randomSuffix()}.png`;
}

export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 当前画面存成 PNG。同步拷贝一份是廉价的保险：即便采集时正好撞上解码线程
 * 重绘，也不会存下画到一半的帧。 */
export async function captureMirrorScreenshot(canvas: HTMLCanvasElement, name = mirrorCaptureName()): Promise<File> {
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
