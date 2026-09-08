import { selectedTarget } from '../federation/clientScope';
import type { NativeFileDropPayload } from './nativeBridge';

export function canUseLocalDroppedPaths(pageOrigin: string, target: ReturnType<typeof selectedTarget>): boolean {
  if (!target) return false;
  try {
    const url = new URL(target.serviceOrigin || target.url);
    return url.origin === pageOrigin && /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})$/.test(url.hostname)
      && !(target.routes ?? []).some(route => route.targetPeerId !== target.targetPeerId);
  } catch { return false; }
}

/** Capture remote drops before legacy desktop preload's document listener.
 * Local same-service paths can still be resolved by Electron's webUtils. */
export function installEncryptedFileDrops(deliver: (payload: NativeFileDropPayload) => void): () => void {
  const targetFor = (event: DragEvent) => event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]') : null;
  const remote = () => !canUseLocalDroppedPaths(location.origin, selectedTarget());
  const dragover = (event: DragEvent) => {
    const target = targetFor(event);
    if (!target || !remote() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = 'copy';
    target.dataset.nativeFileDrag = 'true'; target.dataset.nativeFileDropState = 'remote';
  };
  const drop = (event: DragEvent) => {
    const target = targetFor(event), files = Array.from(event.dataTransfer?.files ?? []);
    if (!target || !files.length || !remote()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const sessionKey = target.dataset.termdockTerminalDropzone ?? '';
    target.dataset.nativeFileDrag = 'true'; target.dataset.nativeFileDropState = 'uploading';
    void import('../terminal/api').then(({ uploadFiles }) => uploadFiles('/tmp', files)).then(result => {
      if (result.files.length !== files.length || result.files.some(file => !file.path)) throw new Error('Upload did not return every file path');
      delete target.dataset.nativeFileDrag; delete target.dataset.nativeFileDropState;
      deliver({ sessionKey, paths: result.files.map(file => file.path) });
    }).catch(error => {
      target.dataset.nativeFileDropState = 'error';
      target.dispatchEvent(new CustomEvent('termdock:file-drop-error', { bubbles: true, detail: error instanceof Error ? error.message : 'File upload failed' }));
      window.setTimeout(() => {
        if (target.dataset.nativeFileDropState === 'error') {
          delete target.dataset.nativeFileDrag; delete target.dataset.nativeFileDropState;
        }
      }, 3000);
    });
  };
  window.addEventListener('dragover', dragover, true);
  window.addEventListener('drop', drop, true);
  return () => { window.removeEventListener('dragover', dragover, true); window.removeEventListener('drop', drop, true); };
}
