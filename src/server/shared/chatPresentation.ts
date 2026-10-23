/** TD reply body stays readable to old clients; rich content is an explicit,
 * versioned opt-in, never guessed from terminal output or ordinary code fences. */
export const CHAT_UI_VERSION = 1;
export interface ChatUI { version: 1; code: string }
export interface ChatUIState { revision: number; values: Record<string, unknown> }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function chatPresentation(content: string, metadata?: Record<string, unknown>): { content: string; ui?: ChatUI } {
  if (!record(metadata?.openui)) return { content };
  try {
    const body: unknown = JSON.parse(content);
    if (!record(body) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000) return { content: '这条回复暂时无法显示，请让对方重新发送文字说明。' };
    if (metadata.openui.version !== CHAT_UI_VERSION || typeof body.ui !== 'string' || !body.ui.trim() || body.ui.length > 64000) return { content: body.text };
    return { content: body.text, ui: { version: CHAT_UI_VERSION, code: body.ui } };
  } catch { return { content: '这条回复暂时无法显示，请让对方重新发送文字说明。' }; }
}
export function validChatUIValues(value: unknown): value is Record<string, unknown> {
  let nodes = 0;
  const valid = (item: unknown, depth: number): boolean => {
    if (++nodes > 2000 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 8000;
    if (Array.isArray(item)) return item.length <= 300 && item.every(child => valid(child, depth + 1));
    return record(item) && Object.keys(item).length <= 100 && Object.entries(item).every(([key, child]) => key.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(key) && valid(child, depth + 1));
  };
  return record(value) && valid(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= 32000;
}
