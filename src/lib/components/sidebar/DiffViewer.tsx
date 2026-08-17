import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown as RiChevronDown, ChevronUp as RiChevronUp, GitCompare as RiGitCompare, Loader2 as RiLoader, MoveHorizontal as RiMoveHorizontal } from 'lucide-react';
import { Diff, Hunk, getChangeKey, type FileData, type HunkData, type HunkTokens } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { cancelIoSlot, getFileDiff, getGitBlobContent, isPreviewableImagePath, readImagePreviewBlob, type ChangeAuditRecord, type DiffHunkApplyMode, type FileDiffResponse, type GitChangedFile, type GitDiffOptions } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { useReferenceLongPressCopy } from './referenceLongPress';
import { readCache, writeCache } from '../../utils/localStorageCache';
import { findMovedLineCandidates, pairChangedLinesForDisplay } from './inlineDiff';
import { parseDiffInWorker, type DiffWorkerResult } from './diffWorkerClient';
import { resolveLanguage } from '../../utils/syntaxHighlight';
import { useDiffDisplayPrefs, type DiffContextPref, type DiffWhitespacePref } from './diffDisplayPrefs';

const MAX_DIFF_CACHE_ENTRIES = 24;
const MAX_PARSED_DIFF_CACHE_ENTRIES = 32;
const MAX_RENDER_DIFF_LINES = 8_000;
const DIFF_VIEW_TYPE_STORAGE_KEY = 'termdock:diff-viewer:view-type:v1';
const SPLIT_DIFF_MEDIA_QUERY = '(min-width: 900px)';

type DiffLoadResult = FileDiffResponse;
export type DiffViewType = 'unified' | 'split';
export type DiffInlineMode = 'none' | 'words' | 'chars';

const diffResultCache = new Map<string, DiffLoadResult>();
const diffPromiseCache = new Map<string, Promise<DiffLoadResult>>();
const diffCacheVersions = new Map<string, number>();
const diffPreloadControllers = new Map<string, AbortController>();
interface ParsedDiffCacheEntry {
  diffContent: string;
  oldSource?: string;
  result: DiffWorkerResult;
}
interface ParsedDiffPromiseEntry {
  diffContent: string;
  oldSource?: string;
  promise: Promise<DiffWorkerResult>;
}
interface ParsedDiffInput {
  cacheKey: string;
  diffContent: string;
}
const parsedDiffResultCache = new Map<string, ParsedDiffCacheEntry>();
const parsedDiffPromiseCache = new Map<string, ParsedDiffPromiseEntry>();
let diffViewerLogSeq = 0;
let diffLoadingSeq = 0;
let diffTraceSeq = 0;

function logDiffViewerEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: 'info',
    message: `DIFF_VIEWER ${event}`,
    data: {
      seq: ++diffViewerLogSeq,
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function logDiffLoadingEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: event === 'still_active' ? 'warn' : 'info',
    message: `DIFF_LOADING ${event}`,
    data: {
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function getDiffOptionsKey(options?: GitDiffOptions): string {
  const context = options?.context === undefined ? 'default' : String(options.context);
  return `${options?.algorithm ?? 'default'}:${options?.whitespace ?? 'default'}:${context}`;
}

function buildDiffCacheKey(filePath: string | undefined, cwd: string | undefined, options?: GitDiffOptions): string {
  return `${cwd ?? ''}\u0000${filePath ?? ''}\u0000${getDiffOptionsKey(options)}`;
}

function buildParsedDiffCacheKey(
  filePath: string | undefined,
  cwd: string | undefined,
  options: GitDiffOptions | undefined,
  inlineMode: DiffInlineMode,
  language: string | undefined,
): string {
  return `${buildDiffCacheKey(filePath, cwd, options)}\u0000${inlineMode}\u0000${language ?? ''}`;
}

function rememberParsedDiffResult(key: string, entry: ParsedDiffCacheEntry): DiffWorkerResult {
  parsedDiffResultCache.delete(key);
  parsedDiffResultCache.set(key, entry);
  while (parsedDiffResultCache.size > MAX_PARSED_DIFF_CACHE_ENTRIES) {
    const oldest = parsedDiffResultCache.keys().next().value;
    if (oldest === undefined) break;
    parsedDiffResultCache.delete(oldest);
  }
  return entry.result;
}

function loadParsedDiffCached(
  diffContent: string,
  oldSource: string | undefined,
  filePath: string | undefined,
  cwd: string | undefined,
  options: GitDiffOptions | undefined,
  inlineMode: DiffInlineMode,
  language: string | undefined,
): Promise<DiffWorkerResult> {
  const key = buildParsedDiffCacheKey(filePath, cwd, options, inlineMode, language);
  const cached = parsedDiffResultCache.get(key);
  if (cached?.diffContent === diffContent && cached.oldSource === oldSource) {
    parsedDiffResultCache.delete(key);
    parsedDiffResultCache.set(key, cached);
    return Promise.resolve(cached.result);
  }
  const pending = parsedDiffPromiseCache.get(key);
  if (pending?.diffContent === diffContent && pending.oldSource === oldSource) return pending.promise;

  const promise: Promise<DiffWorkerResult> = parseDiffInWorker(diffContent, inlineMode, oldSource, language)
    .then((result) => (
      parsedDiffPromiseCache.get(key)?.promise === promise
        ? rememberParsedDiffResult(key, { diffContent, oldSource, result })
        : result
    ))
    .finally(() => {
      if (parsedDiffPromiseCache.get(key)?.promise === promise) parsedDiffPromiseCache.delete(key);
    });
  parsedDiffPromiseCache.set(key, { diffContent, oldSource, promise });
  return promise;
}

function invalidateParsedDiffCached(filePath: string | undefined, cwd: string | undefined, options?: GitDiffOptions): void {
  const prefix = `${buildDiffCacheKey(filePath, cwd, options)}\u0000`;
  for (const key of Array.from(parsedDiffResultCache.keys())) {
    if (key.startsWith(prefix)) parsedDiffResultCache.delete(key);
  }
  for (const key of Array.from(parsedDiffPromiseCache.keys())) {
    if (key.startsWith(prefix)) parsedDiffPromiseCache.delete(key);
  }
}

function rememberDiffResult(key: string, result: DiffLoadResult): DiffLoadResult {
  if (diffResultCache.has(key)) diffResultCache.delete(key);
  diffResultCache.set(key, result);
  while (diffResultCache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldest = diffResultCache.keys().next().value;
    if (oldest === undefined) break;
    diffResultCache.delete(oldest);
  }
  return result;
}

function cancelPreloadDiff(key: string): void {
  const controller = diffPreloadControllers.get(key);
  if (!controller) return;
  diffPreloadControllers.delete(key);
  controller.abort();
}

function requestFileDiffCached(key: string, filePath: string | undefined, cwd: string | undefined, version: number, traceId?: string, options?: GitDiffOptions): Promise<DiffLoadResult> {
  const pending = diffPromiseCache.get(key);
  if (pending) {
    logDiffViewerEvent('preload_reuse_pending', { traceId, key, filePath, cwd });
    return pending;
  }

  const controller = new AbortController();
  diffPreloadControllers.set(key, controller);
  logDiffViewerEvent('preload_start', { traceId, key, filePath, cwd, version });
  const promise = getFileDiff(filePath, undefined, cwd, controller.signal, 'preload_diff', traceId, undefined, undefined, options)
    .then((result) => {
      logDiffViewerEvent('preload_result', { traceId, key, filePath, cwd, bytes: result.diff?.length ?? 0, error: result.error ?? null, tooLarge: Boolean(result.tooLarge) });
      return (diffCacheVersions.get(key) ?? 0) === version ? rememberDiffResult(key, result) : result;
    })
    .catch((error) => {
      logDiffViewerEvent('preload_error', { traceId, key, filePath, cwd, error: error instanceof Error ? error.message : String(error) });
      throw error;
    })
    .finally(() => {
      if (diffPromiseCache.get(key) === promise) diffPromiseCache.delete(key);
      if (diffPreloadControllers.get(key) === controller) diffPreloadControllers.delete(key);
    });
  diffPromiseCache.set(key, promise);
  return promise;
}

function getCachedDiffResult(filePath: string | undefined, cwd: string | undefined, options?: GitDiffOptions): DiffLoadResult | undefined {
  return diffResultCache.get(buildDiffCacheKey(filePath, cwd, options));
}

export function loadFileDiffCached(filePath: string | undefined, cwd: string | undefined, force = false, options?: GitDiffOptions): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd, options);
  if (force) {
    cancelPreloadDiff(key);
    const existingController = diffPreloadControllers.get(key);
    existingController?.abort();
    diffResultCache.delete(key);
    diffPromiseCache.delete(key);
    diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
  }
  const version = diffCacheVersions.get(key) ?? 0;

  const cached = diffResultCache.get(key);
  if (cached) return Promise.resolve(cached);

  return requestFileDiffCached(key, filePath, cwd, version, undefined, options);
}

export function refreshFileDiffCached(filePath: string | undefined, cwd: string | undefined, options?: GitDiffOptions): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd, options);
  cancelPreloadDiff(key);
  diffPromiseCache.delete(key);
  const version = (diffCacheVersions.get(key) ?? 0) + 1;
  diffCacheVersions.set(key, version);
  return requestFileDiffCached(key, filePath, cwd, version, undefined, options);
}

export function invalidateFileDiffCached(filePath: string | undefined, cwd: string | undefined, options?: GitDiffOptions): void {
  const key = buildDiffCacheKey(filePath, cwd, options);
  cancelPreloadDiff(key);
  diffResultCache.delete(key);
  diffPromiseCache.delete(key);
  invalidateParsedDiffCached(filePath, cwd, options);
  diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
}

