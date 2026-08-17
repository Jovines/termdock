// Diff 显示偏好（空白处理 / 上下文行数）的共享存储。
//
// 两个消费者需要保持同步：RightSidebar 用它们拼出 GitDiffOptions（决定
// 预加载/缓存 key），DiffViewer 工具栏用它们展示和修改当前值。用
// useSyncExternalStore 做一个极简 pub/sub，任何一处修改都会让另一处
// 重渲染，diffOptions 变化进而触发既有 effect 重新拉取 diff。
//
// 持久化走 localStorageCache，与 diff view-type / wrap 等既有偏好一致。

import { useSyncExternalStore } from 'react';
import { readCache, writeCache } from '../../utils/localStorageCache';
import type { GitDiffWhitespaceMode } from '../../terminal/api';

export type DiffWhitespacePref = GitDiffWhitespaceMode;
export type DiffContextPref = 3 | 10 | 25 | 'all';

export const DIFF_WHITESPACE_STORAGE_KEY = 'termdock:diff-viewer:whitespace:v1';
export const DIFF_CONTEXT_STORAGE_KEY = 'termdock:diff-viewer:context:v1';

export interface DiffDisplayPrefs {
  whitespace: DiffWhitespacePref;
  context: DiffContextPref;
}

function isDiffWhitespacePref(value: unknown): value is DiffWhitespacePref {
  return value === 'default' || value === 'trim' || value === 'ignore' || value === 'ignore-blank-lines';
}

function isDiffContextPref(value: unknown): value is DiffContextPref {
  return value === 'all' || value === 3 || value === 10 || value === 25;
}

function readPrefs(): DiffDisplayPrefs {
  return {
    whitespace: readCache(DIFF_WHITESPACE_STORAGE_KEY, isDiffWhitespacePref) ?? 'default',
    context: readCache(DIFF_CONTEXT_STORAGE_KEY, isDiffContextPref) ?? 3,
  };
}

let snapshot: DiffDisplayPrefs = readPrefs();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DiffDisplayPrefs {
  return snapshot;
}

function updatePrefs(patch: Partial<DiffDisplayPrefs>): void {
  const next = { ...snapshot, ...patch };
  if (next.whitespace === snapshot.whitespace && next.context === snapshot.context) return;
  snapshot = next;
  writeCache(DIFF_WHITESPACE_STORAGE_KEY, next.whitespace);
  writeCache(DIFF_CONTEXT_STORAGE_KEY, next.context);
  for (const listener of listeners) listener();
}

export function setDiffWhitespacePref(whitespace: DiffWhitespacePref): void {
  updatePrefs({ whitespace });
}

export function setDiffContextPref(context: DiffContextPref): void {
  updatePrefs({ context });
}

export function useDiffDisplayPrefs(): DiffDisplayPrefs & {
  setWhitespace: (whitespace: DiffWhitespacePref) => void;
  setContext: (context: DiffContextPref) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getSnapshot);
  return { ...prefs, setWhitespace: setDiffWhitespacePref, setContext: setDiffContextPref };
}
