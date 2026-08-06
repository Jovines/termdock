import { readCache, writeCache } from '../../utils/localStorageCache';

export type HtmlViewMode = 'preview' | 'source';

const HTML_VIEW_MODE_BY_FILE_STORAGE_KEY = 'termdock:right-sidebar:html-view-mode-by-file:v1';

type HtmlViewModeByFileCache = Record<string, HtmlViewMode>;

function isHtmlViewMode(value: unknown): value is HtmlViewMode {
  return value === 'preview' || value === 'source';
}

function isHtmlViewModeByFileCache(value: unknown): value is HtmlViewModeByFileCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isHtmlViewMode);
}

// Per-file HTML view mode: keyed the same way as the file-preview reading-state
// cache (`rootPath::absolutePath`), so each file remembers its own
// preview/source choice across sessions.
export function getHtmlViewModeFileKey(rootPath: string | null, filePath: string | null): string | null {
  if (!filePath) return null;
  const absolutePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  return rootPath ? `${rootPath}::${absolutePath}` : absolutePath;
}

export function readHtmlViewMode(rootPath: string | null, filePath: string | null): HtmlViewMode {
  const key = getHtmlViewModeFileKey(rootPath, filePath);
  if (!key) return 'source';
  return readCache(HTML_VIEW_MODE_BY_FILE_STORAGE_KEY, isHtmlViewModeByFileCache)?.[key] ?? 'source';
}

export function writeHtmlViewMode(rootPath: string | null, filePath: string | null, mode: HtmlViewMode): void {
  const key = getHtmlViewModeFileKey(rootPath, filePath);
  if (!key) return;
  const cache = readCache(HTML_VIEW_MODE_BY_FILE_STORAGE_KEY, isHtmlViewModeByFileCache) ?? {};
  writeCache(HTML_VIEW_MODE_BY_FILE_STORAGE_KEY, { ...cache, [key]: mode });
}
