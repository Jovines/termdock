import { requestReferenceInsertion } from '../components/sidebar/requestReferenceInsertion';
import { create } from 'zustand';
import type { AndroidRecording } from './api';
import { buildReferenceInputText } from '../components/sidebar/referencePaths';

export async function insertAndroidText(text: string, sessionId?: string | null, source?: HTMLElement): Promise<void> {
  if (!sessionId) throw new Error('没有可接收内容的终端');
  const accepted = await requestReferenceInsertion(text, sessionId, () => true, source);
  if (!accepted) throw new Error('目标终端不可用，内容尚未插入，请连接终端后重试');
}
export function insertAndroidPath(path: string, sessionId?: string | null, source?: HTMLElement): Promise<void> {
  return insertAndroidText(buildReferenceInputText(path, null), sessionId, source);
}

// Keep a recording's destination across panel remounts and session switches.
const recordingDestinations = new Map<string, (file: AndroidRecording) => void>();
export function bindAndroidRecordingDestination(id: string, receive: (file: AndroidRecording) => void): void {
  recordingDestinations.set(id, receive);
}
export function deliverAndroidRecording(file: AndroidRecording, fallback?: (file: AndroidRecording) => void): void {
  const receive = recordingDestinations.get(file.id) ?? fallback;
  receive?.(file);
  if (receive) recordingDestinations.delete(file.id);
}

interface PendingRecording { file: AndroidRecording; sessionId: string | null; initialPath: string; insert?: (path: string, source?: HTMLElement) => Promise<unknown> | void }
export const useAndroidRecordingDelivery = create<{
  pending: PendingRecording[];
  enqueue: (file: AndroidRecording, sessionId: string | null, initialPath?: string, insert?: (path: string, source?: HTMLElement) => Promise<unknown> | void) => void;
  remove: (id: string) => void;
}>(set => ({
  pending: [],
  enqueue: (file, sessionId, initialPath = '/', insert) => set(state => state.pending.some(item => item.file.id === file.id)
    ? state : { pending: [...state.pending, { file, sessionId, initialPath, insert }] }),
  remove: id => set(state => ({ pending: state.pending.filter(item => item.file.id !== id) })),
}));
