import fs from 'fs';
import os from 'os';
import path from 'path';

const DRAFT_DIR = path.join(os.homedir(), '.termdock');
const DRAFT_FILE = path.join(DRAFT_DIR, 'context-draft.json');
// 草稿是纯文本提示词，200k 上限足够宽裕，也避免异常请求写爆磁盘
export const CONTEXT_DRAFT_MAX_LENGTH = 200_000;

export interface ContextDraftDoc {
  text: string;
  updatedAt: number;
}

function normalizeDraft(value: unknown): ContextDraftDoc {
  const raw = value && typeof value === 'object'
    ? value as { text?: unknown; updatedAt?: unknown }
    : {};
  return {
    text: typeof raw.text === 'string' ? raw.text.slice(0, CONTEXT_DRAFT_MAX_LENGTH) : '',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export function loadContextDraft(): ContextDraftDoc {
  try {
    const raw = fs.readFileSync(DRAFT_FILE, 'utf-8');
    return normalizeDraft(JSON.parse(raw));
  } catch { /* ignore missing/malformed draft */ }
  return { text: '', updatedAt: 0 };
}

export function saveContextDraft(text: string): ContextDraftDoc {
  const doc: ContextDraftDoc = {
    text: text.slice(0, CONTEXT_DRAFT_MAX_LENGTH),
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(DRAFT_DIR, { recursive: true });
    fs.writeFileSync(DRAFT_FILE, JSON.stringify(doc), 'utf-8');
  } catch { /* best effort */ }
  return doc;
}
