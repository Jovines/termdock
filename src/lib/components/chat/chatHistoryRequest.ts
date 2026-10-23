import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
import { readChatSnapshot } from './chatSnapshot';
import type { ChatMessage } from './chatMessages';
export const CHAT_HISTORY_PAGE_SIZE = 30;
export interface ChatHistoryQuery { before?: string; after?: string; requestId?: string }
export interface ChatHistoryPage { hasOlder: boolean; hasNewer: boolean; mode: 'latest' | 'before' | 'after' }
export interface ChatHistoryPayload {
  replyPending?: boolean; confirmedRequestId?: string;
  updates?: ChatMessage[]; page?: ChatHistoryPage;
  messages?: ChatMessage[]; revision?: string; unchanged?: boolean;
  agentAvailable?: boolean; agent?: { displayName?: string; slug?: string } | null;
}
interface Request {
  queryKey: string;
  client: ReturnType<typeof currentSecureClient>; controller: AbortController;
  promise: Promise<ChatHistoryPayload>; warm: boolean; consumed: boolean;
}
const pending = new Map<string, Request>();
const keyFor = (id: string) => `${savedConnection()?.targetPeerId || location.origin}:${id}`;
function start(id: string, revision?: string, warming = false, query: ChatHistoryQuery = {}): Request {
  const queryKey = JSON.stringify(query);
  const key = keyFor(id), existing = pending.get(key);
  if (existing && existing.client === currentSecureClient() && !existing.controller.signal.aborted && (warming && existing.consumed || !existing.consumed && existing.queryKey === queryKey)) return existing;
  if (existing && (existing.client !== currentSecureClient() || !existing.consumed && existing.queryKey !== queryKey)) existing.controller.abort();
  const controller = new AbortController();
  const entry: Request = { queryKey, client: currentSecureClient(), controller, warm: false, consumed: false, promise: undefined! };
  const params = new URLSearchParams({ limit: String(CHAT_HISTORY_PAGE_SIZE), ...query, ...(revision ? { revision } : {}) });
  const url = `/api/terminal/${encodeURIComponent(id)}/chat?${params}`;
  entry.promise = (async () => {
    const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw Object.assign(new Error('暂时无法读取对话，请重试'), { status: response.status });
    return await response.json() as ChatHistoryPayload;
  })().finally(() => { if ((!entry.warm || entry.consumed || controller.signal.aborted) && pending.get(key) === entry) pending.delete(key); });
  // A warmed request may fail before the lazy view is ready to consume it.
  void entry.promise.catch(() => {});
  pending.set(key, entry);
  return entry;
}
/** Start history alongside the lazy module, without keeping inactive requests. */
export function preloadChatHistory(id: string): () => void {
  const key = keyFor(id);
  if (readChatSnapshot(`termdock:chat:${key}`)) return () => {};
  const entry = start(id, undefined, true);
  if (entry.consumed) return () => {};
  entry.warm = true;
  return () => { if (!entry.consumed) { entry.controller.abort(); if (pending.get(key) === entry) pending.delete(key); } };
}
export async function readChatHistory(id: string, signal: AbortSignal, revision?: string, query?: ChatHistoryQuery): Promise<ChatHistoryPayload> {
  if (signal.aborted) throw signal.reason;
  const entry = start(id, revision, false, query); entry.consumed = true;
  const abort = () => entry.controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { return await entry.promise; }
  finally { signal.removeEventListener('abort', abort); if (pending.get(keyFor(id)) === entry) pending.delete(keyFor(id)); }
}

export function clearChatHistoryRequests() {
  for (const entry of pending.values()) entry.controller.abort();
  pending.clear();
}
if (typeof window !== 'undefined') window.addEventListener('auth:unauthorized', clearChatHistoryRequests);