export function loadVisibleFileDiff(filePath: string | undefined, cwd: string | undefined, signal: AbortSignal, force = false, traceId?: string, interactionId?: string | null, requestSlotId?: string | null, options?: GitDiffOptions): Promise<DiffLoadResult> {
  const key = buildDiffCacheKey(filePath, cwd, options);
  if (force) {
    cancelPreloadDiff(key);
    diffResultCache.delete(key);
    diffPromiseCache.delete(key);
    diffCacheVersions.set(key, (diffCacheVersions.get(key) ?? 0) + 1);
  }
  const cached = diffResultCache.get(key);
  if (cached && !force) {
    logDiffViewerEvent('visible_cache_hit', { traceId, key, filePath, cwd, bytes: cached.diff?.length ?? 0, error: cached.error ?? null });
    return Promise.resolve(cached);
  }
  const version = diffCacheVersions.get(key) ?? 0;
  const pending = diffPromiseCache.get(key);
  if (pending && !force && !diffPreloadControllers.has(key)) {
    logDiffViewerEvent('visible_reuse_pending', { traceId, key, filePath, cwd });
    return pending;
  }
  cancelPreloadDiff(key);
  logDiffViewerEvent('visible_start', { interactionId, requestSlotId, traceId, key, filePath, cwd, force, version, replacedPreload: Boolean(pending), pendingExists: Boolean(pending), cacheSize: diffResultCache.size, promiseSize: diffPromiseCache.size });
  const promise = getFileDiff(filePath, undefined, cwd, signal, 'view_diff', traceId, interactionId ?? undefined, requestSlotId ?? undefined, options)
    .then((result) => {
      logDiffViewerEvent('visible_result', { interactionId, requestSlotId, traceId, key, filePath, cwd, bytes: result.diff?.length ?? 0, error: result.error ?? null, tooLarge: Boolean(result.tooLarge), truncated: Boolean(result.truncated) });
      return (diffCacheVersions.get(key) ?? 0) === version ? rememberDiffResult(key, result) : result;
    })
    .catch((error) => {
      logDiffViewerEvent('visible_error', { interactionId, requestSlotId, traceId, key, filePath, cwd, error: error instanceof Error ? error.message : String(error), aborted: signal.aborted, abortReason: signal.aborted ? String(signal.reason ?? '') : undefined });
      throw error;
    })
    .finally(() => {
      if (diffPromiseCache.get(key) === promise) diffPromiseCache.delete(key);
    });
  diffPromiseCache.set(key, promise);
  return promise;
}

function toDiffRequestPath(path: string | null, rootPath: string | null): string | undefined {
  if (!path) return undefined;
  return rootPath && path.startsWith(`${rootPath}/`)
    ? path.slice(rootPath.length + 1)
    : path;
}

export function preloadSidebarDiff(rootPath: string | null | undefined, filePath: string | null, options: { force?: boolean; repoRoot?: string | null } = {}): void {
  const cwd = options.repoRoot ?? rootPath;
  if (!cwd || !filePath) return;
  const requestPath = toDiffRequestPath(filePath, cwd);
  void loadFileDiffCached(requestPath, cwd, options.force).catch(() => {
    // Preload is best-effort; DiffViewer will surface errors when it becomes visible.
  });
}

export async function preloadPreparedFileDiff(
  filePath: string | undefined,
  cwd: string | undefined,
  inlineMode: DiffInlineMode,
  options?: GitDiffOptions,
): Promise<void> {
  if (!filePath || !cwd) return;
  const result = await loadFileDiffCached(filePath, cwd, false, options);
  if (result.error || result.tooLarge || !result.diff || isDiffTooLargeToRender(result.diff)) return;
  await loadParsedDiffCached(
    result.diff,
    undefined,
    filePath,
    cwd,
    options,
    inlineMode,
    resolveLanguage(filePath) ?? undefined,
  );
}

interface DiffViewerProps {
  filePath: string | null;
  repoRoot?: string | null;
  referenceFilePath?: string | null;
  interactionId?: string | null;
  requestSlotId?: string | null;
  changedFile?: GitChangedFile | null;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  /**
   * Hunk-level git actions (stage / revert). Only provided for live worktree
   * diffs; absent for commit/branch/preview diffs, which hides the buttons.
   */
  onHunkGitAction?: (request: DiffHunkActionRequest) => Promise<void>;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  /**
   * When true, long diff lines wrap inside each cell instead of forcing a
   * horizontal scroll. Helpful on phone-sized panels.
   */
  wrap?: boolean;
  /**
   * When true, render a small inline hint above each file's diff row to
   * tell the user the content can be swiped horizontally. Only shown when
   * `wrap` is off — the hint would lie otherwise.
   */
  showScrollHint?: boolean;
  /** Re-fetch the current diff even when the file path did not change. */
  reloadKey?: number;
  /**
   * Render only the diff body, without the outer summary/file chrome.
   * Used by the mobile accordion where the list row is the file header.
   */
  embedded?: boolean;
  /** Keep mounted panes from issuing background diff requests while hidden. */
  active?: boolean;
  lightweight?: boolean;
  auditRecords?: ChangeAuditRecord[];
  diffOverride?: string | null;
  preparedDiff?: DiffViewerPreparedDiff | null;
  viewType?: DiffViewType;
  inlineMode?: DiffInlineMode;
  diffOptions?: GitDiffOptions;
  oldSourceOverride?: string | null;
  onClearAuditRecord?: (id: string) => void;
  onContentReady?: () => void;
  onSummaryChange?: (summary: { files: number; additions: number; deletions: number } | null) => void;
}

export interface DiffViewerPreparedDiff {
  diffContent: string | null;
  diffNotice: string | null;
  diffError: string | null;
  files: FileData[];
  tokens: Map<string, HunkTokens>;
}

interface HunkAuditView {
  current?: ChangeAuditRecord;
  stale?: ChangeAuditRecord;
  fingerprint: string;
}

interface SectionAuditView {
  current?: ChangeAuditRecord;
  stale?: ChangeAuditRecord;
  fingerprint: string;
}

function shouldPreferImagePreview(readablePath: string | null, changedFile: Pick<GitChangedFile, 'status'> | null | undefined): boolean {
  if (!readablePath || !isPreviewableImagePath(readablePath)) return false;
  // Deleted files no longer exist on disk, so blob preview would 404 and hide
  // the useful Git deletion diff. Renames/copies are also better represented as
  // Git metadata first; otherwise the image preview loses the old -> new path.
  return changedFile?.status !== 'deleted' && changedFile?.status !== 'renamed' && changedFile?.status !== 'copied';
}

function getPathParts(path: string | null, fallback: { name: string; dir: string }): { name: string; dir: string } {
  if (!path) return fallback;
  const parts = path.split('/').filter(Boolean);
  return {
    name: parts.pop() || path,
    dir: parts.join('/'),
  };
}

function isDiffNullPath(path: string | null | undefined): boolean {
  return path === '/dev/null' || path === 'dev/null';
}

function joinRepoPath(repoRoot: string | null | undefined, filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  if (isDiffNullPath(filePath) || filePath.startsWith('/')) return filePath;
  return repoRoot ? `${repoRoot}/${filePath}` : filePath;
}

function toReferenceDiffPath(path: string | null | undefined, options: {
  repoRoot?: string | null;
  selectedFilePath?: string | null;
  referenceFilePath?: string | null;
}): string {
  if (!path || isDiffNullPath(path)) return '/dev/null';
  if (path.startsWith('/')) return path;
  if (options.referenceFilePath && path === options.selectedFilePath) return options.referenceFilePath;
  return joinRepoPath(options.repoRoot, path) ?? path;
}

function formatDiffEndpoint(prefix: 'a' | 'b', path: string): string {
  if (isDiffNullPath(path)) return '/dev/null';
  return path.startsWith('/') ? path : `${prefix}/${path}`;
}

// --- Hunk-level git actions (stage / revert one hunk) ---
//
// The patch sent to the server is sliced out of the exact diff text we
// received, so context lines and "\ No newline" markers survive untouched.

export interface DiffHunkActionRequest {
  mode: DiffHunkApplyMode;
  patch: string;
  cwd: string;
  path: string;
}

// Minimal decoder for git's C-style quoted paths ("a/weird\tname"); returns
// null on malformed quoting so callers can bail out instead of guessing.
function unquoteDiffHeaderPath(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length - 1) return null;
    const esc = raw[i];
    if (esc === '\\' || esc === '"') out += esc;
    else if (esc === 'n') out += '\n';
    else if (esc === 't') out += '\t';
    else if (esc === 'r') out += '\r';
    else if (/[0-7]/.test(esc) && /^[0-7]{3}$/.test(raw.slice(i, i + 3))) {
      out += String.fromCharCode(parseInt(raw.slice(i, i + 3), 8));
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}

function diffFileHeaderMatches(line: string | undefined, prefix: 'a' | 'b', expectedPath: string | undefined): boolean {
  if (!line || !expectedPath) return false;
  let value = line.slice(4).trimEnd();
  const tabIndex = value.indexOf('\t');
  if (tabIndex >= 0) value = value.slice(0, tabIndex);
  if (isDiffNullPath(expectedPath)) return value === '/dev/null';
  const expected = `${prefix}/${expectedPath}`;
  if (value === expected) return true;
  if (value.startsWith('"')) return unquoteDiffHeaderPath(value) === expected;
  return false;
}

// Slice one hunk (with its file header) out of the raw unified diff. The
// file block is located by index — react-diff-view preserves the order of the
// parsed text — and then verified against the parsed file paths; a mismatch
// returns null so the caller can refuse to run the action.
export function extractHunkPatch(diffText: string, file: Pick<FileData, 'oldPath' | 'newPath'>, fileIndex: number, hunkIndex: number): string | null {
  if (!diffText) return null;
  const lines = diffText.split('\n');
  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) blockStarts.push(i);
  }
  if (fileIndex >= blockStarts.length) return null;
  const blockStart = blockStarts[fileIndex];
  const blockEnd = fileIndex + 1 < blockStarts.length ? blockStarts[fileIndex + 1] : lines.length;

  const hunkStarts: number[] = [];
  for (let i = blockStart; i < blockEnd; i += 1) {
    if (lines[i].startsWith('@@ ')) hunkStarts.push(i);
  }
  if (hunkStarts.length === 0 || hunkIndex >= hunkStarts.length) return null;

  const headerLines = lines.slice(blockStart, hunkStarts[0]);
  const oldHeader = headerLines.find((line) => line.startsWith('--- '));
  const newHeader = headerLines.find((line) => line.startsWith('+++ '));
  if (!oldHeader || !newHeader) return null;
  const expectedOld = file.oldPath && !isDiffNullPath(file.oldPath) ? file.oldPath : '/dev/null';
  const expectedNew = file.newPath && !isDiffNullPath(file.newPath) ? file.newPath : '/dev/null';
  if (!diffFileHeaderMatches(oldHeader, 'a', expectedOld) || !diffFileHeaderMatches(newHeader, 'b', expectedNew)) {
    return null;
  }

  const hunkStart = hunkStarts[hunkIndex];
  const hunkEnd = hunkIndex + 1 < hunkStarts.length ? hunkStarts[hunkIndex + 1] : blockEnd;
  const patch = [...headerLines, ...lines.slice(hunkStart, hunkEnd)].join('\n');
  return patch.endsWith('\n') ? patch : `${patch}\n`;
}

