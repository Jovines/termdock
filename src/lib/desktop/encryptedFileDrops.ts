import { selectedTarget } from '../federation/clientScope';
import type { NativeFileDropPayload } from './nativeBridge';

let dropOperationSequence = 0;

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
export function installEncryptedFileDrops(deliver: (payload: NativeFileDropPayload) => void, allowLocalPaths = true): () => void {
  const active = new Set<() => void>(), timers = new Set<number>();
  const controllers = new WeakMap<HTMLElement, AbortController>();
  const targetFor = (event: DragEvent) => event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]') : null;
  const remote = () => !allowLocalPaths || !canUseLocalDroppedPaths(location.origin, selectedTarget());
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
    controllers.get(target)?.abort();
    const controller = new AbortController();controllers.set(target,controller);
    const sessionKey = target.dataset.termdockTerminalDropzone ?? '';
    const selected = selectedTarget(), ownerKey = target.dataset.termdockTerminalOwner;
    const targetPeerId = selected?.targetPeerId ?? null;
    const operation = String(++dropOperationSequence);
    const isCurrent = () => !controller.signal.aborted && target.isConnected
      && target.dataset.termdockTerminalDropzone === sessionKey
      && target.dataset.nativeFileDropOperation === operation
      && selectedTarget() === selected && selectedTarget()?.targetPeerId === targetPeerId
      && target.dataset.termdockTerminalOwner === ownerKey;
    const discardStale = () => { if (isCurrent()) return false; if (target.dataset.nativeFileDropOperation === operation) { delete target.dataset.nativeFileDrag; delete target.dataset.nativeFileDropState; delete target.dataset.nativeFileDropOperation; delete target.dataset.nativeFileDropProgress; delete target.dataset.nativeFileDropCancellable; } return true; };
    target.dataset.nativeFileDropOperation = operation;
    target.dataset.nativeFileDrag = 'true'; target.dataset.nativeFileDropState = 'uploading';target.dataset.nativeFileDropCancellable='true';delete target.dataset.nativeFileDropProgress;
    const cancelStale = (event?: Event) => { if (event?.type === 'auth:unauthorized' || event?.type === 'pagehide' || !isCurrent()) { controller.abort(); discardStale(); } };
    const observer = new MutationObserver(() => cancelStale());observer.observe(target,{attributes:true,attributeFilter:['data-termdock-terminal-dropzone','data-termdock-terminal-owner','data-native-file-drop-operation']});
    const cancel = () => { controller.abort(); discardStale(); cleanup(); };
    const cancelByUser = (event: Event) => { if (!(event.target instanceof Element) || event.target.closest('[data-termdock-terminal-dropzone]') !== target || !isCurrent()) return; cancel(); target.dataset.nativeFileDrag='true';target.dataset.nativeFileDropOperation=operation;target.dataset.nativeFileDropState='cancelled'; const timer=window.setTimeout(()=>{timers.delete(timer);if(target.dataset.nativeFileDropOperation===operation&&target.dataset.nativeFileDropState==='cancelled'){delete target.dataset.nativeFileDrag;delete target.dataset.nativeFileDropState;delete target.dataset.nativeFileDropOperation;}},3000);timers.add(timer); };
    window.addEventListener('termdock:file-drop-cancel',cancelByUser);
    const cleanup = () => { window.removeEventListener('termdock:file-drop-cancel',cancelByUser); observer.disconnect(); for (const name of ['termdock:secure-state','auth:unauthorized','pagehide']) window.removeEventListener(name,cancelStale); active.delete(cancel); };
    active.add(cancel);for (const name of ['termdock:secure-state','auth:unauthorized','pagehide']) window.addEventListener(name,cancelStale);
    void import('../terminal/api').then(({ uploadFiles }) => {
      if (!isCurrent()) throw new DOMException('Drop target changed','AbortError');
      return uploadFiles('/tmp', files, controller.signal, percent => { if(isCurrent())target.dataset.nativeFileDropProgress=String(Math.round(percent)); }, isCurrent);
    }).then(result => {
      if (result.files.length !== files.length || result.files.some(file => !file.path)) throw new Error('Upload did not return every file path');
      if (discardStale()) return;
      delete target.dataset.nativeFileDropCancellable;delete target.dataset.nativeFileDropProgress;
      deliver({ sessionKey, paths: result.files.map(file => file.path) });
      target.dataset.nativeFileDropState='uploaded';
      const timer=window.setTimeout(()=>{timers.delete(timer);if(isCurrent()&&target.dataset.nativeFileDropState==='uploaded'){delete target.dataset.nativeFileDrag;delete target.dataset.nativeFileDropState;delete target.dataset.nativeFileDropOperation;}},3000);timers.add(timer);
    }).catch(error => {
      if (discardStale()) return;
      delete target.dataset.nativeFileDropCancellable;delete target.dataset.nativeFileDropProgress;target.dataset.nativeFileDropState = 'error';
      target.dispatchEvent(new CustomEvent('termdock:file-drop-error', { bubbles: true, detail: error instanceof Error ? error.message : 'File upload failed' }));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (isCurrent() && target.dataset.nativeFileDropState === 'error') {
          delete target.dataset.nativeFileDrag; delete target.dataset.nativeFileDropState;
          delete target.dataset.nativeFileDropOperation;
        }
      }, 3000);timers.add(timer);
    }).finally(cleanup);
  };
  window.addEventListener('dragover', dragover, true);
  window.addEventListener('drop', drop, true);
  return () => { window.removeEventListener('dragover', dragover, true); window.removeEventListener('drop', drop, true); for(const cancel of active)cancel(); for(const timer of timers)clearTimeout(timer);timers.clear(); };
}
