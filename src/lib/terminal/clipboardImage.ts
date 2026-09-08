import { uploadFiles } from './api';
import { getTermdockDesktopBridge } from '../desktop/nativeBridge';

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