function rewriteDiffReferencePaths(diffText: string, files: FileData[], options: {
  repoRoot?: string | null;
  selectedFilePath?: string | null;
  referenceFilePath?: string | null;
}): string {
  if (!diffText || files.length === 0) return diffText;
  const oldPathMap = new Map<string, string>();
  const newPathMap = new Map<string, string>();
  for (const file of files) {
    if (file.oldPath && !isDiffNullPath(file.oldPath)) {
      oldPathMap.set(file.oldPath, toReferenceDiffPath(file.oldPath, options));
    }
    if (file.newPath && !isDiffNullPath(file.newPath)) {
      newPathMap.set(file.newPath, toReferenceDiffPath(file.newPath, options));
    }
  }

  return diffText.split('\n').map((line) => {
    const gitHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitHeader) {
      const oldRef = oldPathMap.get(gitHeader[1]) ?? toReferenceDiffPath(gitHeader[1], options);
      const newRef = newPathMap.get(gitHeader[2]) ?? toReferenceDiffPath(gitHeader[2], options);
      return `diff --git ${formatDiffEndpoint('a', oldRef)} ${formatDiffEndpoint('b', newRef)}`;
    }
    const oldHeader = line.match(/^--- (a\/(.+)|\/dev\/null)$/);
    if (oldHeader) {
      if (oldHeader[1] === '/dev/null') return line;
      const oldRef = oldPathMap.get(oldHeader[2]) ?? toReferenceDiffPath(oldHeader[2], options);
      return `--- ${formatDiffEndpoint('a', oldRef)}`;
    }
    const newHeader = line.match(/^\+\+\+ (b\/(.+)|\/dev\/null)$/);
    if (newHeader) {
      if (newHeader[1] === '/dev/null') return line;
      const newRef = newPathMap.get(newHeader[2]) ?? toReferenceDiffPath(newHeader[2], options);
      return `+++ ${formatDiffEndpoint('b', newRef)}`;
    }
    return line;
  }).join('\n');
}

interface DiffReferenceHunkMeta {
  filePath: string;
  hunkIndex: number;
  hunk: HunkData;
}

interface DiffReferenceMeta {
  filePath?: string | null;
  hunks?: DiffReferenceHunkMeta[];
}

type DiffReferenceChange = HunkData['changes'][number];

function formatLineNumberList(lineNumbers: number[]): string {
  if (lineNumbers.length === 0) return 'none';
  const ranges: string[] = [];
  let rangeStart = lineNumbers[0];
  let previous = lineNumbers[0];
  for (const lineNumber of lineNumbers.slice(1)) {
    if (lineNumber === previous + 1) {
      previous = lineNumber;
      continue;
    }
    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = lineNumber;
    previous = lineNumber;
  }
  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return ranges.join(', ');
}

function getChangedLineNumbers(hunk: HunkData): { oldLines: number[]; newLines: number[] } {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  for (const change of hunk.changes) {
    if (change.type === 'delete') oldLines.push(change.lineNumber);
    if (change.type === 'insert') newLines.push(change.lineNumber);
  }
  return { oldLines, newLines };
}

function formatHunkReferenceLine(hunkMeta: DiffReferenceHunkMeta): string {
  const changedLines = getChangedLineNumbers(hunkMeta.hunk);
  return `# ${hunkMeta.filePath}: hunk ${hunkMeta.hunkIndex + 1}, old lines ${formatLineNumberList(changedLines.oldLines)} -> new lines ${formatLineNumberList(changedLines.newLines)}`;
}

function formatDiffReferenceChange(change: DiffReferenceChange): string {
  if (change.type === 'insert') return change.content.startsWith('+') ? change.content : `+${change.content}`;
  if (change.type === 'delete') return change.content.startsWith('-') ? change.content : `-${change.content}`;
  return change.content.startsWith(' ') ? change.content : ` ${change.content}`;
}

function formatDiffReference(diffText: string, meta?: DiffReferenceMeta): string {
  const trimmedDiff = diffText.trimEnd();
  if (!meta) return `\`\`\`diff\n${trimmedDiff}\n\`\`\`\n`;
  const header = [
    ...(meta.hunks ?? []).map(formatHunkReferenceLine),
  ].filter((line): line is string => Boolean(line));
  return `\`\`\`diff\n${header.length > 0 ? `${header.join('\n')}\n` : ''}${trimmedDiff}\n\`\`\`\n`;
}

interface HunkSection {
  index: number;
  changes: HunkData['changes'];
  contextBefore: HunkData['changes'];
  contextAfter: HunkData['changes'];
}

function buildHunkSections(hunk: HunkData, contextSize = 2): HunkSection[] {
  const sections: HunkSection[] = [];
  let cursor = 0;
  while (cursor < hunk.changes.length) {
    while (cursor < hunk.changes.length && hunk.changes[cursor].type === 'normal') cursor += 1;
    if (cursor >= hunk.changes.length) break;
    const start = cursor;
    while (cursor < hunk.changes.length && hunk.changes[cursor].type !== 'normal') cursor += 1;
    const end = cursor;
    sections.push({
      index: sections.length,
      changes: hunk.changes.slice(start, end),
      contextBefore: hunk.changes.slice(Math.max(0, start - contextSize), start).filter((change) => change.type === 'normal'),
      contextAfter: hunk.changes.slice(end, Math.min(hunk.changes.length, end + contextSize)).filter((change) => change.type === 'normal'),
    });
  }
  return sections;
}

function formatSectionReferenceText(filePath: string, hunkIndex: number, hunk: HunkData, section: HunkSection, diffHeader: string): string {
  const sectionHunk = { ...hunk, changes: section.changes };
  const meta = { filePath, hunkIndex, hunk: sectionHunk };
  const sectionFingerprint = buildSectionFingerprint(section);
  const lines = [
    `# section ${section.index + 1}, sectionFingerprint ${sectionFingerprint}`,
    diffHeader,
    hunk.content,
    ...section.contextBefore.map(formatDiffReferenceChange),
    ...section.changes.map(formatDiffReferenceChange),
    ...section.contextAfter.map(formatDiffReferenceChange),
  ];
  return formatDiffReference(lines.join('\n'), { filePath, hunks: [meta] });
}

