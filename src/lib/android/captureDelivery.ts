import { create } from 'zustand';
import type { AndroidRecording } from './api';
import { buildReferenceInputText } from '../components/sidebar/referencePaths';

export function insertAndroidText(text: string, sessionId?: string | null): Promise<void> {
  if (!sessionId) return Promise.reject(new Error('没有可接收内容的终端'));
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener('termdock-insert-reference-ack', receive);
      if (ok) resolve(); else reject(new Error('目标终端不可用，内容尚未插入，请连接终端后重试'));
    };
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.nonce === nonce) finish(detail.ok === true);
    };
    const timer = window.setTimeout(() => finish(false), 10000);
    window.addEventListener('termdock-insert-reference-ack', receive);
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text, sessionId, nonce, focus: false, paste: true },
    }));
  });
}
export function insertAndroidPath(path: string, sessionId?: string | null): Promise<void> {
  return insertAndroidText(buildReferenceInputText(path, null), sessionId);
}

interface PendingRecording { file: AndroidRecording; sessionId: string | null; initialPath: string; insert?: (path: string) => Promise<unknown> | void }
export const useAndroidRecordingDelivery = create<{
  pending: PendingRecording[];
  enqueue: (file: AndroidRecording, sessionId: string | null, initialPath?: string, insert?: (path: string) => Promise<unknown> | void) => void;
  remove: (id: string) => void;
}>(set => ({
  pending: [],
  enqueue: (file, sessionId, initialPath = '/', insert) => set(state => state.pending.some(item => item.file.id === file.id)
    ? state : { pending: [...state.pending, { file, sessionId, initialPath, insert }] }),
  remove: id => set(state => ({ pending: state.pending.filter(item => item.file.id !== id) })),
}));
