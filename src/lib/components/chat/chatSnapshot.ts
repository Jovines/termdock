import { currentSecureClient } from '../../federation/browserIntegration';
import type { ChatMessage } from './chatMessages';
export interface ChatSnapshot {
  messages: ChatMessage[]; agentName: string; agentSlug?: string; agentAvailable: boolean;
  scrollTop: number; nearBottom: boolean; visibleCount?: number;
  replyPending?: boolean;
  hasOlder?: boolean; hasNewer?: boolean; rowHeights?: [string, number][]; visibleMessageIds?: string[];
}
const snapshots = new Map<string, { value: ChatSnapshot; at: number; bytes: number }>();
let client = currentSecureClient(), bytes = 0, generation = 0;
export const chatSnapshotGeneration = () => generation;
export function clearChatSnapshots() { snapshots.clear(); bytes = 0; generation++; }
function checkScope() {
  if (client !== currentSecureClient()) { clearChatSnapshots(); client = currentSecureClient(); }
}
export function readChatSnapshot(key: string): ChatSnapshot | undefined {
  checkScope();
  const entry = snapshots.get(key);
  if (!entry) return;
  snapshots.delete(key); bytes -= entry.bytes;
  if (Date.now() - entry.at > 5 * 60_000) return;
  snapshots.set(key, entry); bytes += entry.bytes;
  return entry.value;
}
export function saveChatSnapshot(key: string, value: ChatSnapshot) {
  checkScope();
  const previous = snapshots.get(key);
  if (previous) { bytes -= previous.bytes; snapshots.delete(key); }
  const size = JSON.stringify(value.messages).length * 2;
  if (size > 4 * 1024 * 1024) return;
  snapshots.set(key, { value, at: Date.now(), bytes: size }); bytes += size;
  while (snapshots.size > 12 || bytes > 8 * 1024 * 1024) {
    const oldest = snapshots.keys().next().value!;
    bytes -= snapshots.get(oldest)!.bytes; snapshots.delete(oldest);
  }
}
if (typeof window !== 'undefined') window.addEventListener('auth:unauthorized', clearChatSnapshots);