function buildHunkFingerprint(hunk: HunkData): string {
  const changedLines = hunk.changes
    .filter((change) => change.type === 'insert' || change.type === 'delete')
    .map((change) => `${change.type}:${change.content}`);
  const text = changedLines.length > 0
    ? changedLines.join('\n')
    : hunk.changes.map((change) => change.content).join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildSectionFingerprint(section: HunkSection): string {
  const text = section.changes
    .filter((change) => change.type === 'insert' || change.type === 'delete')
    .map((change) => `${change.type}:${change.content}`)
    .join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getChangeLineNumber(change: HunkData['changes'][number] | null | undefined): number | null {
  return change && 'lineNumber' in change && typeof change.lineNumber === 'number' ? change.lineNumber : null;
}

function isImportLikeLine(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return /^(import|export\s+type|using|#include)\b/.test(trimmed)
    || /^from\s+[\w.'"/-]+\s+import\b/.test(trimmed)
    || /^package\s+[\w.]+;?$/.test(trimmed);
}

function isImportOnlyHunk(hunk: HunkData): boolean {
  const changed = hunk.changes.filter((change) => change.type === 'insert' || change.type === 'delete');
  if (changed.length === 0 || !changed.every((change) => isImportLikeLine(change.content))) return false;
  const changedLineNumbers = new Set<number>();
  for (const change of changed) {
    const lineNumber = getChangeLineNumber(change);
    if (lineNumber === null) continue;
    if (changedLineNumbers.has(lineNumber)) return false;
    changedLineNumbers.add(lineNumber);
  }
  return true;
}

function alignAdjacentChangesForSplitView(hunk: HunkData): HunkData {
  const changes: HunkData['changes'] = [];
  let cursor = 0;
  while (cursor < hunk.changes.length) {
    const change = hunk.changes[cursor];
    if (change.type === 'normal') {
      changes.push(change);
      cursor += 1;
      continue;
    }

    const block: HunkData['changes'] = [];
    while (cursor < hunk.changes.length && hunk.changes[cursor].type !== 'normal') {
      block.push(hunk.changes[cursor]);
      cursor += 1;
    }
    const deletes = block.filter((item) => item.type === 'delete');
    const inserts = block.filter((item) => item.type === 'insert');
    const pairs = pairChangedLinesForDisplay(
      deletes.map((item) => ({ content: item.content, lineNumber: getChangeLineNumber(item) ?? -1 })),
      inserts.map((item) => ({ content: item.content, lineNumber: getChangeLineNumber(item) ?? -1 })),
    );
    const oldIndexByLine = new Map(deletes.map((item, index) => [getChangeLineNumber(item) ?? -1, index]));
    const newIndexByLine = new Map(inserts.map((item, index) => [getChangeLineNumber(item) ?? -1, index]));
    let oldCursor = 0;
    let newCursor = 0;
    for (const pair of pairs) {
      const pairedOldIndex = oldIndexByLine.get(pair.oldLineNumber);
      const pairedNewIndex = newIndexByLine.get(pair.newLineNumber);
      if (pairedOldIndex === undefined || pairedNewIndex === undefined) continue;
      while (newCursor < pairedNewIndex) changes.push(inserts[newCursor++]);
      while (oldCursor < pairedOldIndex) changes.push(deletes[oldCursor++]);
      changes.push(deletes[pairedOldIndex], inserts[pairedNewIndex]);
      oldCursor = pairedOldIndex + 1;
      newCursor = pairedNewIndex + 1;
    }
    while (oldCursor < deletes.length) changes.push(deletes[oldCursor++]);
    while (newCursor < inserts.length) changes.push(inserts[newCursor++]);
  }
  return { ...hunk, changes };
}


function buildAuditLookupKey(repoRoot: string | null | undefined, filePath: string): string {
  return `${repoRoot ?? ''}\u0000${filePath}`;
}

function auditPathMatches(pathValue: string, filePath: string): boolean {
  return pathValue === filePath
    || filePath.endsWith(`/${pathValue}`)
    || pathValue.endsWith(`/${filePath}`);
}

function isSectionAuditRecord(record: ChangeAuditRecord): boolean {
  return typeof record.sectionIndex === 'number'
    || (typeof record.sectionFingerprint === 'string' && record.sectionFingerprint.length > 0);
}

function getHunkAudit(records: ChangeAuditRecord[] | undefined, repoRoot: string | null | undefined, filePath: string, hunkHeader: string, fingerprint: string): HunkAuditView {
  if (!records || records.length === 0) return { fingerprint };
  const lookupKey = buildAuditLookupKey(repoRoot, filePath);
  let stale: ChangeAuditRecord | undefined;
  for (const record of records) {
    if (isSectionAuditRecord(record)) continue;
    const paths = [record.filePath, record.newPath, record.oldPath].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const exactRepoPathMatches = paths.some((pathValue) => buildAuditLookupKey(record.repoRoot, pathValue) === lookupKey);
    const fallbackPathMatches = paths.some((pathValue) => auditPathMatches(pathValue, filePath));
    const pathMatches = exactRepoPathMatches || fallbackPathMatches;
    if (!pathMatches) continue;
    if (record.fingerprint === fingerprint) return { current: record, fingerprint };
    if (!stale && record.hunkHeader === hunkHeader) stale = record;
  }
  return { stale, fingerprint };
}

function getSectionAudit(records: ChangeAuditRecord[] | undefined, repoRoot: string | null | undefined, filePath: string, hunkHeader: string, hunkFingerprint: string, sectionIndex: number, sectionFingerprint: string): SectionAuditView {
  if (!records || records.length === 0) return { fingerprint: sectionFingerprint };
  const lookupKey = buildAuditLookupKey(repoRoot, filePath);
  let stale: ChangeAuditRecord | undefined;
  for (const record of records) {
    const paths = [record.filePath, record.newPath, record.oldPath].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const pathMatches = paths.some((pathValue) => buildAuditLookupKey(record.repoRoot, pathValue) === lookupKey)
      || paths.some((pathValue) => auditPathMatches(pathValue, filePath));
    if (!pathMatches || record.hunkHeader !== hunkHeader) continue;
    if (record.sectionFingerprint === sectionFingerprint) return { current: record, fingerprint: sectionFingerprint };
    if (!stale && record.fingerprint === hunkFingerprint && record.sectionIndex === sectionIndex) stale = record;
  }
  return { stale, fingerprint: sectionFingerprint };
}

function getSectionWidgetChangeKey(section: HunkSection): string | null {
  const lastChanged = section.changes[section.changes.length - 1];
  return lastChanged ? getChangeKey(lastChanged) : null;
}

function getDiffGutterWidthCh(hunks: HunkData[]): number {
  let maxLineNumber = 0;
  for (const hunk of hunks) {
    maxLineNumber = Math.max(
      maxLineNumber,
      hunk.oldStart + Math.max(0, hunk.oldLines - 1),
      hunk.newStart + Math.max(0, hunk.newLines - 1),
    );
  }
  return Math.max(3, String(maxLineNumber).length + 0.5);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function formatDiffLimitMessage(result: DiffLoadResult): string | null {
  if (result.tooLarge) {
    const size = formatBytes(result.size);
    const max = formatBytes(result.maxBytes);
    return `Diff is too large${size ? ` (${size}` : ''}${max ? `${size ? ', ' : ' ('}limit ${max}` : ''}${size || max ? ')' : ''}.`;
  }
  if (result.skippedFiles && result.skippedFiles.length > 0) {
    const first = result.skippedFiles[0];
    const size = formatBytes(first.size);
    const suffix = result.skippedFiles.length > 1 ? ` and ${result.skippedFiles.length - 1} more file(s)` : '';
    if (first.reason === 'binary-file') {
      return `Binary file changed: ${first.path}${size ? ` (${size})` : ''}. Content was not loaded${suffix}.`;
    }
    return `Skipped large untracked file ${first.path}${size ? ` (${size})` : ''}${suffix}.`;
  }
  return null;
}

export function isDiffTooLargeToRender(diffText: string | null): boolean {
  if (!diffText) return false;
  let lines = 1;
  for (let i = 0; i < diffText.length; i += 1) {
    if (diffText.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > MAX_RENDER_DIFF_LINES) return true;
    }
  }
  return false;
}

function isDiffViewType(value: unknown): value is DiffViewType {
  return value === 'unified' || value === 'split';
}

function readDiffViewType(): DiffViewType {
  return readCache(DIFF_VIEW_TYPE_STORAGE_KEY, isDiffViewType) ?? 'unified';
}

function formatAuditTimestamp(timestamp: number | null | undefined, locale: string): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function canUseSplitDiffView(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(SPLIT_DIFF_MEDIA_QUERY).matches;
}

/**
 * F7-based hunk navigation must not steal keys from text entry: the terminal
 * maps F7 to an escape sequence the shell may rely on, and inputs may use it
 * for their own purposes.
 */
function isDiffNavTypingTarget(element: Element | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return false;
  return element.tagName === 'INPUT'
    || element.tagName === 'TEXTAREA'
    || element.isContentEditable
    || Boolean(element.closest('.xterm'));
}

/**
 * Inline hint that says "swipe to see more" above a file's diff row.
 * Self-dismisses on first tap so it doesn't get in the way of repeat
 * visits — the user has seen it once, they know now.
 */
function DiffScrollHint() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <button
      type="button"
      onClick={() => setDismissed(true)}
      className="flex w-full items-center justify-center gap-1.5 border-b border-border/15 bg-surface-2/40 px-2 py-1 text-[10px] text-muted-foreground transition active:scale-[0.99] hover:bg-surface-2 hover:text-foreground"
      title={t('rightSidebar.horizontalScrollHint')}
    >
      <RiMoveHorizontal size={11} className="shrink-0" />
      <span className="truncate">{t('rightSidebar.horizontalScrollHint')}</span>
    </button>
  );
}

export function DiffViewer({ filePath, repoRoot, referenceFilePath, interactionId, requestSlotId, changedFile, onInsertDiffReference, onHunkGitAction, onReferenceCopied, insertedReferenceKey, copiedReferenceKey, wrap = false, showScrollHint = false, reloadKey = 0, embedded = false, active = true, lightweight = false, auditRecords, diffOverride, preparedDiff, viewType: controlledViewType, inlineMode = 'words', diffOptions, oldSourceOverride, onClearAuditRecord, onContentReady, onSummaryChange }: DiffViewerProps) {
  const { t, locale } = useI18n();
  // Each viewer owns its request state. This is important for the mobile
  // accordion: multiple files can stay expanded without fighting over one
  // global diff slot in the sidebar store.
  const [preferredViewType, setPreferredViewType] = useState<DiffViewType>(() => readDiffViewType());
  const [splitViewAvailable, setSplitViewAvailable] = useState(() => canUseSplitDiffView());
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffNotice, setDiffNotice] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [parsedFiles, setParsedFiles] = useState<FileData[]>([]);
  const [workerTokens, setWorkerTokens] = useState<Map<string, HunkTokens>>(() => new Map());
  const [parsedDiffInput, setParsedDiffInput] = useState<ParsedDiffInput | null>(null);
  const [oldSourceContent, setOldSourceContent] = useState<string | null>(null);
  const [expandedImportHunks, setExpandedImportHunks] = useState<Set<string>>(() => new Set());
  const [imagePreview, setImagePreview] = useState<{
    objectUrl: string;
    size: number | null;
    mimeType: string;
    dimensions?: { width: number; height: number };
  } | null>(null);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const previousReloadKeyRef = useRef(reloadKey);
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);
  const viewType: DiffViewType = (controlledViewType ?? preferredViewType) === 'split' && splitViewAvailable ? 'split' : 'unified';

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(SPLIT_DIFF_MEDIA_QUERY);
    const update = () => setSplitViewAvailable(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const updateViewType = useCallback((next: DiffViewType) => {
    setPreferredViewType(next);
    writeCache(DIFF_VIEW_TYPE_STORAGE_KEY, next);
  }, []);

  const {
    whitespace: whitespacePref,
    context: contextPref,
    setWhitespace: setWhitespacePref,
    setContext: setContextPref,
  } = useDiffDisplayPrefs();
  // With diffOverride/preparedDiff the content is supplied by the caller, so
  // whitespace/context tweaks cannot be re-fetched from here.
  const diffOptionsLocked = diffOverride !== undefined || preparedDiff !== undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffHoveredRef = useRef(false);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | null>(null);

  const jumpToHunk = useCallback((direction: 1 | -1) => {
    const container = containerRef.current;
    if (!container) return;
    const anchors = container.querySelectorAll('[data-diff-hunk-anchor]');
    if (anchors.length === 0) return;
    setActiveHunkIndex((current) => {
      const base = current !== null && current >= 0 && current < anchors.length
        ? current
        : (direction === 1 ? -1 : 0);
      const next = (base + direction + anchors.length) % anchors.length;
      const anchor = anchors[next];
      if (anchor instanceof HTMLElement) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return next;
    });
  }, []);

  // F7 / Shift+F7 jump between hunks (IntelliJ-style), but only while the
  // pointer is over this diff or focus is inside it — never while the user
  // is typing in the terminal or an input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F7') return;
      const container = containerRef.current;
      if (!container) return;
      const activeElement = document.activeElement;
      const focusInside = activeElement instanceof Node && container.contains(activeElement);
      if (!diffHoveredRef.current && !focusInside) return;
      if (isDiffNavTypingTarget(activeElement)) return;
      event.preventDefault();
      jumpToHunk(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [jumpToHunk]);
  const changedFileRepoRoot = changedFile?.repoRoot ?? null;
  const changedFileStatus = changedFile?.status ?? null;
  const auditRepoRoot = changedFileRepoRoot ?? repoRoot ?? rootPath;
  const referenceRepoRoot = changedFileRepoRoot ?? repoRoot ?? rootPath;
  const resolvedReferenceFilePath = referenceFilePath
    ?? changedFile?.absolutePath
    ?? joinRepoPath(referenceRepoRoot, filePath);

  useEffect(() => {
    if (preparedDiff !== undefined) {
      setOldSourceContent(null);
      return;
    }
    if (oldSourceOverride !== undefined) {
      setOldSourceContent(oldSourceOverride);
      return;
    }
    const gitRoot = changedFileRepoRoot ?? repoRoot ?? rootPath;
    if (!active || diffOverride || !gitRoot || !filePath || changedFile?.untracked || changedFileStatus === 'added') {
      setOldSourceContent(null);
      return;
    }
    setOldSourceContent(null);
    const controller = new AbortController();
    const source = 'ref';
    getGitBlobContent(filePath, gitRoot, 'HEAD', controller.signal, source)
      .then((result) => {
        if (!controller.signal.aborted) setOldSourceContent(result.truncated || result.error ? null : result.content);
      })
      .catch(() => {
        if (!controller.signal.aborted) setOldSourceContent(null);
      });
    return () => controller.abort();
  }, [active, changedFile?.untracked, changedFileRepoRoot, changedFileStatus, diffOverride, filePath, oldSourceOverride, preparedDiff, repoRoot, rootPath]);

  useEffect(() => {
    if (preparedDiff !== undefined) return;
    if (diffOverride !== undefined) {
      setDiffContent(diffOverride);
      setDiffNotice(null);
      setDiffError(null);
      setDiffLoading(false);
      setImagePreview(null);
      return;
    }
    if (!active) {
      setDiffLoading(false);
      logDiffViewerEvent('effect_skip_inactive', { interactionId, requestSlotId, filePath, repoRoot, changedFileRepoRoot, rootPath });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const path = filePath;
    const gitRoot = changedFileRepoRoot ?? repoRoot ?? (path?.startsWith('/') ? null : rootPath);
    const loadingId = ++diffLoadingSeq;
    const traceId = `diff-${Date.now().toString(36)}-${(++diffTraceSeq).toString(36)}`;
    let loadingEnded = false;
    const startedAt = performance.now();

    const endLoading = (reason: string, extra: Record<string, unknown> = {}) => {
      if (loadingEnded) return;
      loadingEnded = true;
      logDiffLoadingEvent('end', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        reason,
        durationMs: Math.round(performance.now() - startedAt),
        filePath: path,
        gitRoot,
        ...extra,
      });
    };

    const requestPath = toDiffRequestPath(path, gitRoot);
    const readablePath = path && gitRoot && !path.startsWith('/') ? `${gitRoot}/${path}` : path;
    const forceReload = previousReloadKeyRef.current !== reloadKey;
    previousReloadKeyRef.current = reloadKey;

    if (path && !gitRoot) {
      logDiffViewerEvent('effect_wait_for_repo_root', { interactionId, requestSlotId, traceId, filePath: path, repoRoot, changedFileRepoRoot, rootPath });
      setDiffContent(null);
      setDiffNotice(null);
      setDiffError(null);
      setImagePreview(null);
      setDiffLoading(false);
      endLoading('waiting_for_repo_root');
      return;
    }

    const cachedDiff = getCachedDiffResult(requestPath, gitRoot ?? undefined, diffOptions);
    logDiffLoadingEvent('start', {
      loadingId,
      interactionId,
      requestSlotId,
      traceId,
      filePath: path,
      requestPath,
      gitRoot,
      readablePath,
      forceReload,
      hasCachedDiff: Boolean(cachedDiff),
      embedded,
      active,
    });
    const watchdog = window.setTimeout(() => {
      if (loadingEnded || cancelled) return;
      logDiffLoadingEvent('still_active', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        filePath: path,
        requestPath,
        gitRoot,
        durationMs: Math.round(performance.now() - startedAt),
        hasCachedDiff: Boolean(cachedDiff),
        controllerAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
    }, 3_000);
    const longWatchdog = window.setTimeout(() => {
      if (loadingEnded || cancelled) return;
      logDiffLoadingEvent('still_active_long', {
        loadingId,
        interactionId,
        requestSlotId,
        traceId,
        filePath: path,
        requestPath,
        gitRoot,
        durationMs: Math.round(performance.now() - startedAt),
        hasCachedDiff: Boolean(cachedDiff),
        controllerAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
      setDiffError('Diff response is taking too long to finish in the browser. Try selecting the file again.');
      setDiffLoading(false);
      endLoading('client_watchdog_timeout');
    }, 10_000);
    logDiffViewerEvent('effect_start', {
      interactionId,
      requestSlotId,
      traceId,
      loadingId,
      filePath: path,
      requestPath,
      gitRoot,
      readablePath,
      forceReload,
      hasCachedDiff: Boolean(cachedDiff),
      cachedBytes: cachedDiff?.diff?.length ?? 0,
    });
    setDiffContent(cachedDiff?.diff ?? null);
    setDiffNotice(cachedDiff ? formatDiffLimitMessage(cachedDiff) : null);
    setDiffLoading(!cachedDiff);
    setDiffError(cachedDiff?.error ?? null);
    setImagePreview(null);

    const loadTextDiff = () => (
      (forceReload && cachedDiff
        ? refreshFileDiffCached(requestPath, gitRoot ?? undefined, diffOptions)
        : loadVisibleFileDiff(requestPath, gitRoot ?? undefined, controller.signal, forceReload, traceId, interactionId, requestSlotId, diffOptions))
        .then((result) => {
          if (cancelled) return;
          const notice = formatDiffLimitMessage(result);
          const tooLargeToRender = isDiffTooLargeToRender(result.diff);
          setDiffNotice(tooLargeToRender ? 'Diff has too many lines to preview safely.' : notice);
          setDiffContent(result.tooLarge || tooLargeToRender ? '' : result.diff);
          setDiffError(result.error ?? null);
          logDiffViewerEvent('state_set_result', {
            interactionId,
            requestSlotId,
            traceId,
            loadingId,
            filePath: path,
            requestPath,
            gitRoot,
            bytes: result.diff?.length ?? 0,
            tooLargeToRender,
            resultTooLarge: Boolean(result.tooLarge),
            error: result.error ?? null,
          });
        })
        .catch((err) => {
          if (cancelled || isAbortError(err)) return;
          const message = err instanceof Error ? err.message : 'Failed to load diff';
          if (cachedDiff?.diff) {
            setDiffNotice(message);
            setDiffError(null);
          } else {
            setDiffContent(null);
            setDiffNotice(null);
            setDiffError(message);
          }
          logDiffViewerEvent('state_set_error', { interactionId, requestSlotId, traceId, filePath: path, requestPath, gitRoot, error: message, hadCachedDiff: Boolean(cachedDiff?.diff) });
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
          endLoading(cancelled ? 'cancelled_finally' : 'finally');
          logDiffViewerEvent('load_text_finally', { interactionId, requestSlotId, traceId, loadingId, filePath: path, requestPath, gitRoot, cancelled });
        })
    );

    if (cachedDiff && !forceReload) {
      setDiffLoading(false);
      endLoading('cache_hit');
    } else if (cachedDiff && forceReload) {
      void loadTextDiff();
    } else if (shouldPreferImagePreview(readablePath, changedFileStatus ? { status: changedFileStatus } : null)) {
      readImagePreviewBlob(readablePath as string, controller.signal, 'view_diff_image', requestSlotId ? `${requestSlotId}:image` : undefined)
        .then((result) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(result.blob);
          setImagePreview({ objectUrl, size: result.size, mimeType: result.mimeType });
          endLoading('image_preview_loaded', { bytes: result.size, mimeType: result.mimeType });
        })
        .catch(() => {
          if (cancelled || controller.signal.aborted) return;
          // A changed image may have been removed or moved after the file list
          // was loaded. Fall back to Git diff instead of surfacing a preview
          // error, so deleted/renamed binary files still explain what changed.
          return loadTextDiff();
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
          if (cancelled) endLoading('image_cancelled_finally');
        });
    } else {
      loadTextDiff();
    }

    return () => {
      cancelled = true;
      controller.abort();
      cancelIoSlot(requestSlotId);
      window.clearTimeout(watchdog);
      window.clearTimeout(longWatchdog);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      endLoading('cleanup');
      logDiffViewerEvent('effect_cleanup', {
        interactionId,
        requestSlotId,
        traceId,
        loadingId,
        filePath: path,
        requestPath,
        gitRoot,
        loadingEnded,
        signalAborted: controller.signal.aborted,
        abortReason: controller.signal.aborted ? String(controller.signal.reason ?? '') : undefined,
        cacheSize: diffResultCache.size,
        promiseSize: diffPromiseCache.size,
      });
    };
  }, [active, changedFileRepoRoot, changedFileStatus, diffOptions, diffOverride, filePath, interactionId, preparedDiff, reloadKey, repoRoot, requestSlotId, rootPath]);

  useEffect(() => {
    if (preparedDiff !== undefined) return;
    if (!diffContent || diffContent.trim() === '') {
      setParsedFiles([]);
      setWorkerTokens(new Map());
      setParsedDiffInput(null);
      return;
    }
    let cancelled = false;
    const startedAt = performance.now();
    const gitRoot = changedFileRepoRoot ?? repoRoot ?? (filePath?.startsWith('/') ? null : rootPath);
    const requestPath = toDiffRequestPath(filePath, gitRoot);
    const parseInlineMode = lightweight ? 'none' : inlineMode;
    const parseLanguage = resolveLanguage(filePath) ?? undefined;
    const parseCacheKey = buildParsedDiffCacheKey(
      requestPath,
      gitRoot ?? undefined,
      diffOptions,
      parseInlineMode,
      parseLanguage,
    );
    loadParsedDiffCached(
      diffContent,
      oldSourceContent ?? undefined,
      requestPath,
      gitRoot ?? undefined,
      diffOptions,
      parseInlineMode,
      parseLanguage,
    )
      .then((result) => {
        if (cancelled) return;
        setParsedFiles(result.files);
        setWorkerTokens(result.tokens);
        setParsedDiffInput({ cacheKey: parseCacheKey, diffContent });
        logDiffViewerEvent('worker_parse_done', {
          filePath,
          bytes: diffContent.length,
          files: result.files.length,
          parseMs: result.parseMs,
          tokenizeMs: result.tokenizeMs,
          durationMs: Math.round(performance.now() - startedAt),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setParsedFiles([]);
        setWorkerTokens(new Map());
        setParsedDiffInput({ cacheKey: parseCacheKey, diffContent });
        setDiffError(error instanceof Error ? error.message : String(error));
        logDiffViewerEvent('worker_parse_error', {
          filePath,
          bytes: diffContent.length,
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [changedFileRepoRoot, diffContent, diffOptions, filePath, inlineMode, lightweight, oldSourceContent, preparedDiff, repoRoot, rootPath]);

  const effectiveDiffContent = preparedDiff !== undefined ? preparedDiff?.diffContent ?? null : diffContent;
  const effectiveDiffNotice = preparedDiff !== undefined ? preparedDiff?.diffNotice ?? null : diffNotice;
  const rawEffectiveDiffError = preparedDiff !== undefined ? preparedDiff?.diffError ?? null : diffError;
  const effectiveDiffError = rawEffectiveDiffError?.toLowerCase().includes('signal is aborted') ? null : rawEffectiveDiffError;
  const parseGitRoot = changedFileRepoRoot ?? repoRoot ?? (filePath?.startsWith('/') ? null : rootPath);
  const parseRequestPath = toDiffRequestPath(filePath, parseGitRoot);
  const currentParseCacheKey = buildParsedDiffCacheKey(
    parseRequestPath,
    parseGitRoot ?? undefined,
    diffOptions,
    lightweight ? 'none' : inlineMode,
    resolveLanguage(filePath) ?? undefined,
  );
  const parsedContentReady = !diffContent || (
    parsedDiffInput?.cacheKey === currentParseCacheKey
    && parsedDiffInput.diffContent === diffContent
  );
  const effectiveDiffLoading = preparedDiff !== undefined ? false : diffLoading || !parsedContentReady;
  const files = preparedDiff !== undefined ? preparedDiff?.files ?? [] : parsedFiles;

  useEffect(() => {
    if (!active || effectiveDiffLoading) return;
    if (effectiveDiffContent === null && !effectiveDiffError && !imagePreview && diffOverride === undefined && preparedDiff === undefined) return;
    onContentReady?.();
  }, [active, effectiveDiffContent, effectiveDiffError, effectiveDiffLoading, diffOverride, imagePreview, onContentReady, preparedDiff]);

  const effectiveAuditRecords = auditRecords ?? [];

  const fileTokens = preparedDiff !== undefined ? preparedDiff?.tokens ?? new Map() : workerTokens;


  const totalChanges = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
    }
    return { additions, deletions };
  }, [files]);

  useEffect(() => {
    if (!onSummaryChange) return;
    onSummaryChange(files.length > 0 ? { files: files.length, ...totalChanges } : null);
  }, [files.length, onSummaryChange, totalChanges]);

  const fileStats = useMemo(() => {
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const file of files) {
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
      stats.set(`${file.oldRevision}-${file.newRevision}-${file.newPath}`, { additions, deletions });
    }
    return stats;
  }, [files]);

  const titleParts = getPathParts(filePath, { name: t('diffViewer.workingTree'), dir: t('diffViewer.allUnstaged') });
  const wholeDiffReferenceKey = `diff:whole:${filePath ?? 'all'}`;

  const wholeDiffText = useMemo(() => {
    if (!effectiveDiffContent) return '';
    const referencePathOptions = {
      repoRoot: referenceRepoRoot,
      selectedFilePath: filePath,
      referenceFilePath: resolvedReferenceFilePath,
    };
    const hunks = files.flatMap((file) => {
      const displayPath = file.newPath && !isDiffNullPath(file.newPath)
        ? file.newPath
        : file.oldPath && !isDiffNullPath(file.oldPath) ? file.oldPath : 'unknown file';
      const referencePath = toReferenceDiffPath(displayPath, referencePathOptions);
      return file.hunks.map((hunk, hunkIndex) => ({ filePath: referencePath, hunkIndex, hunk }));
    });
    return formatDiffReference(rewriteDiffReferencePaths(effectiveDiffContent, files, referencePathOptions), {
      filePath,
      hunks,
    });
  }, [effectiveDiffContent, filePath, files, referenceRepoRoot, resolvedReferenceFilePath]);

  const insertWholeDiff = useCallback(() => {
    if (!wholeDiffText || !onInsertDiffReference) return;
    onInsertDiffReference(filePath ? `${titleParts.name} diff` : t('diffViewer.allDiffLabel'), wholeDiffText, wholeDiffReferenceKey);
  }, [filePath, onInsertDiffReference, t, titleParts.name, wholeDiffReferenceKey, wholeDiffText]);

  // Hunk-level git actions (stage / revert). The patch is sliced from the raw
  // diff text at click time so stale renders fail server-side with a readable
  // git error instead of silently applying the wrong thing.
  const [runningHunkActionKey, setRunningHunkActionKey] = useState<string | null>(null);
  const [hunkActionError, setHunkActionError] = useState<{ key: string; message: string } | null>(null);
  const [revertConfirmKey, setRevertConfirmKey] = useState<string | null>(null);

  // New diff data reshuffles hunks; drop stale action state.
  useEffect(() => {
    setHunkActionError(null);
    setRevertConfirmKey(null);
  }, [files]);

  useEffect(() => {
    if (!revertConfirmKey) return;
    const timer = window.setTimeout(() => setRevertConfirmKey(null), 5000);
    return () => window.clearTimeout(timer);
  }, [revertConfirmKey]);

  const hunkActionGitRoot = changedFileRepoRoot ?? repoRoot ?? (filePath?.startsWith('/') ? null : rootPath);
  const canRunHunkActions = Boolean(onHunkGitAction && hunkActionGitRoot && diffOverride == null && preparedDiff == null);

  const runHunkGitAction = useCallback(async (mode: DiffHunkApplyMode, actionKey: string, file: FileData, fileIndex: number, hunkIndex: number, displayPath: string) => {
    if (!onHunkGitAction || !hunkActionGitRoot) return;
    const patch = effectiveDiffContent ? extractHunkPatch(effectiveDiffContent, file, fileIndex, hunkIndex) : null;
    if (!patch) {
      setHunkActionError({ key: actionKey, message: t('diffViewer.hunkActionUnavailable') });
      return;
    }
    setRunningHunkActionKey(actionKey);
    setHunkActionError(null);
    try {
      await onHunkGitAction({
        mode,
        patch,
        cwd: hunkActionGitRoot,
        path: joinRepoPath(hunkActionGitRoot, displayPath) ?? displayPath,
      });
    } catch (error) {
      setHunkActionError({ key: actionKey, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunningHunkActionKey((current) => (current === actionKey ? null : current));
      setRevertConfirmKey((current) => (current === actionKey ? null : current));
    }
  }, [onHunkGitAction, hunkActionGitRoot, effectiveDiffContent, t]);

  // Per-hunk derived data (sections, inline moved-line candidates, split-view
  // alignment). findMovedLineCandidates is O(deleted × inserted) similarity
  // work — recomputing it inside the JSX map on EVERY render made unrelated
  // re-renders (e.g. the sidebar drawer closing) block the main thread for
  // hundreds of ms. Keyed by hunk object identity: `files` only changes when
  // new diff data arrives, which is exactly when a recompute is needed.
  const hunkDerivedMap = useMemo(() => {
    const map = new Map<object, {
      hunkSections: ReturnType<typeof buildHunkSections>;
      movedCandidates: ReturnType<typeof findMovedLineCandidates>;
      movedOldLines: Set<number>;
      movedNewLines: Set<number>;
      importOnlyHunk: boolean;
      displayHunk: (typeof files)[number]['hunks'][number];
    }>();
    for (const file of files) {
      for (const hunk of file.hunks) {
        const deletedChanges = lightweight ? [] : hunk.changes
          .filter((change) => change.type === 'delete')
          .map((change) => ({ content: change.content, lineNumber: change.lineNumber }));
        const insertedChanges = lightweight ? [] : hunk.changes
          .filter((change) => change.type === 'insert')
          .map((change) => ({ content: change.content, lineNumber: change.lineNumber }));
        const movedCandidates = lightweight ? [] : findMovedLineCandidates(deletedChanges, insertedChanges);
        map.set(hunk, {
          hunkSections: lightweight ? [] : buildHunkSections(hunk),
          movedCandidates,
          movedOldLines: new Set(movedCandidates.map((candidate) => candidate.oldLineNumber)),
          movedNewLines: new Set(movedCandidates.map((candidate) => candidate.newLineNumber)),
          importOnlyHunk: isImportOnlyHunk(hunk),
          displayHunk: viewType === 'split' ? alignAdjacentChangesForSplitView(hunk) : hunk,
        });
      }
    }
    return map;
  }, [files, lightweight, viewType]);

  const totalHunks = useMemo(() => files.reduce((sum, file) => sum + file.hunks.length, 0), [files]);

  // New diff data reshuffles hunk positions; drop the stale jump target.
  useEffect(() => {
    setActiveHunkIndex(null);
  }, [files]);

  const renderFileDiffs = (hideSingleFileHeader: boolean) => {
    // Flat index across all files' hunks, matching the DOM order of
    // [data-diff-hunk-anchor] used by jumpToHunk.
    let hunkFlatCursor = 0;
    return (
    <>
      {files.map((file, fileIndex) => {
        const key = `${file.oldRevision}-${file.newRevision}-${file.newPath}`;
        const stats = fileStats.get(key) ?? { additions: 0, deletions: 0 };
        const displayPath = file.newPath && !isDiffNullPath(file.newPath)
          ? file.newPath
          : file.oldPath && !isDiffNullPath(file.oldPath) ? file.oldPath : 'unknown file';
        const referencePathOptions = {
          repoRoot: referenceRepoRoot,
          selectedFilePath: filePath,
          referenceFilePath: resolvedReferenceFilePath,
        };
        const referenceDisplayPath = toReferenceDiffPath(displayPath, referencePathOptions);
        const referenceOldPath = toReferenceDiffPath(file.oldPath || displayPath, referencePathOptions);
        const referenceNewPath = toReferenceDiffPath(file.newPath || displayPath, referencePathOptions);
        const pathParts = getPathParts(displayPath, { name: 'unknown file', dir: '' });
        const showFileHeader = !hideSingleFileHeader || files.length > 1;
        const fileDiffReferenceText = [
          `diff --git ${formatDiffEndpoint('a', referenceOldPath)} ${formatDiffEndpoint('b', referenceNewPath)}`,
          ...file.hunks.flatMap((hunk) => [hunk.content, ...hunk.changes.map(formatDiffReferenceChange)]),
        ].join('\n');
        const fileDiffText = formatDiffReference(fileDiffReferenceText, {
          filePath: referenceDisplayPath,
          hunks: file.hunks.map((hunk, hunkIndex) => ({ filePath: referenceDisplayPath, hunkIndex, hunk })),
        });
        const fileDiffReferenceKey = `diff:file:${displayPath}`;
        const fileDiffReferenceActive = insertedReferenceKey === fileDiffReferenceKey || copiedReferenceKey === fileDiffReferenceKey;
        const diffGutterStyle = { '--termdock-diff-gutter-width': `${getDiffGutterWidthCh(file.hunks)}ch` } as React.CSSProperties;
        return (
        // Keep a stable file anchor on each parsed diff block. It is useful for
        // deep links/debugging and preserves the previous DOM contract even when
        // the mobile UI renders each file inline as an accordion body.
        <div
          key={key}
          data-diff-file-anchor={displayPath}
          className={embedded ? 'overflow-hidden bg-surface' : 'mt-3 border border-border/20 bg-surface'}
          style={diffGutterStyle}
        >
          {showFileHeader && (
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/15 bg-surface-2/95 px-2 py-1.5 backdrop-blur">
              <div className="min-w-0" title={file.newPath || file.oldPath}>
                <div className="truncate font-mono text-[11px] text-foreground">{pathParts.name}</div>
                {pathParts.dir && <div className="truncate font-mono text-[10px] text-muted-foreground/70">{pathParts.dir}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] font-medium text-[color:var(--diff-insert-strong)]">+{stats.additions}</span>
                <span className="text-[10px] font-medium text-[color:var(--diff-delete-strong)]">-{stats.deletions}</span>
                {onInsertDiffReference && files.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onInsertDiffReference(`${pathParts.name} diff`, fileDiffText, fileDiffReferenceKey)}
                    {...getReferenceLongPressHandlers(fileDiffText, fileDiffReferenceKey)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold active:scale-95 ${fileDiffReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}
                    title={t('diffViewer.insertFileDiff')}
                  >
                    {copiedReferenceKey === fileDiffReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === fileDiffReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertFileShort')}
                  </button>
                )}
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {file.type}
                </span>
              </div>
            </div>
          )}
          {/* Scroll hint: only shown when wrap is off (otherwise it would
              lie) and only once per file per visit, dismissed by tap. The
              user still gets the visual cue without it nagging on every
              open. */}
          {showScrollHint && !wrap && file.hunks.length > 0 && <DiffScrollHint />}
          {/*
            `termdock-diff-scroll` opts this card into a CSS rule that
            sets `touch-action: pan-x` on the inner overflow element. That
            tells the browser the user wants horizontal panning on touch
            here, so it doesn't get hijacked by the parent vertical
            scroller's overscroll/pan-y chain.
            `termdock-diff-wrap` flips long lines to wrap mode instead.
          */}
          {file.hunks.length === 0 ? (
            <div className="bg-surface-2 px-3 py-5 text-center text-xs text-muted-foreground">
              <RiGitCompare size={18} className="mx-auto mb-2 text-muted-foreground/80" />
              {t('diffViewer.binaryOrEmpty')}
            </div>
          ) : (
            <div className={`termdock-native-select overflow-x-auto termdock-diff-scroll ${viewType === 'split' ? 'diff-split' : ''} ${wrap ? 'termdock-diff-wrap' : ''}`}>
              <div className="min-w-full">
                {file.hunks.map((hunk, index) => {
                    const hunkFlatIndex = hunkFlatCursor;
                    hunkFlatCursor += 1;
                    const diffHeader = `diff --git ${formatDiffEndpoint('a', referenceOldPath)} ${formatDiffEndpoint('b', referenceNewPath)}`;
                    const hunkDiffText = formatDiffReference([
                      diffHeader,
                      hunk.content,
                      ...hunk.changes.map(formatDiffReferenceChange),
                    ].join('\n'), {
                      filePath: referenceDisplayPath,
                      hunks: [{ filePath: referenceDisplayPath, hunkIndex: index, hunk }],
                    });
                    const hunkFingerprint = buildHunkFingerprint(hunk);
                    const hunkAudit = getHunkAudit(effectiveAuditRecords, auditRepoRoot, displayPath, hunk.content, hunkFingerprint);
                    const hunkReferenceKey = `diff:hunk:${displayPath}:${index}`;
                    const hunkReferenceActive = insertedReferenceKey === hunkReferenceKey || copiedReferenceKey === hunkReferenceKey;
                    const stageHunkKey = `stage:${displayPath}:${index}`;
                    const revertHunkKey = `revert:${displayPath}:${index}`;
                    const hunkActionBusy = runningHunkActionKey !== null;
                    const canStageHunk = canRunHunkActions && (!changedFile || changedFile.unstaged || changedFile.untracked);
                    const thisHunkActionError = hunkActionError && (hunkActionError.key === stageHunkKey || hunkActionError.key === revertHunkKey)
                      ? hunkActionError.message
                      : null;
                    const importCollapseKey = `${displayPath}\0${index}\0${hunk.content}`;
                    const derived = hunkDerivedMap.get(hunk);
                    const hunkSections = derived?.hunkSections ?? [];
                    const movedCandidates = derived?.movedCandidates ?? [];
                    const importOnlyHunk = derived?.importOnlyHunk ?? false;
                    const importCollapsed = importOnlyHunk && !expandedImportHunks.has(importCollapseKey);
                    const movedOldLines = derived?.movedOldLines ?? new Set<number>();
                    const movedNewLines = derived?.movedNewLines ?? new Set<number>();
                    const displayHunk = derived?.displayHunk ?? hunk;
                    const sectionWidgets = hunkSections.reduce<Record<string, ReactNode>>((widgets, section) => {
                      const sectionFingerprint = buildSectionFingerprint(section);
                      const sectionAudit = getSectionAudit(effectiveAuditRecords, auditRepoRoot, displayPath, hunk.content, hunkFingerprint, section.index, sectionFingerprint);
                      const auditRecord = sectionAudit.current ?? sectionAudit.stale;
                      if (!auditRecord && !onInsertDiffReference) return widgets;
                      const widgetKey = getSectionWidgetChangeKey(section);
                      if (!widgetKey) return widgets;
                      const sectionKey = `diff:section:${displayPath}:${index}:${section.index}`;
                      const sectionText = onInsertDiffReference ? formatSectionReferenceText(referenceDisplayPath, index, hunk, section, diffHeader) : '';
                      const activeSection = insertedReferenceKey === sectionKey || copiedReferenceKey === sectionKey;
                      const sectionButton = onInsertDiffReference ? (
                        <button
                          type="button"
                          onClick={() => onInsertDiffReference(`${pathParts.name} hunk ${index + 1}.${section.index + 1}`, sectionText, sectionKey)}
                          {...getReferenceLongPressHandlers(sectionText, sectionKey)}
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition active:scale-95 ${
                            activeSection
                              ? 'bg-surface-elevated text-foreground'
                              : auditRecord
                                ? 'text-primary/80 hover:bg-primary/10 hover:text-primary'
                                : 'text-muted-foreground/45 hover:bg-surface-2 hover:text-muted-foreground'
                          }`}
                          title={auditRecord ? auditRecord.summary ?? auditRecord.explanation : 'Insert this hunk section'}
                        >
                          {copiedReferenceKey === sectionKey ? t('rightSidebar.copied') : insertedReferenceKey === sectionKey ? t('rightSidebar.inserted') : t('diffViewer.insertHunkShort')}
                        </button>
                      ) : null;
                      widgets[widgetKey] = (
                        <div
                          data-diff-section-anchor={displayPath}
                          data-diff-section-audit={displayPath}
                          data-diff-hunk-index={index}
                          data-diff-section-index={section.index}
                          data-diff-section-fingerprint={sectionFingerprint}
                          className={auditRecord
                            ? `mx-2 my-1 min-w-0 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed ${wrap ? 'max-w-full overflow-hidden' : 'w-max'} ${
                              sectionAudit.current
                                ? 'border-primary/20 bg-primary/10 text-foreground'
                                : 'border-[rgb(var(--warning-rgb)_/_0.26)] bg-[rgb(var(--warning-rgb)_/_0.12)] text-muted-foreground'
                            }`
                            : 'mx-2 my-0.5 flex min-w-0 justify-end text-[10px] leading-none'
                          }
                        >
                          {auditRecord ? (
                            <>
                              {(auditRecord.summary || sectionButton || onClearAuditRecord) && (
                            <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
                              {auditRecord.summary ? (
                                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-foreground">{auditRecord.summary}</span>
                              ) : <span className="min-w-0 flex-1" />}
                              {sectionButton}
                            {onClearAuditRecord && (
                              <button
                                type="button"
                                onClick={() => onClearAuditRecord(auditRecord.id)}
                                className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/60 transition hover:bg-surface-2 hover:text-foreground"
                                title={t('diffViewer.auditClear')}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                              </button>
                            )}
                            </div>
                              )}
                              <div className="termdock-diff-audit-explanation min-w-0">{auditRecord.explanation}</div>
                            </>
                          ) : sectionButton}
                        </div>
                      );
                      return widgets;
                    }, {});
                    const generateLineClassName = ({ changes, defaultGenerate }: { changes: HunkData['changes']; defaultGenerate: () => string }) => {
                      const defaultClassName = defaultGenerate();
                      const moved = changes.some((change) => {
                        const lineNumber = getChangeLineNumber(change);
                        if (lineNumber === null) return false;
                        return change?.type === 'delete'
                          ? movedOldLines.has(lineNumber)
                          : change?.type === 'insert' && movedNewLines.has(lineNumber);
                      });
                      return moved ? `${defaultClassName} diff-line-moved` : defaultClassName;
                    };
                    return (
                      <div
                        key={hunk.content}
                        className={`diff-hunk scroll-mt-16 ${importOnlyHunk ? 'diff-hunk-imports' : ''} ${hunkFlatIndex === activeHunkIndex ? 'diff-hunk--jump-target' : ''}`}
                        data-diff-hunk-anchor={displayPath}
                        data-diff-hunk-index={index}
                        data-diff-hunk-fingerprint={hunkFingerprint}
                      >
                        <div className="diff-decoration diff-hunk-meta-row bg-[rgba(var(--diff-accent-rgb),0.035)] px-2 py-1">
                          <div className={`diff-hunk-header flex min-w-0 items-center gap-2 ${wrap ? 'max-w-full flex-wrap overflow-hidden' : 'w-max whitespace-nowrap'}`}>
                              {onInsertDiffReference && (
                                <button
                                  type="button"
                                  onClick={() => onInsertDiffReference(`${pathParts.name} hunk ${index + 1}`, hunkDiffText, hunkReferenceKey)}
                                  {...getReferenceLongPressHandlers(hunkDiffText, hunkReferenceKey)}
                                  className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold active:scale-95 ${hunkReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
                                  title={t('diffViewer.insertHunkDiff')}
                                >
                                  {copiedReferenceKey === hunkReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === hunkReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertHunkShort')}
                                </button>
                              )}
                              {canStageHunk && (
                                <button
                                  type="button"
                                  disabled={hunkActionBusy}
                                  onClick={() => void runHunkGitAction('stage', stageHunkKey, file, fileIndex, index, displayPath)}
                                  className="inline-flex h-6 shrink-0 items-center rounded-full bg-accent/10 px-2 text-[10px] font-semibold text-accent transition hover:bg-accent/20 active:scale-95 disabled:opacity-50"
                                  title={t('diffViewer.stageHunkTitle')}
                                >
                                  {runningHunkActionKey === stageHunkKey ? t('diffViewer.hunkActionApplying') : t('diffViewer.stageHunk')}
                                </button>
                              )}
                              {canRunHunkActions && (
                                <button
                                  type="button"
                                  disabled={hunkActionBusy}
                                  onClick={() => {
                                    if (revertConfirmKey !== revertHunkKey) {
                                      setRevertConfirmKey(revertHunkKey);
                                      return;
                                    }
                                    void runHunkGitAction('revert-worktree', revertHunkKey, file, fileIndex, index, displayPath);
                                  }}
                                  className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 disabled:opacity-50 ${
                                    revertConfirmKey === revertHunkKey
                                      ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                                      : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                                  }`}
                                  title={t('diffViewer.revertHunkTitle')}
                                >
                                  {runningHunkActionKey === revertHunkKey
                                    ? t('diffViewer.hunkActionApplying')
                                    : revertConfirmKey === revertHunkKey
                                      ? t('diffViewer.revertHunkConfirm')
                                      : t('diffViewer.revertHunk')}
                                </button>
                              )}
                              <span className="min-w-0 flex-1 truncate">{hunk.content}</span>
                              {movedCandidates.length > 0 && (
                                <span
                                  className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--diff-hunk-accent)]"
                                  title={movedCandidates.map((candidate) => `-${candidate.oldLineNumber} -> +${candidate.newLineNumber}`).join(', ')}
                                >
                                  moved {movedCandidates.length}
                                </span>
                              )}
                              {importOnlyHunk && (
                                <>
                                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                    imports
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setExpandedImportHunks((current) => {
                                        const next = new Set(current);
                                        if (next.has(importCollapseKey)) next.delete(importCollapseKey);
                                        else next.add(importCollapseKey);
                                        return next;
                                      });
                                    }}
                                    className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition hover:text-foreground"
                                  >
                                    {importCollapsed ? 'show' : 'hide'}
                                  </button>
                                </>
                              )}
                            </div>
                            {thisHunkActionError && (
                              <div className="mt-1 truncate text-[10px] text-destructive" title={thisHunkActionError}>
                                {t('diffViewer.hunkActionFailed', { message: thisHunkActionError })}
                              </div>
                            )}
                            {importCollapsed && (
                              <div className="mt-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-muted-foreground">
                                Import-only changes collapsed.
                              </div>
                            )}
                            {(hunkAudit.current || hunkAudit.stale) && (
                              (() => {
                                const auditRecord = hunkAudit.current ?? hunkAudit.stale;
                                const auditTime = formatAuditTimestamp(auditRecord?.injectedAt, locale);
                                return (
                                  <div className={`mt-1 min-w-0 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed ${wrap ? 'max-w-full overflow-hidden' : 'w-max'} ${
                                    hunkAudit.current
                                      ? 'border-primary/20 bg-primary/10 text-foreground'
                                      : 'border-[rgb(var(--warning-rgb)_/_0.26)] bg-[rgb(var(--warning-rgb)_/_0.12)] text-muted-foreground'
                                  }`}>
                                    <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
                                      <span className="font-semibold text-foreground">{hunkAudit.current ? t('diffViewer.auditExplanation') : t('diffViewer.auditStale')}</span>
                                      <span className="font-mono text-[10px] text-muted-foreground">{hunkAudit.fingerprint}</span>
                                      {auditTime && (
                                        <span className="truncate text-[10px] text-muted-foreground/70">
                                          {t('diffViewer.auditGeneratedAt', { time: auditTime })}
                                        </span>
                                      )}
                                      {onClearAuditRecord && (
                                        <button
                                          type="button"
                                          onClick={() => auditRecord && onClearAuditRecord(auditRecord.id)}
                                          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/60 transition hover:bg-surface-2 hover:text-foreground"
                                          title={t('diffViewer.auditClear')}
                                        >
                                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                        </button>
                                      )}
                                    </div>
                                    <div className="termdock-diff-audit-explanation min-w-0">{hunkAudit.current?.explanation ?? hunkAudit.stale?.explanation}</div>
                                  </div>
                                );
                              })()
                            )}
                        </div>
                        {!importCollapsed && (
                          <Diff
                            viewType={viewType}
                            diffType={file.type}
                            hunks={[displayHunk]}
                            tokens={fileTokens.get(key)}
                            generateLineClassName={generateLineClassName}
                            widgets={sectionWidgets}
                          >
                            {(hunks) => hunks.map((singleHunk) => <Hunk key={singleHunk.content} hunk={singleHunk} />)}
                          </Diff>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
        );
      })}
    </>
    );
  };

  if (effectiveDiffLoading) {
    return embedded ? (
      <div className="absolute inset-0 z-20 flex min-h-16 items-center justify-center gap-2 bg-surface-2 text-xs text-muted-foreground">
        <RiLoader size={18} className="animate-spin" />
        <span>{t('diffViewer.loading')}</span>
      </div>
    ) : (
      <div className="mx-3 mt-3 flex items-center justify-center gap-2 border border-border/15 bg-surface-2 py-8 text-sm text-muted-foreground">
        <RiLoader size={20} className="animate-spin" />
        <span>{t('diffViewer.loading')}</span>
      </div>
    );
  }

  if (effectiveDiffError) {
    return embedded ? (
      <div className="bg-destructive/5 px-3 py-3 text-xs text-destructive">
        {effectiveDiffError}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
        {effectiveDiffError}
      </div>
    );
  }

  if (effectiveDiffNotice && !effectiveDiffContent) {
    return embedded ? (
      <div className="bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-3 text-xs text-[color:var(--warning)]">
        {effectiveDiffNotice}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-[rgb(var(--warning-rgb)_/_0.24)] bg-[rgb(var(--warning-rgb)_/_0.12)] px-4 py-4 text-sm text-[color:var(--warning)]">
        {effectiveDiffNotice}
      </div>
    );
  }

  if (imagePreview) {
    const body = (
      <div className="bg-surface p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t('rightSidebar.imagePreviewHint')}</span>
          {imagePreview.size !== null && <span>{imagePreview.size.toLocaleString()} bytes</span>}
          <span>{imagePreview.mimeType}</span>
          {imagePreview.dimensions && <span>{imagePreview.dimensions.width} × {imagePreview.dimensions.height}</span>}
        </div>
        <div className="flex min-h-64 items-center justify-center">
          <img
            src={imagePreview.objectUrl}
            alt={titleParts.name}
            className="max-h-[70vh] max-w-full rounded border border-border/15 bg-surface object-contain shadow-sm"
            onLoad={(event) => {
              const img = event.currentTarget;
              setImagePreview((current) => current
                ? { ...current, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
                : current);
            }}
            onError={() => setDiffError(t('rightSidebar.imageLoadFailed'))}
          />
        </div>
      </div>
    );

    if (embedded) {
      return <div className="termdock-native-select overflow-hidden bg-surface">{getReferenceLongPressHandlers.popoverNode}{body}</div>;
    }

    return (
      <div className="termdock-diff px-3 py-2">
        {getReferenceLongPressHandlers.popoverNode}
        <div className="border-b border-border/15 px-1 pb-2">
          <div className="truncate text-sm font-medium text-foreground" title={filePath ?? undefined}>{titleParts.name}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            {titleParts.dir && <span className="min-w-0 truncate">{titleParts.dir}</span>}
          </div>
        </div>
        <div className="mt-3 overflow-hidden border border-border/20 bg-surface">{body}</div>
      </div>
    );
  }

  const diffNoticeBanner = effectiveDiffNotice ? (
    <div className="mb-2 border border-[rgb(var(--warning-rgb)_/_0.24)] bg-[rgb(var(--warning-rgb)_/_0.12)] px-3 py-2 text-xs text-[color:var(--warning)]">
      {effectiveDiffNotice}
    </div>
  ) : null;

  if (files.length === 0) {
    return embedded ? (
      <div className="bg-surface-2 px-3 py-5 text-center text-xs text-muted-foreground">
        <RiGitCompare size={20} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    ) : (
      <div className="mx-3 mt-3 border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <RiGitCompare size={24} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? t('diffViewer.noFileChanges') : t('diffViewer.noUnstagedChanges')}
      </div>
    );
  }

  if (embedded) {
    return (
      <div
        ref={containerRef}
        onMouseEnter={() => { diffHoveredRef.current = true; }}
        onMouseLeave={() => { diffHoveredRef.current = false; }}
        className="termdock-diff termdock-native-select termdock-diff-card-mobile overflow-hidden rounded-b-xl"
        data-diff-viewer
        data-diff-view-type={viewType}
        data-diff-inline-mode={inlineMode}
      >
        {getReferenceLongPressHandlers.popoverNode}
        {diffNoticeBanner}
        {renderFileDiffs(true)}
      </div>
    );
  }

  const wholeDiffReferenceActive = insertedReferenceKey === wholeDiffReferenceKey || copiedReferenceKey === wholeDiffReferenceKey;

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => { diffHoveredRef.current = true; }}
      onMouseLeave={() => { diffHoveredRef.current = false; }}
      className="termdock-diff termdock-native-select px-3 py-2"
      data-diff-viewer
      data-diff-view-type={viewType}
      data-diff-inline-mode={inlineMode}
    >
      {getReferenceLongPressHandlers.popoverNode}
      <div className="sticky top-0 z-10 border-b border-border/15 bg-surface/95 px-1 pb-2 pt-0 backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={filePath ?? undefined}>
              {titleParts.name}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              {titleParts.dir && <span className="min-w-0 truncate">{titleParts.dir}</span>}
              <span>{files.length} file{files.length > 1 ? 's' : ''}</span>
              <span className="text-[color:var(--diff-insert-strong)]">+{totalChanges.additions}</span>
              <span className="text-[color:var(--diff-delete-strong)]">-{totalChanges.deletions}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="inline-flex h-7 shrink-0 items-center rounded-full bg-surface-2 p-0.5">
              <button
                type="button"
                onClick={() => jumpToHunk(-1)}
                disabled={totalHunks < 2}
                aria-label={t('diffViewer.prevHunk')}
                className="inline-flex h-6 items-center rounded-full px-1.5 text-muted-foreground transition hover:text-foreground active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
                title={`${t('diffViewer.prevHunk')} (Shift+F7)`}
              >
                <RiChevronUp size={13} />
              </button>
              <button
                type="button"
                onClick={() => jumpToHunk(1)}
                disabled={totalHunks < 2}
                aria-label={t('diffViewer.nextHunk')}
                className="inline-flex h-6 items-center rounded-full px-1.5 text-muted-foreground transition hover:text-foreground active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
                title={`${t('diffViewer.nextHunk')} (F7)`}
              >
                <RiChevronDown size={13} />
              </button>
            </div>
            <select
              value={whitespacePref}
              disabled={diffOptionsLocked}
              onChange={(event) => setWhitespacePref(event.target.value as DiffWhitespacePref)}
              aria-label={t('diffViewer.whitespace')}
              className="h-7 shrink-0 rounded-full border border-border/20 bg-surface-2 px-2 text-[10px] font-semibold text-muted-foreground outline-none transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              title={t('diffViewer.whitespace')}
            >
              <option value="default">{t('diffViewer.whitespaceDefault')}</option>
              <option value="trim">{t('diffViewer.whitespaceTrim')}</option>
              <option value="ignore">{t('diffViewer.whitespaceIgnore')}</option>
              <option value="ignore-blank-lines">{t('diffViewer.whitespaceIgnoreBlankLines')}</option>
            </select>
            <select
              value={String(contextPref)}
              disabled={diffOptionsLocked}
              onChange={(event) => setContextPref(event.target.value === 'all' ? 'all' : Number(event.target.value) as DiffContextPref)}
              aria-label={t('diffViewer.context')}
              className="h-7 shrink-0 rounded-full border border-border/20 bg-surface-2 px-2 text-[10px] font-semibold text-muted-foreground outline-none transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              title={t('diffViewer.context')}
            >
              {([3, 10, 25] as const).map((count) => (
                <option key={count} value={String(count)}>{t('diffViewer.contextLines', { count })}</option>
              ))}
              <option value="all">{t('diffViewer.contextAll')}</option>
            </select>
            <div className="inline-flex h-7 shrink-0 overflow-hidden rounded-full bg-surface-2 p-0.5" aria-label={t('diffViewer.view')}>
              <button
                type="button"
                onClick={() => updateViewType('unified')}
                aria-pressed={viewType === 'unified'}
                className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 ${
                  viewType === 'unified'
                    ? 'bg-surface-elevated text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('diffViewer.unifiedMode')}
              >
                {t('diffViewer.unified')}
              </button>
              <button
                type="button"
                onClick={() => updateViewType('split')}
                disabled={!splitViewAvailable}
                aria-pressed={viewType === 'split'}
                className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 ${
                  viewType === 'split'
                    ? 'bg-surface-elevated text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={splitViewAvailable ? t('diffViewer.splitMode') : t('diffViewer.unifiedMode')}
              >
                {t('diffViewer.split')}
              </button>
            </div>
            {onInsertDiffReference && (
              <button
                type="button"
                onClick={insertWholeDiff}
                {...getReferenceLongPressHandlers(wholeDiffText, wholeDiffReferenceKey)}
                className={`inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[11px] font-semibold transition active:scale-95 ${wholeDiffReferenceActive ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
                title={t('diffViewer.insertAllDiff')}
              >
                {copiedReferenceKey === wholeDiffReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === wholeDiffReferenceKey ? t('rightSidebar.inserted') : t('diffViewer.insertAllShort')}
              </button>
            )}
          </div>
        </div>
      </div>
      {diffNoticeBanner}
      {renderFileDiffs(false)}
    </div>
  );
}
