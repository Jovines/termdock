import { uploadFiles } from './api';
import { getTermdockDesktopBridge } from '../desktop/nativeBridge';
import { selectedTarget } from '../federation/clientScope';

/** Keep uploads in the renderer, where fetch is bound to the active encrypted
 * service. The desktop preload's isolated-world fetch cannot use that channel. */
export async function uploadTerminalClipboardImage(image: File): Promise<string> {
  if (!image.type.startsWith('image/') || image.size === 0) throw new Error('Clipboard image is empty');
  // System paste events commonly name every screenshot image.png. Keep earlier
  // references intact when several screenshots are pasted in succession.
  const extension = image.type === 'image/jpeg' ? 'jpg' : image.type.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
  const file = new File([image], `termdock-clipboard-${Date.now()}-${crypto.randomUUID()}.${extension}`, { type: image.type });
  const { files } = await uploadFiles('/tmp', [file]);
  if (!files[0]?.path) throw new Error('Upload did not return an image path');
  return files[0].path;
}

export async function readTerminalClipboardImage(clipboard?: Pick<Clipboard, 'read'>): Promise<File | null> {
  const bridge = getTermdockDesktopBridge();
  if (bridge?.readClipboardImage) {
    const png = await bridge.readClipboardImage();
    return png?.byteLength
      ? new File([png], 'clipboard.png', { type: 'image/png' })
      : null;
  }
  if (typeof clipboard?.read !== 'function') return null;
  for (const item of await clipboard.read()) {
    const type = item.types.find(type => type.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
    return new File([blob], `termdock-clipboard-${Date.now()}.${extension}`, { type });
  }
  return null;
}

/** Look for videos across all items before reading a possible cover image.
 * Callers can reuse an existing read() result to keep one permission request. */
export async function readTerminalClipboardVideos(clipboard?: Pick<Clipboard, 'read'>): Promise<File[]> {
  if (typeof clipboard?.read !== 'function') return [];
  const files: File[] = [];
  const extensions: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/mpeg': 'mpeg',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/3gpp': '3gp',
    'video/3gpp2': '3g2',
  };
  for (const item of await clipboard.read()) {
    const type = item.types.find(type => type.startsWith('video/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!blob.size) throw new Error('Clipboard video is empty');
    const mime = type.split(';')[0].toLowerCase();
    const extension = extensions[mime] || mime.slice('video/'.length).replace(/[^a-z0-9]/g, '') || 'mp4';
    files.push(new File([blob], `termdock-clipboard-${Date.now()}-${crypto.randomUUID()}.${extension}`, { type }));
  }
  return files;
}

/** Native code verifies the requested peer against this Mac's service key.
 * A localhost entry relaying to a remote peer never qualifies for local paths. */
export async function readTerminalClipboardFiles(): Promise<{ files: File[]; paths: string[] }> {
  const targetPeerId = selectedTarget()?.targetPeerId;
  const input = await getTermdockDesktopBridge()?.readClipboardFiles?.({ localServiceId: targetPeerId });
  if (selectedTarget()?.targetPeerId !== targetPeerId) throw new Error('目标服务已切换，请重新粘贴');
  const files: File[] = [];
  const paths: string[] = [];
  for (const file of input ?? []) {
    if (file.path && targetPeerId) paths.push(file.path);
    else if (file.bytes) files.push(new File([file.bytes], file.name, { type: file.type || 'application/octet-stream' }));
    else throw new Error('剪贴板未提供可读取的文件');
  }
  return { files, paths };
}

export async function uploadTerminalClipboardFiles(input: File[]): Promise<string[]> {
  if (!input.length) return [];
  const { files } = await uploadFiles('/tmp', input);
  if (files.length !== input.length || files.some(file => !file.path)) {
    throw new Error('Upload did not return every file path');
  }
  return files.map(file => file.path);
}
