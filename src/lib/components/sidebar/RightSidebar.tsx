import { useEffect, useCallback, useLayoutEffect, useMemo, useState, useDeferredValue, useRef, type Dispatch, type KeyboardEvent, type MouseEvent, type PointerEvent, type SetStateAction, type UIEvent, type ReactNode } from 'react';
import { useGesture } from '@use-gesture/react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import {
  X as RiCloseLine,
  ArrowLeft as RiArrowLeft,
  ArrowRight as RiArrowRight,
  ArrowUp as RiArrowUp,
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  Home as RiHome,
  GitCompare as RiGitCompare,
  Search as RiSearch,
  FileText as RiFileText,
  Copy as RiCopy,
  RefreshCw as RiRefresh,
  GitBranch as RiGitBranch,
  Loader2 as RiLoader,
  ListTree as RiListTree,
  Pin as RiPin,
  PinOff as RiPinOff,
  Link2 as RiLink,
  Eye as RiEye,
  EyeOff as RiEyeOff,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { FileTree } from './FileTree';
import { DiffViewer, preloadSidebarDiff } from './DiffViewer';
import { useSidebarStore, type RightSidebarTab } from '../../stores/useSidebarStore';
import { getGitBundle, getGitContext, isPreviewableImagePath, readFileContent, readImagePreviewBlob, runGitAction, watchFileSystem, type GitActionRequest, type GitBundleResponse, type GitChangedFile, type GitContext, type GitRepositoryBundle, type FileSearchMode } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { flushCacheThrottled, readCache, writeCache, writeCacheThrottled } from '../../utils/localStorageCache';
import { loadRefractor, resolveLanguage, shouldHighlight, highlightToLines, refractorNodesToReact, type RefractorLike } from '../../utils/syntaxHighlight';
import { useReferenceLongPressCopy } from './referenceLongPress';

interface RightSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  push?: boolean;
  rightSidebarFilePreviewOpen?: boolean;
  rightSidebarFilePreviewCloseSignal?: number;
  onOpenRightSidebarFilePreview?: () => void;
  onCloseRightSidebarFilePreview?: () => void;
  rightSidebarRepoPickerOpen?: boolean;
  rightSidebarRepoPickerCloseSignal?: number;
  onOpenRightSidebarRepoPicker?: () => void;
  onCloseRightSidebarRepoPicker?: () => void;
  markdownOutlineOpen?: boolean;
  markdownOutlineCloseSignal?: number;
  onOpenMarkdownOutline?: () => void;
  onCloseMarkdownOutline?: () => void;
  markdownImageLightboxOpen?: boolean;
  markdownImageLightboxCloseSignal?: number;
  onOpenMarkdownImageLightbox?: () => void;
  onCloseMarkdownImageLightbox?: () => void;
}

const CHANGE_BADGE_STYLES: Record<string, { label: string; className: string; title: string }> = {
  added: { label: 'A', className: 'text-[color:var(--diff-insert-strong)]', title: 'Added' },
  modified: { label: 'M', className: 'text-[color:var(--diff-hunk-accent)]', title: 'Modified' },
  deleted: { label: 'D', className: 'text-[color:var(--diff-delete-strong)]', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-muted-foreground', title: 'Renamed' },
  copied: { label: 'C', className: 'text-[color:var(--diff-insert-strong)]', title: 'Copied' },
  untracked: { label: 'U', className: 'text-[color:var(--diff-insert-strong)]', title: 'Untracked (new file)' },
  conflicted: { label: '!', className: 'text-destructive', title: 'Conflicted' },
  unknown: { label: '?', className: 'text-muted-foreground', title: 'Unknown' },
};

const FILE_TREE_SCROLL_STORAGE_KEY = 'termdock:right-sidebar:file-tree-scroll:v1';
const FILE_PREVIEW_READING_STATE_STORAGE_KEY = 'termdock:right-sidebar:file-preview-reading-state:v1';
const FILE_TREE_WIDTH_STORAGE_KEY = 'termdock:right-sidebar:file-tree-width:v1';
const MARKDOWN_VIEW_MODE_STORAGE_KEY = 'termdock:right-sidebar:markdown-view-mode:v1';
const MAX_FILE_TREE_SCROLL_ROOTS = 20;
const MAX_FILE_PREVIEW_READING_STATE_FILES = 120;
const FILE_TREE_SCROLL_WRITE_MS = 250;
const FILE_PREVIEW_READING_STATE_WRITE_MS = 250;
const FILE_TREE_WIDTH_WRITE_MS = 120;
const GIT_BUNDLE_SLOW_MS = 700;
const SIDEBAR_BACKGROUND_IO_DELAY_MS = 600;
const DEFAULT_FILE_TREE_WIDTH_PX = 300;
const MIN_FILE_TREE_WIDTH_PX = 240;
const MAX_FILE_TREE_WIDTH_PX = 560;
// Below this width we treat the panel as a phone-sized overlay: dual-pane
// mode collapses to a single column with back-navigation, and the third
// "File" tab is hidden (its content is reachable via the Files tab).
const MOBILE_WIDTH_THRESHOLD_PX = 600;
// Wide mode keeps the dual-pane workspace; below this width the panel falls
// back to stacked tabs even on desktop.
const WIDE_WIDTH_THRESHOLD_PX = 720;
const MARKDOWN_TABLE_CELL_CLASS = 'border-r px-2 py-1.5 sm:px-3 sm:py-2';
const MARKDOWN_TABLE_CELL_CONTENT_CLASS = 'max-w-none whitespace-nowrap';
const MARKDOWN_TABLE_HEADER_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-b border-border/15 font-semibold last:border-r-0`;
const MARKDOWN_TABLE_BODY_CELL_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-border/10 align-top text-muted-foreground last:border-r-0`;
const MARKDOWN_TABLE_SCROLL_CLASS = 'termdock-md-table-scroll max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-border/20 bg-surface';

type GitActionKey = GitActionRequest['action'];

type ConfirmGitAction =
  | { kind: 'restore'; file: GitChangedFile; phrase: string }
  | { kind: 'stash-all'; repoRoot?: string | null; repoLabel?: string };

interface GitActionButton {
  key: GitActionKey;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.mkd']);
type MarkdownViewMode = 'preview' | 'source';

function isMarkdownViewMode(value: unknown): value is MarkdownViewMode {
  return value === 'preview' || value === 'source';
}

function readMarkdownViewMode(): MarkdownViewMode {
  return readCache(MARKDOWN_VIEW_MODE_STORAGE_KEY, isMarkdownViewMode) ?? 'preview';
}

function clampFileTreeWidth(width: number, drawerWidthPx: number): number {
  const maxByDrawer = Math.max(MIN_FILE_TREE_WIDTH_PX, drawerWidthPx - 320);
  const max = Math.min(MAX_FILE_TREE_WIDTH_PX, maxByDrawer);
  return Math.min(max, Math.max(MIN_FILE_TREE_WIDTH_PX, width));
}

function isFileTreeWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readFileTreeWidth(drawerWidthPx: number): number {
  return clampFileTreeWidth(readCache(FILE_TREE_WIDTH_STORAGE_KEY, isFileTreeWidth) ?? DEFAULT_FILE_TREE_WIDTH_PX, drawerWidthPx);
}

function getFileExtension(filePath: string): string {
  const basename = filePath.split(/[\\/]/).pop() ?? filePath;
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : '';
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTS.has(getFileExtension(filePath));
}

function isMarkdownHorizontalRule(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, '');
  return /^-{3,}$/.test(compact) || /^\*{3,}$/.test(compact) || /^_{3,}$/.test(compact);
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed)
    || isMarkdownHorizontalRule(line)
    || /^>\s?/.test(trimmed)
    || /^(```|~~~)/.test(trimmed)
    || /^(?:[-+*]|\d+[.)])\s+/.test(trimmed);
}

function getSafeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/[<>]/.test(trimmed)) return trimmed;
  return null;
}

interface MarkdownReferenceDefinition {
  href: string;
  title?: string;
}

type MarkdownReferenceDefinitions = Map<string, MarkdownReferenceDefinition>;

interface MarkdownFootnoteDefinition {
  id: string;
  text: string;
  index: number;
}

type MarkdownFootnoteDefinitions = Map<string, MarkdownFootnoteDefinition>;

interface MarkdownPreviewImage {
  src: string;
  alt: string;
  title?: string;
}

interface MarkdownRenderContext {
  markdownFilePath: string | null;
  rootPath: string | null;
  referenceDefinitions: MarkdownReferenceDefinitions;
  footnoteDefinitions: MarkdownFootnoteDefinitions;
  headingSlugCounts: Map<string, number>;
  images: MarkdownPreviewImage[];
  onImageOpen?: (index: number) => void;
}

interface MarkdownPreviewRenderResult {
  blocks: MarkdownPreviewBlock[];
  images: MarkdownPreviewImage[];
}

interface MarkdownHeadingInfo {
  level: number;
  text: string;
  id: string;
}

function normalizeMarkdownReferenceId(id: string): string {
  return id.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getMarkdownPlainText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeMarkdownAtxHeadingText(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
}

function getMarkdownHeadingId(text: string, context: MarkdownRenderContext): string {
  const plain = getMarkdownPlainText(text);
  const base = plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    || 'section';
  const count = context.headingSlugCounts.get(base) ?? 0;
  context.headingSlugCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function getMarkdownHeadingDisplayText(text: string): string {
  return getMarkdownPlainText(text) || text.trim();
}

function parseMarkdownReferenceDefinition(line: string): { id: string; definition: MarkdownReferenceDefinition } | null {
  const match = line.match(/^\s{0,3}\[([^\]]+)\]:\s+(.+?)\s*$/);
  if (!match) return null;
  const target = parseMarkdownInlineTarget(match[2]);
  if (!target) return null;
  return {
    id: normalizeMarkdownReferenceId(match[1]),
    definition: {
      href: target.href,
      title: target.title,
    },
  };
}

function collectMarkdownReferenceDefinitions(lines: string[]): MarkdownReferenceDefinitions {
  const definitions: MarkdownReferenceDefinitions = new Map();
  for (const line of lines) {
    const parsed = parseMarkdownReferenceDefinition(line);
    if (parsed) definitions.set(parsed.id, parsed.definition);
  }
  return definitions;
}

function normalizeMarkdownFootnoteId(id: string): string {
  return id.trim().toLowerCase();
}

function parseMarkdownFootnoteDefinition(line: string): { id: string; text: string } | null {
  const match = line.match(/^\s{0,3}\[\^([^\]]+)\]:\s+(.+)\s*$/);
  if (!match) return null;
  return { id: normalizeMarkdownFootnoteId(match[1]), text: match[2] };
}

function collectMarkdownFootnoteDefinitions(lines: string[]): MarkdownFootnoteDefinitions {
  const definitions: MarkdownFootnoteDefinitions = new Map();
  let currentId: string | null = null;
  for (const line of lines) {
    const parsed = parseMarkdownFootnoteDefinition(line);
    if (parsed) {
      currentId = parsed.id;
      definitions.set(parsed.id, {
        id: parsed.id,
        text: parsed.text,
        index: definitions.size + 1,
      });
      continue;
    }
    if (currentId && /^\s{4,}\S/.test(line)) {
      const current = definitions.get(currentId);
      if (current) current.text = `${current.text} ${line.trim()}`;
      continue;
    }
    if (line.trim()) currentId = null;
  }
  return definitions;
}

function collectMarkdownFootnoteDefinitionLineIndexes(lines: string[]): Set<number> {
  const indexes = new Set<number>();
  let activeFootnote = false;
  lines.forEach((line, index) => {
    if (parseMarkdownFootnoteDefinition(line)) {
      indexes.add(index);
      activeFootnote = true;
      return;
    }
    if (activeFootnote && /^\s{4,}\S/.test(line)) {
      indexes.add(index);
      return;
    }
    if (line.trim()) activeFootnote = false;
  });
  return indexes;
}

function maskMarkdownHiddenLines(lines: string[]): string[] {
  const masked = [...lines];
  let index = 0;

  const frontMatterDelimiter = lines[0]?.trim();
  if (frontMatterDelimiter === '---' || frontMatterDelimiter === '+++') {
    masked[0] = '';
    index = 1;
    while (index < lines.length && lines[index].trim() !== frontMatterDelimiter) {
      masked[index] = '';
      index += 1;
    }
    if (index < lines.length) {
      masked[index] = '';
      index += 1;
    }
  }

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('<!--')) {
      masked[index] = '';
      if (!trimmed.includes('-->')) {
        index += 1;
        while (index < lines.length && !lines[index].includes('-->')) {
          masked[index] = '';
          index += 1;
        }
        if (index < lines.length) masked[index] = '';
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  return masked;
}

function getParentDirectoryPath(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) return slashIndex === 0 ? '/' : '';
  return normalized.slice(0, slashIndex);
}

function normalizeMarkdownLocalImagePath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const absolute = pathname.startsWith('/');
  const stack: string[] = [];

  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  const normalizedPathname = `${absolute ? '/' : ''}${stack.join('/')}`;
  return normalizedPathname || (absolute ? '/' : '.');
}

function resolveMarkdownImageSrc(src: string, markdownFilePath: string | null, rootPath: string | null): string | null {
  const trimmed = src.trim();
  if (!trimmed || /^(?:javascript|data):/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!isPreviewableImagePath(trimmed.split(/[?#]/, 1)[0])) return null;

  let absolutePath: string;
  if (trimmed.startsWith('/')) {
    const isFileSystemAbsolute = rootPath && (trimmed === rootPath || trimmed.startsWith(`${rootPath}/`));
    absolutePath = normalizeMarkdownLocalImagePath(rootPath && !isFileSystemAbsolute ? `${rootPath}/${trimmed.slice(1)}` : trimmed);
  } else {
    if (!markdownFilePath) return null;
    absolutePath = normalizeMarkdownLocalImagePath(`${getParentDirectoryPath(markdownFilePath)}/${trimmed}`);
  }

  return `/api/terminal/fs/blob?path=${encodeURIComponent(absolutePath)}`;
}

function renderMarkdownImage(
  key: string,
  alt: string,
  src: string,
  title: string | undefined,
  context: MarkdownRenderContext,
): ReactNode {
  const imageSrc = resolveMarkdownImageSrc(src, context.markdownFilePath, context.rootPath);
  if (!imageSrc) return `![${alt}](${src})`;

  const imageIndex = context.images.length;
  context.images.push({ src: imageSrc, alt, title });
  const image = (
      <img
        src={imageSrc}
        alt={alt}
        title={title}
        loading="lazy"
        decoding="async"
        className="block max-h-[480px] max-w-full object-contain"
      />
  );

  return context.onImageOpen ? (
    <button
      key={key}
      type="button"
      className="my-2 block max-w-full overflow-hidden rounded-md border border-border/20 bg-surface-2 text-left transition hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-ring/45"
      title={title || alt || 'Open image'}
      onClick={(event) => {
        event.stopPropagation();
        context.onImageOpen?.(imageIndex);
      }}
    >
      {image}
    </button>
  ) : (
    <span key={key} className="my-2 block max-w-full overflow-hidden rounded-md border border-border/20 bg-surface-2">
      {image}
    </span>
  );
}

function splitAutoLinkPunctuation(token: string): { linkText: string; suffix: string } {
  let linkText = token;
  let suffix = '';
  while (/[.,;:!?)]$/.test(linkText)) {
    suffix = `${linkText.slice(-1)}${suffix}`;
    linkText = linkText.slice(0, -1);
  }
  return { linkText, suffix };
}

function isMarkdownEmail(text: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text);
}

function parseMarkdownInlineTarget(raw: string): { href: string; title?: string } | null {
  const trimmed = raw.trim();
  const angleMatch = trimmed.match(/^<([^>]+)>(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/);
  if (angleMatch) {
    return { href: angleMatch[1], title: angleMatch[2] ?? angleMatch[3] ?? angleMatch[4] };
  }
  const plainMatch = trimmed.match(/^(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/);
  if (!plainMatch) return null;
  return { href: plainMatch[1], title: plainMatch[2] ?? plainMatch[3] ?? plainMatch[4] };
}

const MARKDOWN_ESCAPE_SENTINEL = '\uE000';
const MARKDOWN_ESCAPABLE = /\\([\\`*{}\[\]#+\-.!_|~>$])/g;

function maskMarkdownEscapes(text: string): string {
  return text.replace(MARKDOWN_ESCAPABLE, (_, char: string) => `${MARKDOWN_ESCAPE_SENTINEL}${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function unmaskMarkdownEscapes(text: string): string {
  return text
    .replace(new RegExp(`${MARKDOWN_ESCAPE_SENTINEL}([0-9a-f]{4})`, 'g'), (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\([()])/g, '$1');
}

function normalizeMarkdownCodeSpan(code: string): string {
  const normalized = code.replace(/[\r\n]+/g, ' ');
  if (/^ .+ $/.test(normalized) && /[^ ]/.test(normalized.slice(1, -1))) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

interface DOMPurifyLike {
  sanitize: (dirty: string, config?: Record<string, unknown>) => string;
}

const MARKDOWN_HTML_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details',
    'div', 'em', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's',
    'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'th', 'thead', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'id', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
};

let domPurifyPromise: Promise<DOMPurifyLike> | null = null;

function loadDOMPurify(): Promise<DOMPurifyLike> {
  if (!domPurifyPromise) {
    domPurifyPromise = import('dompurify')
      .then((mod) => ((mod as { default?: DOMPurifyLike }).default ?? mod) as DOMPurifyLike)
      .catch((error) => {
        domPurifyPromise = null;
        throw error;
      });
  }
  return domPurifyPromise;
}

function MarkdownSanitizedHtml({ html }: { html: string }) {
  const [sanitized, setSanitized] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSanitized(null);
    loadDOMPurify()
      .then((domPurify) => {
        if (cancelled) return;
        setSanitized(domPurify.sanitize(html, MARKDOWN_HTML_SANITIZE_CONFIG));
      })
      .catch(() => {
        if (!cancelled) setSanitized('');
      });
    return () => { cancelled = true; };
  }, [html]);

  if (sanitized === null) return <div className="py-2 text-xs text-muted-foreground">Rendering HTML...</div>;
  if (!sanitized) return null;
  return <div className="text-muted-foreground" dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

function MarkdownSanitizedInlineHtml({ html }: { html: string }) {
  const [sanitized, setSanitized] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSanitized(null);
    loadDOMPurify()
      .then((domPurify) => {
        if (!cancelled) setSanitized(domPurify.sanitize(html, MARKDOWN_HTML_SANITIZE_CONFIG));
      })
      .catch(() => {
        if (!cancelled) setSanitized('');
      });
    return () => { cancelled = true; };
  }, [html]);

  if (sanitized === null) return null;
  if (!sanitized) return html;
  return <span dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

function parseMarkdownHtmlBlockStart(line: string): { tag: string; selfContained: boolean } | null {
  const match = line.trim().match(/^<(div|section|article|aside|table|p|ul|ol|li|blockquote|pre|figure|figcaption)\b[^>]*>/i);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  return {
    tag,
    selfContained: new RegExp(`</${tag}>`, 'i').test(line),
  };
}

interface KatexLike {
  renderToString: (tex: string, options?: Record<string, unknown>) => string;
}

let katexPromise: Promise<KatexLike> | null = null;

function loadKatex(): Promise<KatexLike> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ])
      .then(([mod]) => ((mod as { default?: KatexLike }).default ?? mod) as KatexLike)
      .catch((error) => {
        katexPromise = null;
        throw error;
      });
  }
  return katexPromise;
}

function MarkdownMath({ tex, display = false }: { tex: string; display?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
        }));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [display, tex]);

  if (failed) return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground">{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  if (!html) return <span className="text-muted-foreground/70">{display ? 'Rendering formula...' : tex}</span>;

  const className = display
    ? 'my-2 overflow-auto rounded-md bg-surface-2 px-3 py-2 text-center'
    : 'inline-block align-middle';

  // KaTeX returns sanitized HTML for a restricted TeX language. `trust:false`
  // keeps URL / HTML-like extensions inert; unsupported input is rendered as
  // error text instead of throwing.
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderMarkdownHtmlInline(token: string, key: string, context: MarkdownRenderContext): ReactNode | null {
  if (/^<br\s*\/?>$/i.test(token)) return <br key={key} />;

  const match = token.match(/^<(kbd|mark|sub|sup)>(.*?)<\/\1>$/i);
  if (!match) {
    if (/^<(a|abbr|span|b|strong|em|i|u|s|del|code)\b[\s\S]*<\/\1>$/i.test(token)) {
      return <MarkdownSanitizedInlineHtml key={key} html={token} />;
    }
    return null;
  }

  const tag = match[1].toLowerCase();
  const children = renderMarkdownInline(match[2], `${key}-${tag}`, true, context);
  if (tag === 'kbd') {
    return <kbd key={key} className="rounded border border-border/30 bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground shadow-sm">{children}</kbd>;
  }
  if (tag === 'mark') {
    return <mark key={key} className="rounded bg-warning/25 px-0.5 text-foreground">{children}</mark>;
  }
  if (tag === 'sub') return <sub key={key}>{children}</sub>;
  return <sup key={key}>{children}</sup>;
}

function renderMarkdownInline(
  text: string,
  keyPrefix: string,
  wrapLongTokens = true,
  context: MarkdownRenderContext,
): ReactNode[] {
  const maskedText = maskMarkdownEscapes(text);
  const pattern = /(\\\([^)]*\\\)|\$[^$\n]+\$|<br\s*\/?>|<(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)\b[\s\S]*?<\/(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)>|!?\[[^\]]*\]\((?:<[^>]+>|(?:[^\s()]+|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)|!?\[[^\]]+\]\[[^\]]*\]|!?\[[^\]]+\]|\[\^[^\]]+\]|(`+)([\s\S]*?)\2|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|<https?:\/\/[^>\s]+>|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|https?:\/\/[^\s<]+|www\.[^\s<]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)/gi;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(maskedText)) !== null) {
    if (match.index > lastIndex) nodes.push(unmaskMarkdownEscapes(maskedText.slice(lastIndex, match.index)));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    const htmlInline = token.startsWith('<') ? renderMarkdownHtmlInline(token, key, context) : null;
    if (htmlInline) {
      nodes.push(htmlInline);
    } else if (token.startsWith('\\(') && token.endsWith('\\)')) {
      nodes.push(<MarkdownMath key={key} tex={token.slice(2, -2)} />);
    } else if (token.startsWith('$') && token.endsWith('$')) {
      nodes.push(<MarkdownMath key={key} tex={token.slice(1, -1)} />);
    } else if (token.startsWith('`')) {
      const tickLength = token.match(/^`+/)?.[0].length ?? 1;
      nodes.push(<code key={key} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground`}>{normalizeMarkdownCodeSpan(token.slice(tickLength, -tickLength))}</code>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key} className="text-muted-foreground decoration-border-strong">{renderMarkdownInline(token.slice(2, -2), `${key}-del`, wrapLongTokens, context)}</del>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key} className="font-semibold text-foreground">{renderMarkdownInline(token.slice(2, -2), `${key}-strong`, wrapLongTokens, context)}</strong>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key} className="italic">{renderMarkdownInline(token.slice(1, -1), `${key}-em`, wrapLongTokens, context)}</em>);
    } else if (token.startsWith('![')) {
      const inlineImageMatch = token.match(/^!\[([^\]]*)\]\((.*)\)$/);
      const referenceImageMatch = token.match(/^!\[([^\]]+)\]\[([^\]]*)\]$/);
      const shortcutImageMatch = token.match(/^!\[([^\]]+)\]$/);
      if (inlineImageMatch) {
        const target = parseMarkdownInlineTarget(inlineImageMatch[2]);
        nodes.push(target ? renderMarkdownImage(key, inlineImageMatch[1], target.href, target.title, context) : token);
      } else if (referenceImageMatch) {
        const definitionId = referenceImageMatch[2] || referenceImageMatch[1];
        const definition = context.referenceDefinitions.get(normalizeMarkdownReferenceId(definitionId));
        nodes.push(definition ? renderMarkdownImage(key, referenceImageMatch[1], definition.href, definition.title, context) : token);
      } else if (shortcutImageMatch) {
        const definition = context.referenceDefinitions.get(normalizeMarkdownReferenceId(shortcutImageMatch[1]));
        nodes.push(definition ? renderMarkdownImage(key, shortcutImageMatch[1], definition.href, definition.title, context) : token);
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('[^')) {
      const footnoteId = normalizeMarkdownFootnoteId(token.slice(2, -1));
      const footnote = context.footnoteDefinitions.get(footnoteId);
      nodes.push(footnote ? (
        <sup key={key} id={`fnref-${footnote.id}`} title={footnote.text} className="ml-0.5 rounded bg-surface-2 px-1 text-[0.72em] font-semibold text-primary">
          <a href={`#fn-${footnote.id}`} className="text-primary no-underline">{footnote.index}</a>
        </sup>
      ) : token);
    } else if (token.startsWith('<http')) {
      const linkText = token.slice(1, -1);
      nodes.push(
        <a key={key} href={linkText} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
    } else if (token.startsWith('<') && token.endsWith('>') && isMarkdownEmail(token.slice(1, -1))) {
      const email = token.slice(1, -1);
      nodes.push(
        <a key={key} href={`mailto:${email}`} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {email}
        </a>,
      );
    } else if (isMarkdownEmail(splitAutoLinkPunctuation(token).linkText)) {
      const { linkText, suffix } = splitAutoLinkPunctuation(token);
      nodes.push(
        <a key={key} href={`mailto:${linkText}`} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
      if (suffix) nodes.push(suffix);
    } else if (token.startsWith('http') || token.startsWith('www.')) {
      const { linkText, suffix } = splitAutoLinkPunctuation(token);
      const href = linkText.startsWith('www.') ? `https://${linkText}` : linkText;
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
      if (suffix) nodes.push(suffix);
    } else {
      const inlineLinkMatch = token.match(/^\[([^\]]+)\]\((.*)\)$/);
      const referenceLinkMatch = token.match(/^\[([^\]]+)\]\[([^\]]*)\]$/);
      const shortcutLinkMatch = token.match(/^\[([^\]]+)\]$/);
      const definitionId = referenceLinkMatch ? referenceLinkMatch[2] || referenceLinkMatch[1] : shortcutLinkMatch?.[1] ?? null;
      const definition = definitionId ? context.referenceDefinitions.get(normalizeMarkdownReferenceId(definitionId)) : null;
      const inlineTarget = inlineLinkMatch ? parseMarkdownInlineTarget(inlineLinkMatch[2]) : null;
      const href = inlineTarget?.href ?? definition?.href ?? null;
      const safeHref = href ? getSafeMarkdownHref(href) : null;
      const label = inlineLinkMatch?.[1] ?? referenceLinkMatch?.[1] ?? shortcutLinkMatch?.[1] ?? '';
      nodes.push(safeHref ? (
        <a key={key} href={safeHref} title={inlineTarget?.title ?? definition?.title} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {renderMarkdownInline(label, `${key}-link`, wrapLongTokens, context)}
        </a>
      ) : token);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < maskedText.length) nodes.push(unmaskMarkdownEscapes(maskedText.slice(lastIndex)));
  return nodes.length > 0 ? nodes : [text];
}

function hasMarkdownHardBreak(line: string): boolean {
  return /(?: {2,}|\\)$/.test(line);
}

function stripMarkdownHardBreak(line: string): string {
  return line.replace(/(?: {2,}|\\)$/, '');
}

function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

function stripIndentedCodeLine(line: string): string {
  return line.startsWith('\t') ? line.slice(1) : line.replace(/^ {4}/, '');
}

function renderMarkdownInlineLines(lines: string[], keyPrefix: string, context: MarkdownRenderContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    const hardBreak = hasMarkdownHardBreak(line);
    nodes.push(...renderMarkdownInline(stripMarkdownHardBreak(line), `${keyPrefix}-${index}`, true, context));
    if (index < lines.length - 1) nodes.push(hardBreak ? <br key={`${keyPrefix}-${index}-br`} /> : ' ');
  });
  return nodes;
}

function splitMarkdownTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaping = false;
  let codeFenceLength = 0;
  let bracketDepth = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '`') {
      const start = index;
      while (index + 1 < normalized.length && normalized[index + 1] === '`') index += 1;
      const tickLength = index - start + 1;
      current += '`'.repeat(tickLength);
      if (codeFenceLength === 0) codeFenceLength = tickLength;
      else if (codeFenceLength === tickLength) codeFenceLength = 0;
      continue;
    }
    if (codeFenceLength === 0 && char === '[') {
      bracketDepth += 1;
    } else if (codeFenceLength === 0 && char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    }
    if (char === '|' && codeFenceLength === 0 && bracketDepth === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  cells.push(current.trim());
  return cells;
}

type MarkdownTableAlign = 'left' | 'center' | 'right' | null;

function parseMarkdownTableAlignments(line: string): MarkdownTableAlign[] {
  return splitMarkdownTableRow(line).map((cell) => {
    if (/^:-+:$/.test(cell)) return 'center';
    if (/^-+:$/.test(cell)) return 'right';
    if (/^:-+$/.test(cell)) return 'left';
    return null;
  });
}

function getMarkdownTableAlignClass(align: MarkdownTableAlign): string {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-right';
  return 'text-left';
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());
}

export function shouldCloseMarkdownImageLightboxDrag(verticalMovement: number, verticalVelocity: number): boolean {
  return verticalMovement > 96 || (verticalMovement > 44 && verticalVelocity > 0.35);
}

interface MarkdownListItem {
  content: string;
  ordered: boolean;
  start?: number;
  children: MarkdownListItem[];
  paragraphs: string[];
}

function getMarkdownListIndent(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

function parseMarkdownListItemLine(line: string): { ordered: boolean; start?: number; content: string } | null {
  const match = line.trim().match(/^([-+*]|\d+[.)])\s+(.+)$/);
  if (!match) return null;
  const ordered = /^\d+[.)]$/.test(match[1]);
  return { ordered, start: ordered ? Number.parseInt(match[1], 10) : undefined, content: match[2] };
}

function parseMarkdownListBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number,
  ordered: boolean,
  skipDefinitionLines: boolean,
  footnoteDefinitionLines: Set<number> = new Set(),
): { items: MarkdownListItem[]; nextIndex: number } {
  const items: MarkdownListItem[] = [];
  const stack: Array<{ indent: number; item: MarkdownListItem }> = [];
  let index = startIndex;

  while (index < lines.length) {
    const currentLine = lines[index];
    if (skipDefinitionLines && (parseMarkdownReferenceDefinition(currentLine) || footnoteDefinitionLines.has(index))) {
      index += 1;
      continue;
    }

    const itemMatch = parseMarkdownListItemLine(currentLine);
    const indent = getMarkdownListIndent(currentLine);

    if (!itemMatch) {
      if (indent > baseIndent && stack.length > 0) {
        const target = [...stack].reverse().find((entry) => entry.indent < indent)?.item ?? stack[stack.length - 1].item;
        target.paragraphs.push(currentLine.trim());
        index += 1;
        continue;
      }
      break;
    }

    if (indent < baseIndent) break;
    if (indent === baseIndent && itemMatch.ordered !== ordered) break;

    const item: MarkdownListItem = { content: itemMatch.content, ordered: itemMatch.ordered, start: itemMatch.start, children: [], paragraphs: [] };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.item ?? null;
    if (parent) parent.children.push(item);
    else items.push(item);
    stack.push({ indent, item });
    index += 1;
  }

  return { items, nextIndex: index };
}

export function __testParseMarkdownListBlock(lines: string[]): MarkdownListItem[] {
  const first = lines.find((line) => parseMarkdownListItemLine(line));
  if (!first) return [];
  const parsed = parseMarkdownListItemLine(first);
  if (!parsed) return [];
  return parseMarkdownListBlock(lines, 0, getMarkdownListIndent(first), parsed.ordered, true, collectMarkdownFootnoteDefinitionLineIndexes(lines)).items;
}

function renderMarkdownListItems(
  items: MarkdownListItem[],
  blockStart: number,
  context: MarkdownRenderContext,
): ReactNode[] {
  return items.map((item, itemIndex) => {
    const taskMatch = item.content.match(/^\[([ xX])\]\s+(.+)$/);
    return (
      <li key={`item-${itemIndex}`} className={taskMatch ? 'list-none' : undefined}>
        {taskMatch ? <input type="checkbox" checked={taskMatch[1].toLowerCase() === 'x'} readOnly className="mr-2 align-[-2px] accent-primary" /> : null}
        {renderMarkdownInline(taskMatch?.[2] ?? item.content, `li-${blockStart}-${itemIndex}`, true, context)}
        {item.paragraphs.length > 0 && (
          <div className="mt-1 space-y-1 text-muted-foreground">
            {item.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={`paragraph-${paragraphIndex}`}>
                {renderMarkdownInline(paragraph, `li-${blockStart}-${itemIndex}-p-${paragraphIndex}`, true, context)}
              </p>
            ))}
          </div>
        )}
        {item.children.length > 0 && renderMarkdownNestedLists(item.children, blockStart + itemIndex + 1, context)}
      </li>
    );
  });
}

function renderMarkdownNestedLists(items: MarkdownListItem[], blockStart: number, context: MarkdownRenderContext): ReactNode[] {
  const groups: Array<{ ordered: boolean; items: MarkdownListItem[] }> = [];
  for (const item of items) {
    const current = groups[groups.length - 1];
    if (current && current.ordered === item.ordered) current.items.push(item);
    else groups.push({ ordered: item.ordered, items: [item] });
  }

  return groups.map((group, groupIndex) => {
    const ListTag = group.ordered ? 'ol' : 'ul';
    return (
      <ListTag key={`nested-${groupIndex}`} start={group.ordered ? group.items[0]?.start : undefined} className={`${group.ordered ? 'list-decimal' : 'list-disc'} mt-1 space-y-0.5 pl-4 marker:text-muted-foreground/60`}>
        {renderMarkdownListItems(group.items, blockStart + groupIndex + 1, context)}
      </ListTag>
    );
  });
}

function renderMarkdownFootnotes(context: MarkdownRenderContext): ReactNode | null {
  const footnotes = Array.from(context.footnoteDefinitions.values()).sort((a, b) => a.index - b.index);
  if (footnotes.length === 0) return null;

  return (
    <section className="mt-3 border-t border-border/20 pt-2 text-[12px] leading-5 text-muted-foreground">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">Footnotes</div>
      <ol className="list-decimal space-y-1 pl-5">
        {footnotes.map((footnote) => (
          <li key={footnote.id} id={`fn-${footnote.id}`}>
            {renderMarkdownInline(footnote.text, `footnote-${footnote.id}`, true, context)}
            {' '}
            <a href={`#fnref-${footnote.id}`} className="text-primary no-underline" aria-label={`Back to footnote ${footnote.index}`}>↩</a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function renderMarkdownQuoteBlocks(lines: string[], keyPrefix: string, context: MarkdownRenderContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^<details>\s*$/i.test(trimmed)) {
      const blockStart = index;
      let summary = 'Details';
      const bodyLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^<\/details>\s*$/i.test(lines[index].trim())) {
        const summaryMatch = lines[index].trim().match(/^<summary>(.*?)<\/summary>\s*$/i);
        if (summaryMatch) summary = summaryMatch[1].trim() || summary;
        else bodyLines.push(lines[index].trimStart());
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <details key={`${keyPrefix}-details-${blockStart}`} className="overflow-hidden rounded-lg border border-border/20 bg-surface px-3 py-2 text-muted-foreground">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">{renderMarkdownInline(summary, `${keyPrefix}-details-${blockStart}-summary`, true, context)}</summary>
          {bodyLines.length > 0 && (
            <div className="mt-2 text-sm leading-6">{renderMarkdownInlineLines(bodyLines, `${keyPrefix}-details-${blockStart}`, context)}</div>
          )}
        </details>,
      );
      continue;
    }

    const htmlBlockStart = parseMarkdownHtmlBlockStart(line);
    if (htmlBlockStart) {
      const htmlLines = [line];
      const blockStart = index;
      index += 1;
      while (
        index < lines.length
        && !htmlBlockStart.selfContained
        && !new RegExp(`</${htmlBlockStart.tag}>`, 'i').test(lines[index])
      ) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && !htmlBlockStart.selfContained) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      nodes.push(<MarkdownSanitizedHtml key={`${keyPrefix}-html-${blockStart}`} html={htmlLines.join('\n')} />);
      continue;
    }

    const fenceMatch = trimmed.match(/^(```|~~~)\s*(.*)$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      const fence = fenceMatch[1];
      const lang = fenceMatch[2]?.trim();
      const blockStart = index;
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        lang.toLowerCase() === 'mermaid'
          ? <MarkdownMermaidBlock key={`${keyPrefix}-code-${blockStart}`} code={codeLines.join('\n')} blockKey={`${keyPrefix}-code-${blockStart}`} />
          : ['math', 'latex', 'tex'].includes(lang.toLowerCase())
          ? <MarkdownMath key={`${keyPrefix}-code-${blockStart}`} tex={codeLines.join('\n')} display />
          : <MarkdownCodeBlock key={`${keyPrefix}-code-${blockStart}`} code={codeLines.join('\n')} lang={lang} blockKey={`${keyPrefix}-code-${blockStart}`} />,
      );
      continue;
    }

    if (isIndentedCodeLine(line)) {
      const codeLines: string[] = [];
      const blockStart = index;
      while (index < lines.length && (isIndentedCodeLine(lines[index]) || !lines[index].trim())) {
        codeLines.push(lines[index].trim() ? stripIndentedCodeLine(lines[index]) : '');
        index += 1;
      }
      nodes.push(<MarkdownCodeBlock key={`${keyPrefix}-indented-code-${blockStart}`} code={codeLines.join('\n').replace(/\n+$/, '')} lang="" blockKey={`${keyPrefix}-indented-code-${blockStart}`} />);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingText = normalizeMarkdownAtxHeadingText(headingMatch[2]);
      const headingId = getMarkdownHeadingId(headingText, context);
      nodes.push(
        <Tag key={`${keyPrefix}-heading-${index}`} id={headingId} className="scroll-mt-16 font-semibold text-foreground">
          {renderMarkdownInline(headingText, `${keyPrefix}-heading-${index}`, true, context)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      const blockStart = index;
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      nodes.push(
        <div key={`${keyPrefix}-table-${blockStart}`} className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll>
            <table className="w-max min-w-full max-w-none table-auto border-collapse text-left text-[11px] sm:text-xs">
              <thead className="bg-surface-2 text-foreground">
              <tr>{header.map((cell, cellIndex) => <th key={`h-${cellIndex}`} className={`${MARKDOWN_TABLE_HEADER_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(cell, `${keyPrefix}-th-${blockStart}-${cellIndex}`, true, context)}</div></th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`} className="border-t border-border/10">
                  {header.map((_, cellIndex) => <td key={`c-${cellIndex}`} className={`${MARKDOWN_TABLE_BODY_CELL_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(row[cellIndex] ?? '', `${keyPrefix}-td-${blockStart}-${rowIndex}-${cellIndex}`, true, context)}</div></td>)}
                  </tr>
                ))}
              </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const listMatch = parseMarkdownListItemLine(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const baseIndent = getMarkdownListIndent(line);
      const start = listMatch.start;
      const blockStart = index;
      const parsed = parseMarkdownListBlock(lines, index, baseIndent, ordered, false);
      index = parsed.nextIndex;
      const ListTag = ordered ? 'ol' : 'ul';
      nodes.push(
        <ListTag key={`${keyPrefix}-list-${blockStart}`} start={ordered ? start : undefined} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 marker:text-muted-foreground/70`}>
          {renderMarkdownListItems(parsed.items, blockStart, context)}
        </ListTag>,
      );
      continue;
    }

    const paragraphLines = [line.trimStart()];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      paragraphLines.push(lines[index].trimStart());
      index += 1;
    }
    nodes.push(<p key={`${keyPrefix}-p-${blockStart}`}>{renderMarkdownInlineLines(paragraphLines, `${keyPrefix}-p-${blockStart}`, context)}</p>);
  }

  return nodes;
}

interface MarkdownPreviewBlock {
  key: string;
  startLine: number;
  endLine: number;
  content: ReactNode;
  heading?: MarkdownHeadingInfo;
  interactive?: boolean;
}

interface MarkdownCodeBlockProps {
  code: string;
  lang: string;
  blockKey: string;
}

interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidLike> | null = null;
let mermaidInitialized = false;

function loadMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => ((mod as { default?: MermaidLike }).default ?? mod) as MermaidLike)
      .catch((error) => {
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

function initializeMermaid(mermaid: MermaidLike): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
  });
  mermaidInitialized = true;
}

function normalizeMarkdownFenceLanguage(lang: string): string | null {
  const firstToken = lang.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!firstToken) return null;
  const normalized = firstToken.replace(/^language-/, '');
  return resolveLanguage(`code.${normalized}`) ?? normalized;
}

function MarkdownMermaidBlock({ code, blockKey }: { code: string; blockKey: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setObjectUrl(null);
    setFailed(false);

    loadMermaid()
      .then(async (mermaid) => {
        initializeMermaid(mermaid);
        const id = `termdock-md-mermaid-${blockKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [blockKey, code]);

  if (failed) {
    return <MarkdownCodeBlock code={code} lang="mermaid" blockKey={`${blockKey}-fallback`} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">mermaid</div>
      <div className="overflow-auto bg-surface p-3">
        {objectUrl ? (
          <img src={objectUrl} alt="Mermaid diagram" className="max-w-full rounded bg-white p-2" />
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">Rendering diagram...</div>
        )}
      </div>
    </div>
  );
}

function MarkdownCodeBlock({ code, lang, blockKey }: MarkdownCodeBlockProps) {
  const language = normalizeMarkdownFenceLanguage(lang);
  const [highlighted, setHighlighted] = useState<ReactNode[] | null>(null);

  useEffect(() => {
    if (!language || !shouldHighlight(code)) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    loadRefractor()
      .then((refractor) => {
        if (cancelled || !refractor.registered(language)) {
          if (!cancelled) setHighlighted(null);
          return;
        }
        try {
          setHighlighted(refractorNodesToReact(refractor.highlight(code, language), `md-code-${blockKey}`));
        } catch {
          if (!cancelled) setHighlighted(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });
    return () => { cancelled = true; };
  }, [blockKey, code, language]);

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      {lang && <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{lang}</div>}
      <pre className="termdock-code overflow-auto p-3 text-[11px] leading-relaxed text-foreground"><code>{highlighted ?? (code || ' ')}</code></pre>
    </div>
  );
}

export function buildMarkdownPreviewRenderResult(
  lines: string[],
  markdownFilePath: string | null,
  rootPath: string | null,
  onImageOpen?: (index: number) => void,
): MarkdownPreviewRenderResult {
  lines = maskMarkdownHiddenLines(lines);
  const referenceDefinitions = collectMarkdownReferenceDefinitions(lines);
  const footnoteDefinitionLines = collectMarkdownFootnoteDefinitionLineIndexes(lines);
  const images: MarkdownPreviewImage[] = [];
  const context: MarkdownRenderContext = {
    markdownFilePath,
    rootPath,
    referenceDefinitions,
    footnoteDefinitions: collectMarkdownFootnoteDefinitions(lines),
    headingSlugCounts: new Map(),
    images,
    onImageOpen,
  };
  const blocks: MarkdownPreviewBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (parseMarkdownReferenceDefinition(line) || footnoteDefinitionLines.has(index)) {
      index += 1;
      continue;
    }

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^<details>\s*$/i.test(trimmed)) {
      const blockStart = index;
      let summary = 'Details';
      const bodyLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^<\/details>\s*$/i.test(lines[index].trim())) {
        const summaryMatch = lines[index].trim().match(/^<summary>(.*?)<\/summary>\s*$/i);
        if (summaryMatch) summary = summaryMatch[1].trim() || summary;
        else bodyLines.push(lines[index].trimStart());
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        key: `details-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: (
          <details className="overflow-hidden rounded-lg border border-border/20 bg-surface px-3 py-2 text-muted-foreground">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">{renderMarkdownInline(summary, `details-${blockStart}-summary`, true, context)}</summary>
            {bodyLines.length > 0 && (
              <div className="mt-2 text-sm leading-6">{renderMarkdownInlineLines(bodyLines, `details-${blockStart}`, context)}</div>
            )}
          </details>
        ),
      });
      continue;
    }

    const htmlBlockStart = parseMarkdownHtmlBlockStart(line);
    if (htmlBlockStart) {
      const htmlLines = [line];
      const blockStart = index;
      index += 1;
      while (
        index < lines.length
        && !htmlBlockStart.selfContained
        && !new RegExp(`</${htmlBlockStart.tag}>`, 'i').test(lines[index])
      ) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && !htmlBlockStart.selfContained) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      blocks.push({
        key: `html-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <MarkdownSanitizedHtml html={htmlLines.join('\n')} />,
      });
      continue;
    }

    const fenceMatch = trimmed.match(/^(```|~~~)\s*(.*)$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      const fence = fenceMatch[1];
      const lang = fenceMatch[2]?.trim();
      const blockStart = index;
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        key: `code-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: lang.toLowerCase() === 'mermaid'
          ? <MarkdownMermaidBlock code={codeLines.join('\n')} blockKey={`code-${blockStart}`} />
          : ['math', 'latex', 'tex'].includes(lang.toLowerCase())
          ? <MarkdownMath tex={codeLines.join('\n')} display />
          : <MarkdownCodeBlock code={codeLines.join('\n')} lang={lang} blockKey={`code-${blockStart}`} />,
      });
      continue;
    }

    if (isIndentedCodeLine(line)) {
      const codeLines: string[] = [];
      const blockStart = index;
      index += 0;
      while (index < lines.length && (isIndentedCodeLine(lines[index]) || !lines[index].trim())) {
        codeLines.push(lines[index].trim() ? stripIndentedCodeLine(lines[index]) : '');
        index += 1;
      }
      blocks.push({
        key: `indented-code-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <MarkdownCodeBlock code={codeLines.join('\n').replace(/\n+$/, '')} lang="" blockKey={`indented-code-${blockStart}`} />,
      });
      continue;
    }

    if (trimmed.startsWith('$$')) {
      const mathLines: string[] = [];
      const blockStart = index;
      const firstLine = trimmed.replace(/^\$\$\s*/, '');
      if (firstLine.endsWith('$$') && firstLine.length > 2) {
        mathLines.push(firstLine.replace(/\s*\$\$$/, ''));
        index += 1;
      } else {
        if (firstLine) mathLines.push(firstLine);
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith('$$')) {
          mathLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          const closingLine = lines[index].trim().replace(/\s*\$\$$/, '');
          if (closingLine) mathLines.push(closingLine);
          index += 1;
        }
      }
      blocks.push({
        key: `math-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <MarkdownMath tex={mathLines.join('\n')} display />,
      });
      continue;
    }

    if (
      index + 1 < lines.length
      && trimmed
      && !isMarkdownBlockStart(line)
      && /^(=+|-+)\s*$/.test(lines[index + 1].trim())
    ) {
      const level = lines[index + 1].trim().startsWith('=') ? 1 : 2;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingId = getMarkdownHeadingId(trimmed, context);
      const heading: MarkdownHeadingInfo = { level, text: getMarkdownHeadingDisplayText(trimmed), id: headingId };
      blocks.push({
        key: `setext-heading-${index}`,
        startLine: index + 1,
        endLine: index + 2,
        heading,
        content: (
          <Tag id={headingId} className={`scroll-mt-16 font-semibold text-foreground ${level === 1 ? 'mt-1 border-b border-border/20 pb-1.5 text-lg sm:pb-2 sm:text-xl' : 'mt-1 border-b border-border/15 pb-1 text-base sm:pb-1.5 sm:text-lg'}`}>
            {renderMarkdownInline(trimmed, `setext-heading-${index}`, true, context)}
          </Tag>
        ),
      });
      index += 2;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = normalizeMarkdownAtxHeadingText(headingMatch[2]);
      const headingClasses: Record<number, string> = {
        1: 'mt-1 border-b border-border/20 pb-1.5 text-lg sm:pb-2 sm:text-xl',
        2: 'mt-1 border-b border-border/15 pb-1 text-base sm:pb-1.5 sm:text-lg',
        3: 'text-sm sm:text-base',
        4: 'text-[13px] sm:text-sm',
        5: 'text-[11px] uppercase tracking-wide sm:text-xs',
        6: 'text-[11px] uppercase tracking-wide text-muted-foreground',
      };
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingId = getMarkdownHeadingId(headingText, context);
      const heading: MarkdownHeadingInfo = { level, text: getMarkdownHeadingDisplayText(headingText), id: headingId };
      blocks.push({
        key: `heading-${index}`,
        startLine: index + 1,
        endLine: index + 1,
        heading,
        content: <Tag id={headingId} className={`scroll-mt-16 font-semibold text-foreground ${headingClasses[level]}`}>{renderMarkdownInline(headingText, `heading-${index}`, true, context)}</Tag>,
      });
      index += 1;
      continue;
    }

    if (isMarkdownHorizontalRule(line)) {
      blocks.push({
        key: `hr-${index}`,
        startLine: index + 1,
        endLine: index + 1,
        content: <hr className="border-border/20" />,
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      const blockStart = index;
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      const calloutMatch = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (calloutMatch) {
        const label = calloutMatch[1].toUpperCase();
        const firstLine = calloutMatch[2]?.trim();
        const bodyLines = [
          ...(firstLine ? [firstLine] : []),
          ...quoteLines.slice(1),
        ];
        blocks.push({
          key: `callout-${blockStart}`,
          startLine: blockStart + 1,
          endLine: index,
          content: (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-muted-foreground">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">{label}</div>
              {bodyLines.length > 0 && <div>{renderMarkdownInlineLines(bodyLines, `callout-${blockStart}`, context)}</div>}
            </aside>
          ),
        });
        continue;
      }
      blocks.push({
        key: `quote-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: (
          <blockquote className="space-y-2 border-l-2 border-border-strong bg-surface-2/70 py-1.5 pl-2.5 pr-2 text-muted-foreground sm:py-2 sm:pl-3">
            {renderMarkdownQuoteBlocks(quoteLines, `quote-${blockStart}`, context)}
          </blockquote>
        ),
      });
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      const blockStart = index;
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      blocks.push({
        key: `table-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        interactive: false,
        content: (
          <div className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll>
            <table className="w-max min-w-full max-w-none table-auto border-collapse text-left text-[11px] sm:text-xs">
              <thead className="bg-surface-2 text-foreground">
                <tr>{header.map((cell, cellIndex) => <th key={`h-${cellIndex}`} className={`${MARKDOWN_TABLE_HEADER_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(cell, `th-${blockStart}-${cellIndex}`, true, context)}</div></th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`} className="border-t border-border/10">
                    {header.map((_, cellIndex) => <td key={`c-${cellIndex}`} className={`${MARKDOWN_TABLE_BODY_CELL_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(row[cellIndex] ?? '', `td-${blockStart}-${rowIndex}-${cellIndex}`, true, context)}</div></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
      continue;
    }

    const listMatch = parseMarkdownListItemLine(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const baseIndent = getMarkdownListIndent(line);
      const start = listMatch.start;
      const blockStart = index;
      const parsed = parseMarkdownListBlock(lines, index, baseIndent, ordered, true, footnoteDefinitionLines);
      index = parsed.nextIndex;
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push({
        key: `list-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: (
          <ListTag start={ordered ? start : undefined} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 text-muted-foreground marker:text-muted-foreground/70 sm:space-y-1 sm:pl-5`}>
            {renderMarkdownListItems(parsed.items, blockStart, context)}
          </ListTag>
        ),
      });
      continue;
    }

    const paragraphLines: string[] = [line.trimStart()];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      if (parseMarkdownReferenceDefinition(lines[index]) || footnoteDefinitionLines.has(index)) {
        index += 1;
        continue;
      }
      paragraphLines.push(lines[index].trimStart());
      index += 1;
    }
    blocks.push({
      key: `p-${blockStart}`,
      startLine: blockStart + 1,
      endLine: index,
      content: <p className="text-muted-foreground">{renderMarkdownInlineLines(paragraphLines, `p-${blockStart}`, context)}</p>,
    });
  }

  const footnotes = renderMarkdownFootnotes(context);
  if (footnotes) {
    blocks.push({
      key: 'footnotes',
      startLine: lines.length,
      endLine: lines.length,
      content: footnotes,
    });
  }

  return { blocks, images };
}

export function buildMarkdownPreviewBlocks(lines: string[], markdownFilePath: string | null, rootPath: string | null): MarkdownPreviewBlock[] {
  return buildMarkdownPreviewRenderResult(lines, markdownFilePath, rootPath).blocks;
}

interface MarkdownHeadingPathItem extends MarkdownHeadingInfo {
  startLine: number;
}

export function getMarkdownHeadingPathAtLine(blocks: MarkdownPreviewBlock[], line: number): MarkdownHeadingPathItem[] {
  const stack: MarkdownHeadingPathItem[] = [];
  for (const block of blocks) {
    if (block.startLine > line) break;
    if (!block.heading) continue;
    while (stack.length > 0 && stack[stack.length - 1].level >= block.heading.level) stack.pop();
    stack.push({ ...block.heading, startLine: block.startLine });
  }
  return stack;
}

export function getMarkdownHeadingOutline(blocks: MarkdownPreviewBlock[]): MarkdownHeadingPathItem[] {
  return blocks
    .filter((block): block is MarkdownPreviewBlock & { heading: MarkdownHeadingInfo } => Boolean(block.heading))
    .map((block) => ({ ...block.heading, startLine: block.startLine }));
}

interface MarkdownPreviewProps {
  content: string;
  filePath: string | null;
  rootPath: string | null;
  lineRange: { start: number; end: number } | null;
  onLineRangeClick: (event: MouseEvent<HTMLElement>, startLine: number, endLine: number) => void;
  scrollTop: number;
  outlineOpen: boolean;
  outlineCloseSignal?: number;
  onOutlineOpen?: () => void;
  onOutlineClose?: () => void;
  lightboxOpen: boolean;
  lightboxCloseSignal?: number;
  onLightboxOpen?: () => void;
  onLightboxClose?: () => void;
}

interface MarkdownImageLightboxProps {
  images: MarkdownPreviewImage[];
  index: number;
  onChange: (index: number) => void;
  onClose: () => void;
}

export function MarkdownImageLightbox({ images, index, onChange, onClose }: MarkdownImageLightboxProps) {
  const active = images[index];
  const canNavigate = images.length > 1;
  const swiperRef = useRef<SwiperInstance | null>(null);
  const lightboxDragRef = useRef<HTMLDivElement | null>(null);
  const closeTapTimerRef = useRef<number | null>(null);
  const suppressTapCloseUntilRef = useRef(0);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const clearTapCloseTimer = useCallback(() => {
    if (closeTapTimerRef.current === null) return;
    window.clearTimeout(closeTapTimerRef.current);
    closeTapTimerRef.current = null;
  }, []);

  const scheduleTapClose = useCallback(() => {
    if (imageZoomed || Date.now() < suppressTapCloseUntilRef.current) return;
    clearTapCloseTimer();
    closeTapTimerRef.current = window.setTimeout(() => {
      closeTapTimerRef.current = null;
      onClose();
    }, 300);
  }, [clearTapCloseTimer, imageZoomed, onClose]);

  const goTo = useCallback((nextIndex: number) => {
    if (images.length === 0) return;
    const normalizedIndex = (nextIndex + images.length) % images.length;
    swiperRef.current?.slideTo(normalizedIndex);
    onChange(normalizedIndex);
  }, [images.length, onChange]);

  const goPrevious = useCallback(() => goTo(index - 1), [goTo, index]);
  const goNext = useCallback(() => goTo(index + 1), [goTo, index]);

  useEffect(() => {
    clearTapCloseTimer();
    setDragOffsetY(0);
    setDragging(false);
    setImageZoomed(false);
  }, [clearTapCloseTimer, index]);

  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    swiper.allowTouchMove = canNavigate && !imageZoomed;
  }, [canNavigate, imageZoomed]);

  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper || swiper.activeIndex === index) return;
    swiper.slideTo(index, 0);
  }, [index]);

  useEffect(() => clearTapCloseTimer, [clearTapCloseTimer]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!canNavigate) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrevious();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [canNavigate, goNext, goPrevious, onClose]);

  useGesture(
    {
      onDrag: ({ movement: [mx, my], pinching }) => {
        if (pinching || imageZoomed) return;
        if (Math.abs(my) < Math.abs(mx) * 1.15 && dragOffsetY === 0) return;
        setDragging(true);
        if (Math.abs(my) > 8) suppressTapCloseUntilRef.current = Date.now() + 300;
        setDragOffsetY(Math.max(0, my));
      },
      onDragEnd: ({ movement: [, my], velocity: [, vy] }) => {
        if (imageZoomed) return;
        setDragging(false);
        if (Math.abs(my) > 8) suppressTapCloseUntilRef.current = Date.now() + 300;
        if (shouldCloseMarkdownImageLightboxDrag(my, vy)) {
          onClose();
          return;
        }
        setDragOffsetY(0);
      },
    },
    {
      target: lightboxDragRef,
      drag: {
        filterTaps: true,
        pointer: { touch: true },
      },
    },
  );

  if (!active) return null;

  return (
    <>
      <div className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-modal-panel flex flex-col bg-background-subtle/95 text-foreground" data-sidebar-gesture-ignore>
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/20 bg-surface/80 px-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{active.title || active.alt || 'Image'}</div>
            <div className="text-[10px] text-muted-foreground">{index + 1} / {images.length}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canNavigate && (
              <>
                <button
                  type="button"
                  onClick={goPrevious}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label="Previous image"
                  title="Previous"
                >
                  <RiArrowLeft size={17} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label="Next image"
                  title="Next"
                >
                  <RiArrowRight size={17} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
              aria-label="Close image preview"
              title="Close"
            >
              <RiCloseLine size={18} />
            </button>
          </div>
        </div>
        <div
          ref={lightboxDragRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          data-markdown-image-lightbox-stage
          onClick={scheduleTapClose}
        >
          <div
            className="h-full w-full"
            style={{
              transform: `translate3d(0, ${dragOffsetY}px, 0) scale(${Math.max(0.86, 1 - dragOffsetY / 900)})`,
              opacity: Math.max(0.35, 1 - dragOffsetY / 360),
              transition: dragging ? 'none' : 'transform 0.2s ease-out, opacity 0.2s ease-out',
              willChange: 'transform, opacity',
            }}
          >
            <Swiper
              onSwiper={(instance) => {
                swiperRef.current = instance;
                instance.allowTouchMove = canNavigate && !imageZoomed;
              }}
              onSlideChange={(instance) => {
                if (instance.activeIndex !== index) onChange(instance.activeIndex);
              }}
              initialSlide={index}
              speed={260}
              slidesPerView={1}
              resistanceRatio={0.82}
              threshold={6}
              longSwipesRatio={0.2}
              touchAngle={45}
              touchStartPreventDefault={false}
              simulateTouch={false}
              className="h-full"
            >
              {images.map((image) => (
                <SwiperSlide key={`${image.src}-${image.alt}`} className="h-full">
                  <div className="h-full w-full px-3 py-4 sm:px-6 sm:py-6">
                    <ZoomableImage
                      src={image.src}
                      alt={image.alt || image.title || 'Markdown image'}
                      onLoad={() => undefined}
                      onError={() => undefined}
                      onZoomChange={setImageZoomed}
                      onDoubleTap={clearTapCloseTimer}
                    />
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
          </div>
        </div>
      </div>
    </>
  );
}

function MarkdownPreview({
  content,
  filePath,
  rootPath,
  lineRange,
  onLineRangeClick,
  scrollTop,
  outlineOpen,
  outlineCloseSignal,
  onOutlineOpen,
  onOutlineClose,
  lightboxOpen,
  lightboxCloseSignal,
  onLightboxOpen,
  onLightboxClose,
}: MarkdownPreviewProps) {
  const { t } = useI18n();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [activeHeadingLine, setActiveHeadingLine] = useState<number>(1);
  const [outlineDesktopPos, setOutlineDesktopPos] = useState<{ top: number; right: number } | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const outlineToggleRef = useRef<HTMLButtonElement | null>(null);
  const { blocks, images } = useMemo(
    () => buildMarkdownPreviewRenderResult(content.split('\n'), filePath, rootPath, (index) => {
      setLightboxIndex(index);
      onLightboxOpen?.();
    }),
    [content, filePath, rootPath, onLightboxOpen],
  );

  useEffect(() => {
    setLightboxIndex(null);
  }, [content, filePath]);

  useEffect(() => {
    setLightboxIndex(null);
  }, [lightboxCloseSignal]);

  useEffect(() => {
    if (!lightboxOpen) setLightboxIndex(null);
  }, [lightboxOpen]);

  useEffect(() => {
    setActiveHeadingLine(1);
  }, [content, filePath]);

  useLayoutEffect(() => {
    const root = previewRootRef.current;
    if (!root || blocks.length === 0) return;
    const blockNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-preview-block-start]'));
    let nextLine = 1;
    const threshold = 28;
    for (const node of blockNodes) {
      if (node.offsetTop - scrollTop <= threshold) {
        nextLine = Number(node.dataset.markdownPreviewBlockStart) || nextLine;
      } else {
        break;
      }
    }
    setActiveHeadingLine((current) => current === nextLine ? current : nextLine);
  }, [blocks, scrollTop]);

  const activeHeadingPath = useMemo(() => getMarkdownHeadingPathAtLine(blocks, activeHeadingLine), [activeHeadingLine, blocks]);
  const headingOutline = useMemo(() => getMarkdownHeadingOutline(blocks), [blocks]);
  const outlineResetKey = `${filePath ?? ''}\n${content}`;
  const lastOutlineResetKeyRef = useRef(outlineResetKey);
  const tableTapRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    if (lastOutlineResetKeyRef.current === outlineResetKey) return;
    lastOutlineResetKeyRef.current = outlineResetKey;
    onOutlineClose?.();
  }, [onOutlineClose, outlineResetKey]);

  useEffect(() => {
    if (outlineCloseSignal !== undefined) setOutlineDesktopPos(null);
  }, [outlineCloseSignal]);

  useLayoutEffect(() => {
    if (!outlineOpen) {
      setOutlineDesktopPos(null);
      return;
    }
    const computePosition = () => {
      const button = outlineToggleRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      setOutlineDesktopPos({
        top: rect.bottom + 6,
        right: Math.max(8, viewportWidth - rect.right),
      });
    };
    computePosition();
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [outlineOpen, scrollTop, activeHeadingPath]);


  const jumpToHeading = useCallback((heading: MarkdownHeadingPathItem) => {
    const root = previewRootRef.current;
    const scroller = root?.closest('[data-markdown-preview-scroller]') as HTMLDivElement | null;
    const target = root?.querySelector<HTMLElement>(`[data-markdown-preview-block-start="${heading.startLine}"]`);
    if (!scroller || !target) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const stickyHeader = root?.querySelector<HTMLElement>('[data-markdown-heading-sticky]');
    const stickyHeaderHeight = stickyHeader?.getBoundingClientRect().height ?? 0;
    const targetTop = targetRect.top - scrollerRect.top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, targetTop - stickyHeaderHeight - 8), behavior: 'smooth' });
    setActiveHeadingLine(heading.startLine);
    onOutlineClose?.();
  }, [onOutlineClose]);

  const handleTablePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    tableTapRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }, []);

  const handleTablePointerUp = useCallback((
    event: React.PointerEvent<HTMLElement>,
    startLine: number,
    endLine: number,
  ) => {
    const start = tableTapRef.current;
    tableTapRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - start.startX);
    const dy = Math.abs(event.clientY - start.startY);
    if (dx > 8 || dy > 8) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('a, button, input, textarea, select, label')) return;
    onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, startLine, endLine);
  }, [onLineRangeClick]);

  const handleTablePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (tableTapRef.current?.pointerId === event.pointerId) tableTapRef.current = null;
  }, []);

  if (blocks.length === 0) {
    return <div className="min-w-0 max-w-full px-4 py-4 text-sm leading-6 text-foreground"><p className="text-muted-foreground">Empty file.</p></div>;
  }

  return (
    <>
      <div ref={previewRootRef} className="relative min-w-0 max-w-full">
        {activeHeadingPath.length > 0 && (
          <div className="sticky top-0 z-popover border-b border-border/15 bg-surface px-2 py-1 shadow-sm sm:px-3" data-markdown-heading-sticky>
            <div className="flex min-w-0 items-center gap-2 overflow-hidden" title={activeHeadingPath.map((heading) => heading.text).join(' / ')}>
              <span className="h-4 w-0.5 shrink-0 rounded-full bg-primary/70" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-5 text-foreground sm:text-[13px]" data-markdown-heading-current>
                {activeHeadingPath[activeHeadingPath.length - 1].text}
              </span>
              {headingOutline.length > 1 && (
                <button
                  ref={outlineToggleRef}
                  type="button"
                  onClick={() => {
                    if (outlineOpen) onOutlineClose?.();
                    else onOutlineOpen?.();
                  }}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition active:scale-95 ${outlineOpen ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                  aria-expanded={outlineOpen}
                  aria-label={t('rightSidebar.markdownOutline')}
                  title={t('rightSidebar.markdownOutline')}
                >
                  <RiListTree size={12} />
                  <span>{t('rightSidebar.markdownOutlineShort')}</span>
                </button>
              )}
            </div>
          </div>
        )}
        {outlineOpen && (
          <>
            <div className="fixed inset-0 z-drawer-backdrop bg-[rgb(var(--background-rgb)_/_0.18)] sm:hidden" onClick={onOutlineClose} />
            <div
              className="hidden fixed z-popover w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border/20 bg-surface p-2 shadow-xl sm:block"
              style={outlineDesktopPos ? { top: `${outlineDesktopPos.top}px`, right: `${outlineDesktopPos.right}px` } : { top: -9999, right: -9999 }}
              data-markdown-heading-outline-desktop
            >
              <div className="max-h-72 overflow-auto pr-1">
                {headingOutline.map((heading) => {
                  const active = activeHeadingPath[activeHeadingPath.length - 1]?.startLine === heading.startLine;
                  return (
                    <button
                      key={`desktop-${heading.id}-${heading.startLine}`}
                      type="button"
                      onClick={() => jumpToHeading(heading)}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition active:scale-[0.995] ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                      style={{ paddingLeft: `${Math.min(heading.level - 1, 4) * 12 + 8}px` }}
                      title={heading.text}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-primary' : 'bg-border-strong/70'}`} aria-hidden="true" />
                      <span className="w-5 shrink-0 font-mono text-[9px] text-muted-foreground/70">H{heading.level}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{heading.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className="fixed inset-x-0 bottom-0 z-drawer-panel max-h-[min(74vh,34rem)] rounded-t-xl border border-border/20 bg-surface p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] shadow-[0_-18px_48px_var(--app-shadow-strong)] sm:hidden"
              data-markdown-heading-outline-mobile
            >
              <div className="mb-1 flex items-center justify-between gap-2 px-1.5 py-1 sm:hidden">
                <div className="text-[12px] font-semibold text-foreground">{t('rightSidebar.markdownOutlineShort')}</div>
                <button
                  type="button"
                  onClick={onOutlineClose}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                  aria-label={t('rightSidebar.closeMarkdownOutline')}
                  title={t('common.close')}
                >
                  <RiCloseLine size={14} />
                </button>
              </div>
              <div className="max-h-[calc(min(74vh,34rem)-3.25rem-env(safe-area-inset-bottom,0px))] overflow-auto overscroll-contain pr-1 sm:max-h-72">
                {headingOutline.map((heading) => {
                  const active = activeHeadingPath[activeHeadingPath.length - 1]?.startLine === heading.startLine;
                  return (
                    <button
                      key={`${heading.id}-${heading.startLine}`}
                      type="button"
                      onClick={() => jumpToHeading(heading)}
                      className={`flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition active:scale-[0.995] ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                      style={{ paddingLeft: `${Math.min(heading.level - 1, 4) * 12 + 8}px` }}
                      title={heading.text}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-primary' : 'bg-border-strong/70'}`} aria-hidden="true" />
                      <span className="w-5 shrink-0 font-mono text-[9px] text-muted-foreground/70">H{heading.level}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{heading.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <div className="min-w-0 max-w-full space-y-1.5 overflow-x-hidden break-words px-1.5 py-3 text-[13px] leading-5 text-foreground sm:space-y-2 sm:px-2 sm:py-4 sm:text-sm sm:leading-6">
        {blocks.map((block) => {
          const selected = Boolean(lineRange && block.startLine <= lineRange.end && block.endLine >= lineRange.start);
          const lineLabel = block.startLine === block.endLine ? String(block.startLine) : `${block.startLine}-${block.endLine}`;
          const blockContent = (
            <>
              <span
                className={`flex min-h-5 w-full select-none items-stretch justify-center rounded transition sm:min-h-6 ${selected ? 'bg-[var(--surface-elevated)]' : 'bg-[var(--surface-2)] group-hover:bg-[var(--surface-elevated)]'}`}
                aria-hidden="true"
              >
                <span className={`my-1 w-0.5 rounded-full transition sm:w-1 ${selected ? 'bg-[var(--muted-foreground)]' : 'bg-[var(--border-strong)] group-hover:bg-[var(--muted-foreground)]'}`} />
              </span>
              <div className="min-w-0">{block.content}</div>
            </>
          );
          if (block.interactive === false) {
            return (
              <div
                key={block.key}
                data-markdown-preview-block-start={block.startLine}
                className={`group grid w-full grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${selected ? 'bg-[var(--surface-2)]' : ''}`}
                title={`Line ${lineLabel}`}
                aria-label={`Line ${lineLabel}`}
              >
                <span
                  className={`flex min-h-5 w-full select-none items-stretch justify-center rounded transition sm:min-h-6 ${selected ? 'bg-[var(--surface-elevated)]' : 'bg-[var(--surface-2)]'}`}
                  aria-hidden="true"
                >
                  <span className={`my-1 w-0.5 rounded-full transition sm:w-1 ${selected ? 'bg-[var(--muted-foreground)]' : 'bg-[var(--border-strong)]'}`} />
                </span>
                <div
                  className="min-w-0 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onPointerDown={handleTablePointerDown}
                  onPointerUp={(event) => handleTablePointerUp(event, block.startLine, block.endLine)}
                  onPointerCancel={handleTablePointerCancel}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
                  }}
                  title={`Reference line ${lineLabel}`}
                  aria-label={`Reference line ${lineLabel}`}
                >
                  {block.content}
                </div>
              </div>
            );
          }
          return (
            <div
              role="button"
              tabIndex={0}
              key={block.key}
              data-markdown-preview-block-start={block.startLine}
              onClick={(event) => {
                const target = event.target;
                if (target instanceof HTMLElement && target.closest('a, button, input, textarea, select, label')) return;
                onLineRangeClick(event, block.startLine, block.endLine);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
              }}
              className={`group grid w-full cursor-pointer grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition active:scale-[0.998] sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${selected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'}`}
              title={`Reference line ${lineLabel}`}
              aria-label={`Reference line ${lineLabel}`}
            >
              {blockContent}
            </div>
          );
        })}
        </div>
      </div>
      {lightboxOpen && lightboxIndex !== null && images[lightboxIndex] && (
        <MarkdownImageLightbox
          images={images}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => {
            setLightboxIndex(null);
            onLightboxClose?.();
          }}
        />
      )}
    </>
  );
}

interface GitPickerOption {
  value: string;
  label: string;
  meta?: string;
}

interface GitTargetPickerProps {
  label: string;
  value: string;
  options: GitPickerOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

interface FileTreeScrollEntry {
  top: number;
  updatedAt: number;
}

interface FilePreviewReadingStateEntry {
  top: number;
  left?: number;
  markdownTop?: number;
  lineRange?: { start: number; end: number } | null;
  updatedAt: number;
}

function GitTargetPicker({ label, value, options, placeholder, searchPlaceholder, emptyText, disabled, onChange }: GitTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((option) => `${option.label} ${option.meta ?? ''}`.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);

  const current = options.find((option) => option.value === value);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((currentOpen) => !currentOpen);
          setQuery('');
        }}
        className="group flex w-full items-center justify-between gap-2 rounded-md border border-border/15 bg-surface-2 px-2.5 py-1.5 text-left transition hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className="block text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className={`block truncate text-[12px] ${value ? 'text-foreground' : 'text-muted-foreground/70'}`}>
            {current?.label ?? (value || placeholder)}
          </span>
        </span>
        <RiChevronDown size={13} className={`shrink-0 text-muted-foreground transition group-hover:text-foreground ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 overflow-hidden rounded-lg border border-border/15 bg-surface shadow-lg">
          <div className="border-b border-border/10 p-1.5">
            <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5">
              <RiSearch size={12} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto p-1">
            {filteredOptions.length > 0 ? filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery('');
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition hover:bg-surface-2 ${option.value === value ? 'bg-accent/10 text-accent' : 'text-foreground'}`}
              >
                <span className="min-w-0 truncate font-medium">{option.label}</span>
                {option.meta && <span className="shrink-0 text-[10px] text-muted-foreground">{option.meta}</span>}
              </button>
            )) : (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">{emptyText}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type FileTreeScrollCache = Record<string, FileTreeScrollEntry>;

function isFileTreeScrollCache(value: unknown): value is FileTreeScrollCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybeEntry = entry as Partial<FileTreeScrollEntry>;
    if (typeof maybeEntry.top !== 'number' || !Number.isFinite(maybeEntry.top)) return false;
    if (typeof maybeEntry.updatedAt !== 'number' || !Number.isFinite(maybeEntry.updatedAt)) return false;
  }
  return true;
}

function readFileTreeScrollCache(): FileTreeScrollCache {
  return readCache(FILE_TREE_SCROLL_STORAGE_KEY, isFileTreeScrollCache) ?? {};
}

function writeFileTreeScrollPosition(rootPath: string, top: number): void {
  const cache = readFileTreeScrollCache();
  const nextEntries = Object.entries({
    ...cache,
    [rootPath]: { top, updatedAt: Date.now() },
  })
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FILE_TREE_SCROLL_ROOTS);
  writeCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY, Object.fromEntries(nextEntries), FILE_TREE_SCROLL_WRITE_MS);
}

type FilePreviewReadingStateCache = Record<string, FilePreviewReadingStateEntry>;

function isLineRange(value: unknown): value is { start: number; end: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const maybeRange = value as { start?: unknown; end?: unknown };
  return (
    typeof maybeRange.start === 'number' &&
    Number.isFinite(maybeRange.start) &&
    typeof maybeRange.end === 'number' &&
    Number.isFinite(maybeRange.end) &&
    maybeRange.start >= 1 &&
    maybeRange.end >= maybeRange.start
  );
}

function isFilePreviewReadingStateCache(value: unknown): value is FilePreviewReadingStateCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybeEntry = entry as Partial<FilePreviewReadingStateEntry>;
    if (typeof maybeEntry.top !== 'number' || !Number.isFinite(maybeEntry.top)) return false;
    if (maybeEntry.left !== undefined && (typeof maybeEntry.left !== 'number' || !Number.isFinite(maybeEntry.left))) return false;
    if (maybeEntry.markdownTop !== undefined && (typeof maybeEntry.markdownTop !== 'number' || !Number.isFinite(maybeEntry.markdownTop))) return false;
    if (maybeEntry.lineRange !== undefined && maybeEntry.lineRange !== null && !isLineRange(maybeEntry.lineRange)) return false;
    if (typeof maybeEntry.updatedAt !== 'number' || !Number.isFinite(maybeEntry.updatedAt)) return false;
  }
  return true;
}

function getFilePreviewReadingStateKey(rootPath: string | null, filePath: string | null): string | null {
  if (!filePath) return null;
  const absolutePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  return rootPath ? `${rootPath}::${absolutePath}` : absolutePath;
}

function readFilePreviewReadingStateCache(): FilePreviewReadingStateCache {
  return readCache(FILE_PREVIEW_READING_STATE_STORAGE_KEY, isFilePreviewReadingStateCache) ?? {};
}

function readFilePreviewReadingState(rootPath: string | null, filePath: string | null): FilePreviewReadingStateEntry | null {
  const key = getFilePreviewReadingStateKey(rootPath, filePath);
  return key ? (readFilePreviewReadingStateCache()[key] ?? null) : null;
}

function writeFilePreviewReadingState(rootPath: string | null, filePath: string | null, patch: Partial<FilePreviewReadingStateEntry>): void {
  const key = getFilePreviewReadingStateKey(rootPath, filePath);
  if (!key) return;
  const cache = readFilePreviewReadingStateCache();
  const current = cache[key] ?? { top: 0, left: 0, markdownTop: 0, lineRange: null, updatedAt: Date.now() };
  const nextEntries = Object.entries({
    ...cache,
    [key]: { ...current, ...patch, updatedAt: Date.now() },
  })
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FILE_PREVIEW_READING_STATE_FILES);
  writeCacheThrottled(FILE_PREVIEW_READING_STATE_STORAGE_KEY, Object.fromEntries(nextEntries), FILE_PREVIEW_READING_STATE_WRITE_MS);
}

function Pane({ active, mounted = true, children }: { active: boolean; mounted?: boolean; children: ReactNode }) {
  return (
    <div className={`h-full min-h-0 overflow-hidden bg-surface text-foreground ${active ? 'block' : 'hidden'}`} aria-hidden={!active}>
      {mounted ? children : null}
    </div>
  );
}

function GitChangesLoadingState({ slow }: { slow: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <RiLoader size={20} className="mx-auto mb-2 animate-spin text-muted-foreground/80" />
      <div>{t('rightSidebar.loadingGitChanges')}</div>
      {slow && <div className="mt-1 text-xs text-muted-foreground/75">{t('rightSidebar.loadingGitChangesSlow')}</div>}
    </div>
  );
}

function GitChangesErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-5 text-center text-sm text-destructive">
      <div className="font-medium">{t('rightSidebar.gitChangesLoadFailed')}</div>
      <div className="mt-1 break-words text-xs opacity-85">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/15 active:scale-95"
      >
        {t('rightSidebar.retryGitChanges')}
      </button>
    </div>
  );
}

function getRelativeDisplayPath(path: string, rootPath: string | null): { name: string; dir: string } {
  const relative = rootPath && path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : path;
  const parts = relative.split('/').filter(Boolean);
  return {
    name: parts.pop() || relative,
    dir: parts.join('/'),
  };
}

function getPathBasename(path: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized || '/';
}

function getParentPath(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\/+$/, '') || '/';
  if (normalized === '/') return null;
  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  return parent === normalized ? null : parent;
}

function ChangeBadge({ status }: { status: string }) {
  const style = CHANGE_BADGE_STYLES[status] ?? { label: '?', className: 'text-muted-foreground', title: status };
  return (
    <span className={`w-4 shrink-0 text-center text-[10px] font-mono font-bold ${style.className}`} title={style.title}>
      {style.label}
    </span>
  );
}

function buildFileReference(path: string, rootPath: string | null): string {
  if (!rootPath || !path.startsWith(`${rootPath}/`)) {
    if (!path.startsWith('/') && !path.startsWith('./')) {
      return `./${path}`;
    }
    return path;
  }
  return `./${path.slice(rootPath.length + 1)}`;
}

function buildReferenceInputText(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}" ` : `${reference} `;
}

function buildPromptReference(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}"` : reference;
}

function buildLineReference(path: string, rootPath: string | null, lineRange: { start: number; end: number } | null): string {
  if (!lineRange) return buildPromptReference(path, rootPath);
  const suffix = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
  return `${buildPromptReference(path, rootPath)}:${suffix}`;
}

function toChangedFileMap(files: GitChangedFile[]): Map<string, GitChangedFile> {
  const map = new Map<string, GitChangedFile>();
  for (const file of files) {
    map.set(getChangedFileKey(file), file);
  }
  return map;
}

function getChangedFileRepoRoot(file: GitChangedFile, fallbackRoot: string | null): string | null {
  return file.repoRoot ?? fallbackRoot;
}

function getChangedFileKey(file: GitChangedFile): string {
  return `${file.repoRoot ?? ''}\u0000${file.path}`;
}

function getChangedFileSelectionPath(file: GitChangedFile): string {
  return file.absolutePath || file.path;
}

function getChangedFileBusyPath(file: GitChangedFile): string {
  return getChangedFileKey(file);
}

function getChangedFileRepoLabel(file: GitChangedFile): string {
  return file.repoRelativeRoot && file.repoRelativeRoot !== '.' ? file.repoRelativeRoot : (file.repoName ?? '');
}

function countStagedChanges(files: GitChangedFile[]): number {
  return files.reduce((count, file) => count + (file.staged ? 1 : 0), 0);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function GitActionChips({ actions, running, completed }: {
  actions: GitActionButton[];
  running: { action: GitActionKey; path?: string } | null;
  completed: { action: GitActionKey; path?: string } | null;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {actions.map((action) => {
        const isRunning = running?.action === action.key;
        const isCompleted = completed?.action === action.key;
        return (
          <button
            key={action.key}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              action.onClick();
            }}
            disabled={action.disabled || Boolean(running)}
            className={`relative inline-flex h-6 items-center justify-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 disabled:opacity-50 ${
              isCompleted
                ? 'bg-accent/10 text-accent'
                : action.destructive
                ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
          >
            <span className={isRunning || isCompleted ? 'opacity-0' : ''}>{action.label}</span>
            {isRunning && <RiLoader size={11} className="absolute animate-spin" />}
            {isCompleted && !isRunning && <span className="absolute">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

const IMAGE_MIN_SCALE = 1;
const IMAGE_MAX_SCALE = 8;

function clampImageScale(scale: number): number {
  return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, scale));
}

interface ZoomableImageProps {
  src: string;
  alt: string;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onError: () => void;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}

// Pinch-to-zoom image viewer. Supports touch pinch (mobile), trackpad pinch and
// ctrl/⌘ + wheel (desktop), and double-tap / double-click to toggle zoom. The
// container carries `data-sidebar-gesture-ignore` so the drawer's swipe-to-close
// gesture never hijacks a pan while the image is zoomed in.
function ZoomableImage({ src, alt, onLoad, onError, onZoomChange, onDoubleTap }: ZoomableImageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [animateTransform, setAnimateTransform] = useState(false);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Reset when the image source changes (a new file was selected).
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [src]);

  // Clamp the pan offset so the (scaled) image can't be dragged completely out
  // of the viewport. Bounds grow with the scale factor.
  const clampOffset = useCallback((scale: number, x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return { x, y };
    const maxX = (el.clientWidth * (scale - 1)) / 2;
    const maxY = (el.clientHeight * (scale - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, []);

  const applyZoom = useCallback((nextScale: number, originX?: number, originY?: number) => {
    setTransform((prev) => {
      const scale = clampImageScale(nextScale);
      const el = containerRef.current;
      if (!el || scale === 1) {
        return { scale, x: 0, y: 0 };
      }
      // Zoom toward the pointer/pinch focal point so the pixel under the cursor
      // stays put. Falls back to the center when no origin is provided.
      const rect = el.getBoundingClientRect();
      const focalX = (originX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const focalY = (originY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = scale / prev.scale;
      const x = focalX - (focalX - prev.x) * ratio;
      const y = focalY - (focalY - prev.y) * ratio;
      return { scale, ...clampOffset(scale, x, y) };
    });
  }, [clampOffset]);

  const toggleZoom = useCallback((originX?: number, originY?: number) => {
    setAnimateTransform(true);
    if (transformRef.current.scale > 1) {
      setTransform({ scale: 1, x: 0, y: 0 });
    } else {
      applyZoom(2.5, originX, originY);
    }
    window.setTimeout(() => setAnimateTransform(false), 220);
  }, [applyZoom]);

  useGesture(
    {
      onPinch: ({ offset: [scale], origin: [ox, oy] }) => {
        setAnimateTransform(false);
        applyZoom(scale, ox, oy);
      },
      onDrag: ({ offset: [x, y], pinching, cancel }) => {
        if (pinching) {
          cancel();
          return;
        }
        if (transformRef.current.scale <= 1) return;
        setAnimateTransform(false);
        setTransform((prev) => ({ ...prev, ...clampOffset(prev.scale, x, y) }));
      },
      onWheel: ({ event, delta: [, dy], ctrlKey }) => {
        // Trackpad pinch surfaces as a wheel event with ctrlKey on most
        // browsers; plain scroll is left to the container so users can still
        // scroll the page when the image isn't zoomed.
        if (!ctrlKey) return;
        event.preventDefault();
        setAnimateTransform(false);
        applyZoom(transformRef.current.scale * (1 - dy * 0.01), event.clientX, event.clientY);
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
      drag: {
        from: () => [transformRef.current.x, transformRef.current.y],
        filterTaps: true,
        pointer: { touch: true },
      },
      pinch: {
        scaleBounds: { min: IMAGE_MIN_SCALE, max: IMAGE_MAX_SCALE },
        from: () => [transformRef.current.scale, 0],
        rubberband: true,
      },
    },
  );

  const zoomed = transform.scale > 1;

  useEffect(() => {
    onZoomChange?.(zoomed);
  }, [onZoomChange, zoomed]);

  return (
    <div
      ref={containerRef}
      data-sidebar-gesture-ignore
      className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
      style={{ cursor: zoomed ? 'grab' : 'zoom-in' }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleTap?.();
        toggleZoom(event.clientX, event.clientY);
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full touch-none select-none rounded border border-border/15 bg-surface object-contain shadow-sm"
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center center',
          transition: animateTransform ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
          willChange: 'transform',
        }}
        onLoad={onLoad}
        onError={onError}
      />
    </div>
  );
}

interface FilePreviewProps {
  filePath: string | null;
  onInsertReference: (path: string, key?: string) => void;
  onInsertText: (text: string, key: string) => void;
  onReferenceCopied: (key: string) => void;
  onClose?: () => void;
  isMobile: boolean;
  markdownOutlineOpen: boolean;
  markdownOutlineCloseSignal?: number;
  onOpenMarkdownOutline?: () => void;
  onCloseMarkdownOutline?: () => void;
  markdownImageLightboxOpen: boolean;
  markdownImageLightboxCloseSignal?: number;
  onOpenMarkdownImageLightbox?: () => void;
  onCloseMarkdownImageLightbox?: () => void;
  lineRange: { start: number; end: number } | null;
  onLineRangeChange: Dispatch<SetStateAction<{ start: number; end: number } | null>>;
  insertedReferenceKey: string | null;
  copiedReferenceKey: string | null;
  scrollToLine?: number | null;
  onScrollToLineHandled?: () => void;
}

type FilePreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; mode: 'text' | 'image' }
  | { kind: 'text'; content: string; meta: { size: number; truncated?: boolean } }
  | { kind: 'image'; objectUrl: string; meta: { size: number | null; mimeType: string; modified: string | null }; dimensions?: { width: number; height: number } }
  | { kind: 'error'; message: string };

function FilePreview({
  filePath,
  onInsertReference,
  onInsertText,
  onReferenceCopied,
  onClose,
  isMobile,
  markdownOutlineOpen,
  markdownOutlineCloseSignal,
  onOpenMarkdownOutline,
  onCloseMarkdownOutline,
  markdownImageLightboxOpen,
  markdownImageLightboxCloseSignal,
  onOpenMarkdownImageLightbox,
  onCloseMarkdownImageLightbox,
  lineRange,
  onLineRangeChange,
  insertedReferenceKey,
  copiedReferenceKey,
  scrollToLine,
  onScrollToLineHandled,
}: FilePreviewProps) {
  const { t } = useI18n();
  const rootPath = useSidebarStore((s) => s.rootPath);
  const [previewState, setPreviewState] = useState<FilePreviewState>({ kind: 'idle' });
  const lineRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Floating "引用" button position relative to the scroller. Mouse clicks set
  // this near the cursor; non-pointer jumps fall back to the selected line.
  const [floatingInsertPos, setFloatingInsertPos] = useState<{ top: number; left: number } | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>(() => readMarkdownViewMode());
  const [refractor, setRefractor] = useState<RefractorLike | null>(null);
  const [markdownPreviewScrollTop, setMarkdownPreviewScrollTop] = useState(0);
  // Per-line highlighted React nodes, keyed implicitly by the current text
  // content. `null` means "render plain text" (unknown language, too large, or
  // refractor not loaded yet).
  const [highlightedLines, setHighlightedLines] = useState<ReactNode[][] | null>(null);
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);

  const readingStateKey = getFilePreviewReadingStateKey(rootPath, filePath);

  // 把仓库相对路径解析成绝对路径，用作 watcher / version map 的查询 key。
  const versionedPath = filePath
    ? (rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath)
    : null;

  // watcher 在 store 里维护「每个绝对路径的变更版本号」。当前预览路径对应的
  // 版本号变化时（外部 created/updated/deleted/rescan）自动触发重新加载。
  // 文件管理器是纯查看场景，没有"覆盖用户编辑"的冲突顾虑，所以直接静默刷新。
  const externalVersion = useSidebarStore((s) => (
    versionedPath ? s.fileChangeVersions.get(versionedPath) ?? 0 : 0
  ));

  // 用于区分"切到新文件"和"同一个文件外部变更"。前者要重置 UI（loading 占位、
  // 清行选区、重置 markdown 视图模式），后者保留滚动位置与用户选择。
  const lastFullPathRef = useRef<string | null>(null);
  const restoredReadingStateKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      lastFullPathRef.current = null;
      setPreviewState({ kind: 'idle' });
      return;
    }

    const fullPath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const isImage = isPreviewableImagePath(fullPath);
    const isMarkdown = isMarkdownPath(fullPath);
    const isPathChange = lastFullPathRef.current !== fullPath;
    lastFullPathRef.current = fullPath;

    if (isPathChange) {
      setPreviewState({ kind: 'loading', mode: isImage ? 'image' : 'text' });
      restoredReadingStateKeyRef.current = null;
      const savedReadingState = readFilePreviewReadingState(rootPath, filePath);
      onLineRangeChange(savedReadingState?.lineRange ?? null);
      setMarkdownViewMode(isMarkdown ? readMarkdownViewMode() : 'source');
    }

    if (isImage) {
      readImagePreviewBlob(fullPath, controller.signal)
        .then((result) => {
          objectUrl = URL.createObjectURL(result.blob);
          setPreviewState({
            kind: 'image',
            objectUrl,
            meta: { size: result.size, mimeType: result.mimeType, modified: result.modified },
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : t('rightSidebar.imageLoadFailed') });
        });
    } else {
      readFileContent(fullPath, controller.signal)
        .then((result) => {
          setPreviewState({ kind: 'text', content: result.content, meta: { size: result.size, truncated: result.truncated } });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to read file' });
        });
    }

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, rootPath, externalVersion, onLineRangeChange, t]);

  // Syntax highlighting for the text preview. Runs after the content is loaded,
  // skips Markdown preview mode (handled separately), unknown languages, and
  // oversized files. refractor is lazy-loaded the first time it's needed.
  useEffect(() => {
    if (previewState.kind !== 'text') {
      setHighlightedLines(null);
      return;
    }
    const readable = rootPath && filePath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const language = resolveLanguage(readable);
    const content = previewState.content;
    // Markdown rendered in "preview" mode uses MarkdownPreview, not the line
    // renderer, so highlighting would be wasted there. In "source" mode we do
    // highlight the raw markdown like any other language.
    const isMarkdownPreview = isMarkdownPath(readable ?? '') && markdownViewMode === 'preview';
    if (!language || isMarkdownPreview || !shouldHighlight(content)) {
      setHighlightedLines(null);
      return;
    }

    let cancelled = false;
    const run = (mod: RefractorLike) => {
      if (cancelled || !mod.registered(language)) {
        if (!cancelled) setHighlightedLines(null);
        return;
      }
      try {
        setHighlightedLines(highlightToLines(mod, content, language));
      } catch {
        setHighlightedLines(null);
      }
    };

    if (refractor) {
      run(refractor);
    } else {
      setHighlightedLines(null);
      loadRefractor()
        .then((mod) => { if (!cancelled) { setRefractor(mod); run(mod); } })
        .catch(() => { /* best-effort: fall back to plain text */ });
    }

    return () => { cancelled = true; };
  }, [previewState, refractor, filePath, rootPath, markdownViewMode]);

  useLayoutEffect(() => {
    if (!readingStateKey || previewState.kind !== 'text') return;
    const restoreKey = `${readingStateKey}:${markdownViewMode}`;
    if (restoredReadingStateKeyRef.current === restoreKey) return;
    const savedReadingState = readFilePreviewReadingState(rootPath, filePath);
    restoredReadingStateKeyRef.current = restoreKey;
    if (!savedReadingState) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = markdownViewMode === 'preview'
        ? savedReadingState.markdownTop ?? savedReadingState.top
        : savedReadingState.top;
      scroller.scrollTo({
        top: Math.max(0, top ?? 0),
        left: Math.max(0, savedReadingState.left ?? 0),
      });
      setMarkdownPreviewScrollTop(markdownViewMode === 'preview' ? Math.max(0, top ?? 0) : 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [filePath, markdownViewMode, previewState.kind, readingStateKey, rootPath]);

  useEffect(() => {
    if (!readingStateKey) return;
    writeFilePreviewReadingState(rootPath, filePath, { lineRange });
  }, [filePath, lineRange, readingStateKey, rootPath]);

  // After a content-search jump, highlight and scroll to the requested line
  // once the file's text has actually rendered. We clear the request via the
  // callback so re-selecting the same line later still works.
  useEffect(() => {
    if (scrollToLine == null) return;
    if (previewState.kind !== 'text') return;
    setFloatingInsertPos(null);
    onLineRangeChange({ start: scrollToLine, end: scrollToLine });
    const target = scrollToLine;
    const frame = requestAnimationFrame(() => {
      const node = lineRefs.current.get(target);
      if (node) node.scrollIntoView({ block: 'center' });
      onScrollToLineHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollToLine, previewState, onLineRangeChange, onScrollToLineHandled]);

  // 没有鼠标事件的场景（例如搜索结果跳转）才兜底定位到选中行右侧。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !lineRange) {
      setFloatingInsertPos(null);
      return;
    }
    if (floatingInsertPos) return;
    const isImagePreviewLocal = previewState.kind === 'image' || (previewState.kind === 'loading' && previewState.mode === 'image');
    const readableLocal = rootPath && filePath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const showMarkdownPreviewLocal = previewState.kind === 'text' && isMarkdownPath(readableLocal ?? '') && markdownViewMode === 'preview';
    if (previewState.kind !== 'text' || isImagePreviewLocal || showMarkdownPreviewLocal) {
      setFloatingInsertPos(null);
      return;
    }

    const computePos = () => {
      const node = lineRefs.current.get(lineRange.end);
      if (!node || !scroller) {
        setFloatingInsertPos(null);
        return;
      }
      const top = node.offsetTop + node.offsetHeight / 2;
      const left = scroller.scrollLeft + Math.max(8, scroller.clientWidth - 120);
      setFloatingInsertPos({ top, left });
    };

    computePos();
    const ro = new ResizeObserver(() => computePos());
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [lineRange, floatingInsertPos, previewState, markdownViewMode, filePath, rootPath, highlightedLines]);

  if (!filePath) {
    return <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">{t('rightSidebar.selectFilePrompt')}</div>;
  }

  const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  const display = getRelativeDisplayPath(readablePath, rootPath);
  const reference = buildFileReference(readablePath, rootPath);
  const lines = previewState.kind === 'text' && previewState.content ? previewState.content.split('\n') : [];
  // Gutter only needs room for the widest line number (+1ch breathing room),
  // so short files render numbers close to the left edge instead of leaving a
  // fixed gap sized for thousand-line files.
  const gutterWidthCh = Math.max(2, String(lines.length).length) + 1;
  const meta = previewState.kind === 'text' || previewState.kind === 'image' ? previewState.meta : null;
  const isMarkdown = isMarkdownPath(readablePath);
  const showMarkdownPreview = previewState.kind === 'text' && isMarkdown && markdownViewMode === 'preview';
  const isImagePreview = previewState.kind === 'image' || (previewState.kind === 'loading' && previewState.mode === 'image');
  const lineReference = buildLineReference(readablePath, rootPath, lineRange);
  const fileReferenceKey = `path:${readablePath}`;
  const lineReferenceKey = lineRange ? `path:${readablePath}:${lineRange.start}-${lineRange.end}` : fileReferenceKey;
  const fileReferenceInserted = insertedReferenceKey === fileReferenceKey;
  const lineReferenceInserted = insertedReferenceKey === lineReferenceKey;
  const fileReferenceCopied = copiedReferenceKey === fileReferenceKey;
  const lineReferenceCopied = copiedReferenceKey === lineReferenceKey;
  const selectedLineLabel = lineRange
    ? (lineRange.start === lineRange.end ? `L${lineRange.start}` : `L${lineRange.start}-${lineRange.end}`)
    : null;

  const placeFloatingInsertButton = (event: MouseEvent<HTMLElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const targetRect = event.currentTarget.getBoundingClientRect();
    const clientX = event.clientX || targetRect.left + targetRect.width / 2;
    const clientY = event.clientY || targetRect.top + targetRect.height / 2;
    const top = clientY - rect.top + scroller.scrollTop;
    const maxLeft = scroller.scrollLeft + Math.max(8, scroller.clientWidth - 132);
    const left = Math.min(
      Math.max(8, clientX - rect.left + scroller.scrollLeft + 10),
      maxLeft,
    );
    setFloatingInsertPos({ top, left });
  };

  const handleLineClick = (event: MouseEvent<HTMLButtonElement>, lineNumber: number) => {
    placeFloatingInsertButton(event);
    onLineRangeChange((current) => {
      if (!current || current.start !== current.end) {
        return { start: lineNumber, end: lineNumber };
      }
      if (current.start === lineNumber) {
        setFloatingInsertPos(null);
        return null;
      }
      return { start: Math.min(current.start, lineNumber), end: Math.max(current.start, lineNumber) };
    });
  };

  const handlePreviewLineRangeClick = (event: MouseEvent<HTMLElement>, startLine: number, endLine: number) => {
    placeFloatingInsertButton(event);
    onLineRangeChange((current) => {
      if (current?.start === startLine && current.end === endLine) {
        setFloatingInsertPos(null);
        return null;
      }
      return { start: startLine, end: endLine };
    });
  };

  const handleMarkdownPreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    setMarkdownPreviewScrollTop(scrollTop);
    writeFilePreviewReadingState(rootPath, filePath, {
      top: scrollTop,
      left: scrollLeft,
      markdownTop: scrollTop,
    });
  };

  const handleSourcePreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    writeFilePreviewReadingState(rootPath, filePath, {
      top: scrollTop,
      left: scrollLeft,
    });
  };

  const insertRangeReference = () => {
    if (!lineRange) return;
    const suffix = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
    const reference = `${buildPromptReference(readablePath, rootPath)}:${suffix}`;
    if (previewState.kind === 'text' && lines.length > 0) {
      const selected: string[] = [];
      for (let n = lineRange.start; n <= lineRange.end; n += 1) {
        const content = lines[n - 1] ?? '';
        selected.push(`${n} ${content}`);
      }
      const lang = getFileExtension(readablePath).replace(/^\./, '');
      const fence = '```';
      const text = `${reference}\n${fence}${lang}\n${selected.join('\n')}\n${fence}\n`;
      onInsertText(text, lineReferenceKey);
      return;
    }
    onInsertReference(`${readablePath}:${suffix}`, lineReferenceKey);
  };

  return (
    // The container is a flex column that fills the panel. The middle scroller
    // is `min-h-0 flex-1` so the bottom action bar can stick to the visible
    // bottom regardless of file length.
    <div className="flex h-full min-h-0 flex-col bg-surface text-foreground">
      <div className={`shrink-0 border-b border-border/15 px-3 ${isMobile && showMarkdownPreview ? 'py-1.5' : 'py-2'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobile && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                aria-label={t('rightSidebar.backToFileList')}
                title={t('common.back')}
              >
                <RiArrowLeft size={15} />
              </button>
            )}
            <div className="min-w-0" title={readablePath}>
              <div className={`${isMobile ? 'max-w-[46vw]' : ''} truncate text-sm font-medium text-foreground`}>{display.name}</div>
              {display.dir && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{display.dir}</div>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isMarkdown && previewState.kind === 'text' && (
              <button
                type="button"
                onClick={() => {
                  if (markdownOutlineOpen) onCloseMarkdownOutline?.();
                  setMarkdownViewMode((mode) => {
                    const next = mode === 'preview' ? 'source' : 'preview';
                    writeCache(MARKDOWN_VIEW_MODE_STORAGE_KEY, next);
                    return next;
                  });
                  onLineRangeChange(null);
                }}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 sm:px-3"
                title={markdownViewMode === 'preview' ? t('rightSidebar.markdownSource') : t('rightSidebar.markdownPreview')}
              >
                {markdownViewMode === 'preview' ? t('rightSidebar.markdownSource') : t('rightSidebar.markdownPreview')}
              </button>
            )}
            {!isMobile && (
              <button
                type="button"
                onClick={() => onInsertReference(readablePath, fileReferenceKey)}
                {...getReferenceLongPressHandlers(reference, fileReferenceKey)}
                className={`inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold transition active:scale-95 ${
                  fileReferenceInserted || fileReferenceCopied
                    ? 'bg-surface-elevated text-foreground'
                    : 'bg-primary/15 text-primary hover:bg-primary/25'
                }`}
                title={`Insert reference: ${reference}`}
              >
                {fileReferenceCopied ? t('rightSidebar.copied') : fileReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertFileRef')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(reference)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
              title={`Copy reference: ${reference}`}
              aria-label={t('rightSidebar.copyFileRef')}
            >
              <RiCopy size={13} />
            </button>
          </div>
        </div>
        {meta && !(isMobile && showMarkdownPreview) && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            {meta.size !== null && <span>{meta.size.toLocaleString()} bytes</span>}
            {'truncated' in meta && meta.truncated && <span className="text-[color:var(--warning)]">preview truncated to 1MB</span>}
            {'mimeType' in meta && <span>{meta.mimeType}</span>}
            {'dimensions' in previewState && previewState.dimensions && <span>{previewState.dimensions.width} × {previewState.dimensions.height}</span>}
          </div>
        )}
        {/* Hint row — fixed height so toggling line range doesn't shift the
            file content below. */}
        {!(isMobile && showMarkdownPreview) && <div className="mt-1 flex h-4 items-center gap-2 text-[10px] text-muted-foreground/75">
          <span className="truncate">
            {isImagePreview
              ? t('rightSidebar.imagePreviewHint')
              : showMarkdownPreview
                ? t('rightSidebar.markdownPreviewHint')
              : lineRange
                ? t('rightSidebar.selectedLineHint', { lineLabel: selectedLineLabel ?? '' })
                : t('rightSidebar.multiLineHint')}
          </span>
        </div>}
      </div>
      {previewState.kind === 'loading' ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-8 text-center text-sm text-muted-foreground">
          {previewState.mode === 'image' ? t('rightSidebar.loadingImage') : 'Loading file…'}
        </div>
      ) : previewState.kind === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">{previewState.message}</div>
        </div>
      ) : previewState.kind === 'image' ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-surface p-3">
          <ZoomableImage
            src={previewState.objectUrl}
            alt={display.name}
            onLoad={(event) => {
              const img = event.currentTarget;
              setPreviewState((current) => (
                current.kind === 'image'
                  ? { ...current, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
                  : current
              ));
            }}
            onError={() => setPreviewState({ kind: 'error', message: t('rightSidebar.imageLoadFailed') })}
          />
        </div>
      ) : showMarkdownPreview ? (
        <div
          ref={scrollerRef}
          className="relative min-h-0 flex-1 overflow-auto bg-surface"
          data-sidebar-gesture-ignore
          data-markdown-preview-scroller
          onScroll={handleMarkdownPreviewScroll}
          style={{ touchAction: 'pan-x pan-y' }}
        >
          <MarkdownPreview
            content={previewState.content}
            filePath={readablePath}
            rootPath={rootPath}
            lineRange={lineRange}
            onLineRangeClick={handlePreviewLineRangeClick}
            scrollTop={markdownPreviewScrollTop}
            outlineOpen={markdownOutlineOpen}
            outlineCloseSignal={markdownOutlineCloseSignal}
            onOutlineOpen={onOpenMarkdownOutline}
            onOutlineClose={onCloseMarkdownOutline}
            lightboxOpen={markdownImageLightboxOpen}
            lightboxCloseSignal={markdownImageLightboxCloseSignal}
            onLightboxOpen={onOpenMarkdownImageLightbox}
            onLightboxClose={onCloseMarkdownImageLightbox}
          />
          {!isMobile && lineRange && floatingInsertPos && (
            <button
              type="button"
              onClick={insertRangeReference}
              {...getReferenceLongPressHandlers(lineReference, lineReferenceKey)}
              style={{ top: floatingInsertPos.top, left: floatingInsertPos.left, transform: 'translateY(-50%)' }}
              className="pointer-events-auto absolute z-popover inline-flex h-7 items-center gap-1 rounded-full bg-surface-elevated px-3 text-[11px] font-semibold text-foreground shadow-lg ring-1 ring-border-strong/40 transition hover:bg-surface-2 active:scale-95"
              title={`Insert markdown reference: ${lineReference}`}
            >
              <RiLink size={11} />
              {lineReferenceCopied ? t('rightSidebar.copied') : lineReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
            </button>
          )}
        </div>
      ) : previewState.kind === 'text' ? (
        <div ref={scrollerRef} onScroll={handleSourcePreviewScroll} className="termdock-code relative min-h-0 flex-1 overflow-auto rounded-none bg-surface p-2 font-mono text-[11px] leading-relaxed text-foreground">
          {lines.length > 0 ? (
            <div className="min-w-full">
              {lines.map((line, index) => {
                const lineNumber = index + 1;
                const isSelected = Boolean(lineRange && lineNumber >= lineRange.start && lineNumber <= lineRange.end);
                const highlighted = highlightedLines && highlightedLines.length === lines.length
                  ? highlightedLines[index]
                  : null;
                return (
                  <button
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    ref={(node) => {
                      if (node) lineRefs.current.set(lineNumber, node);
                      else lineRefs.current.delete(lineNumber);
                    }}
                    type="button"
                    onClick={(event) => handleLineClick(event, lineNumber)}
                    // Line-number gutter width tracks the file's digit count so a
                    // short file doesn't reserve room for thousands of lines and
                    // leave a big gap between the edge and the numbers.
                    style={{ gridTemplateColumns: `${gutterWidthCh}ch 1fr` }}
                    className={`grid w-max min-w-full gap-2 rounded pr-1 text-left transition active:scale-[0.995] ${
                      isSelected ? 'bg-primary/15 text-foreground' : 'hover:bg-surface-2'
                    }`}
                    title={`Tap to reference ${reference}:${lineNumber}`}
                  >
                    <span className={`select-none text-right text-[10px] ${isSelected ? 'text-primary' : 'text-muted-foreground/55'}`}>{lineNumber}</span>
                    <span className="whitespace-pre">{highlighted ?? (line || ' ')}</span>
                  </button>
                );
              })}
            </div>
          ) : 'Empty file.'}
          {/* Floating insert button — anchors to the selected line so the user
              doesn't have to drag focus to the bottom action bar. Hidden on
              mobile (the bottom bar is more thumb-friendly there). */}
          {!isMobile && lineRange && floatingInsertPos && (
            <button
              type="button"
              onClick={insertRangeReference}
              {...getReferenceLongPressHandlers(lineReference, lineReferenceKey)}
              style={{ top: floatingInsertPos.top, left: floatingInsertPos.left, transform: 'translateY(-50%)' }}
              className="pointer-events-auto absolute z-popover inline-flex h-7 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-semibold text-primary-foreground shadow-lg ring-1 ring-primary/30 transition hover:bg-primary/90 active:scale-95"
              title={`Insert code reference: ${lineReference}`}
            >
              <RiLink size={11} />
              {lineReferenceCopied ? t('rightSidebar.copied') : lineReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
            </button>
          )}
        </div>
      ) : null}
      {/* Sticky bottom action bar — only shows when a line range is selected.
          Collapsed out of the layout (instead of opacity-0) when no range is
          selected so the scroller can fill the full available height — this
          matters most on mobile where the wasted 53px is a noticeable chunk
          of the viewport. */}
      <div
        className={`shrink-0 overflow-hidden border-t border-border/15 bg-surface transition-all duration-150 ${
          isMobile && lineRange && !isImagePreview ? 'max-h-24 opacity-100' : 'pointer-events-none max-h-0 opacity-0 border-t-transparent'
        }`}
        aria-hidden={!isMobile || !lineRange || isImagePreview}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
            {t('rightSidebar.selectedLineFooter', { lineLabel: selectedLineLabel ?? '' })}
          </div>
          <button
            type="button"
            onClick={() => onLineRangeChange(null)}
            className="inline-flex h-9 items-center rounded-full bg-surface-2 px-3 text-[12px] font-medium text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
          >
            {t('rightSidebar.clearSelection')}
          </button>
          <button
            type="button"
            onClick={insertRangeReference}
            {...getReferenceLongPressHandlers(lineReference, lineReferenceKey)}
            className={`inline-flex h-9 items-center gap-1 rounded-full px-4 text-[12px] font-semibold shadow-sm transition active:scale-95 ${
              lineReferenceInserted || lineReferenceCopied
                ? 'bg-surface-elevated text-foreground hover:bg-surface-2'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
            title={`Insert code reference: ${lineReference}`}
          >
            {lineReferenceCopied ? t('rightSidebar.copied') : lineReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RightSidebar(
  {
    isOpen,
    drawerWidthPx,
    onClose,
    onOpen,
    push,
    rightSidebarFilePreviewOpen = false,
    rightSidebarFilePreviewCloseSignal,
    onOpenRightSidebarFilePreview,
    onCloseRightSidebarFilePreview,
    rightSidebarRepoPickerOpen = false,
    rightSidebarRepoPickerCloseSignal,
    onOpenRightSidebarRepoPicker,
    onCloseRightSidebarRepoPicker,
    markdownOutlineOpen = false,
    markdownOutlineCloseSignal,
    onOpenMarkdownOutline,
    onCloseMarkdownOutline,
    markdownImageLightboxOpen = false,
    markdownImageLightboxCloseSignal,
    onOpenMarkdownImageLightbox,
    onCloseMarkdownImageLightbox,
  }: RightSidebarProps,
) {
  const { t } = useI18n();
  const [fileQuery, setFileQuery] = useState('');
  const searchOpen = useSidebarStore((s) => s.rightSearchOpen);
  const setRightSearchOpen = useSidebarStore((s) => s.setRightSearchOpen);
  const [searchMode, setSearchMode] = useState<FileSearchMode>('name');
  const deferredFileQuery = useDeferredValue(fileQuery);
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [gitRepositories, setGitRepositories] = useState<GitRepositoryBundle[]>([]);
  const [activeGitRepoRoot, setActiveGitRepoRoot] = useState<string | null>(null);
  const [insertedReferenceKey, setInsertedReferenceKey] = useState<string | null>(null);
  const [copiedReferenceKey, setCopiedReferenceKey] = useState<string | null>(null);
  // Line-range selection lives in the sidebar so the sticky action bar and
  // the file scroller stay in sync without prop-drilling the click handler.
  const [lineRange, setLineRange] = useState<{ start: number; end: number } | null>(null);
  // A pending "scroll to this line" request from content search. Cleared by the
  // preview once it has highlighted and scrolled to the matched line.
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  // On phone-sized panels the diff tab is intentionally a plain grouped list:
  // one file row, tap to expand/collapse its inline diff, no mode switcher.
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Set<string>>(() => new Set());
  const [collapsedGitRepoGroups, setCollapsedGitRepoGroups] = useState<Set<string>>(() => new Set());
  // When on, long diff lines wrap instead of overflowing horizontally. The
  // user can opt in per-session without leaving the panel.
  const [diffWrap, setDiffWrap] = useState(true);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [mobileFilePreviewOpen, setMobileFilePreviewOpen] = useState(false);
  const [hasMountedDiffPane, setHasMountedDiffPane] = useState(false);
  const [hasMountedPreviewPane, setHasMountedPreviewPane] = useState(false);
  const [runningGitAction, setRunningGitAction] = useState<{ action: GitActionKey; path?: string } | null>(null);
  const [completedGitAction, setCompletedGitAction] = useState<{ action: GitActionKey; path?: string; label: string } | null>(null);
  const [confirmGitAction, setConfirmGitAction] = useState<ConfirmGitAction | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [gitQuickActionsOpen, setGitQuickActionsOpen] = useState(false);
  const [gitDetailsLoading, setGitDetailsLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [switchBranch, setSwitchBranch] = useState('');
  const [pushRemote, setPushRemote] = useState('');
  const [pushBranch, setPushBranch] = useState('');
  const [fileWatchError, setFileWatchError] = useState<string | null>(null);
  const isMobile = drawerWidthPx < MOBILE_WIDTH_THRESHOLD_PX;
  const isWide = !isMobile && drawerWidthPx >= WIDE_WIDTH_THRESHOLD_PX;
  const [fileTreeWidthPx, setFileTreeWidthPx] = useState(() => readFileTreeWidth(drawerWidthPx));
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const explorerRoot = useSidebarStore((s) => s.explorerRoot);
  const pinnedExplorerRootsCache = useSidebarStore((s) => s.pinnedExplorerRootsCache);
  const setExplorerRoot = useSidebarStore((s) => s.setExplorerRoot);
  const resetExplorerToProject = useSidebarStore((s) => s.resetExplorerToProject);
  const pinExplorerRoot = useSidebarStore((s) => s.pinExplorerRoot);
  const unpinExplorerRoot = useSidebarStore((s) => s.unpinExplorerRoot);
  const selectedFilePath = useSidebarStore((s) => s.selectedFilePath);
  const selectFile = useSidebarStore((s) => s.selectFile);
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const toggleShowHiddenFiles = useSidebarStore((s) => s.toggleShowHiddenFiles);
  const changedFiles = useSidebarStore((s) => s.changedFiles);
  const setChangedFiles = useSidebarStore((s) => s.setChangedFiles);
  const invalidateDirectoryCache = useSidebarStore((s) => s.invalidateDirectoryCache);
  const applyFileWatchEvents = useSidebarStore((s) => s.applyFileWatchEvents);
  const gitBundleLoading = useSidebarStore((s) => s.gitBundleLoading);
  const gitBundleSlow = useSidebarStore((s) => s.gitBundleSlow);
  const gitBundleError = useSidebarStore((s) => s.gitBundleError);
  const gitBundleLastLoadedAt = useSidebarStore((s) => s.gitBundleLastLoadedAt);
  const setGitBundleLoading = useSidebarStore((s) => s.setGitBundleLoading);
  const setGitBundleSlow = useSidebarStore((s) => s.setGitBundleSlow);
  const setGitBundleError = useSidebarStore((s) => s.setGitBundleError);
  const markGitBundleLoaded = useSidebarStore((s) => s.markGitBundleLoaded);
  const fileTreeRoot = explorerRoot ?? rootPath;
  const rootEntriesLoaded = useSidebarStore((s) => Boolean(fileTreeRoot && s.directoryCache.has(fileTreeRoot)));
  const fileTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const gitBundleRequestIdRef = useRef(0);
  const gitBundleAbortRef = useRef<AbortController | null>(null);
  const gitDetailsRequestIdRef = useRef(0);
  const lastAutoRefreshRootRef = useRef<string | null>(null);
  const fileTreeResizeRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const repoSwitcherPointerRef = useRef<{ startX: number; pointerId: number } | null>(null);

  const applyGitBundle = useCallback((bundle: GitBundleResponse, options: { reloadDiff?: boolean } = {}) => {
    setChangedFiles(toChangedFileMap(bundle.files));
    setGitRepositories(bundle.repositories ?? (bundle.context?.root ? [{
      id: bundle.context.root,
      root: bundle.context.root,
      relativeRoot: '.',
      name: getPathBasename(bundle.context.root) || bundle.context.root,
      depth: 0,
      nested: false,
      available: bundle.available,
      files: bundle.files,
      context: bundle.context,
      error: bundle.error,
    }] : []));
    setGitContext((current) => {
      if (!bundle.context) return null;
      const currentRoot = current?.root ?? rootPath;
      if (!current?.available || currentRoot !== (bundle.context.root ?? rootPath)) return bundle.context;
      return { ...current, ...bundle.context };
    });
    if (options.reloadDiff) setDiffRefreshKey((key) => key + 1);
    const current = useSidebarStore.getState().selectedFilePath;
    if (current && !current.startsWith('/') && !bundle.files.some((file) => file.path === current || file.absolutePath === current)) {
      selectFile(null);
    }
    setExpandedDiffFiles((expanded) => {
      const valid = new Set(bundle.files.map((file) => getChangedFileSelectionPath(file)));
      const next = new Set<string>();
      for (const path of expanded) {
        if (valid.has(path)) next.add(path);
      }
      return next;
    });
    setCollapsedGitRepoGroups((collapsed) => {
      const valid = new Set(bundle.files.map((file) => getChangedFileRepoRoot(file, rootPath)).filter(Boolean) as string[]);
      const next = new Set<string>();
      for (const root of collapsed) {
        if (valid.has(root)) next.add(root);
      }
      return next;
    });
  }, [rootPath, selectFile, setChangedFiles]);

  useEffect(() => {
    gitBundleRequestIdRef.current += 1;
    gitDetailsRequestIdRef.current += 1;
    gitBundleAbortRef.current?.abort();
    gitBundleAbortRef.current = null;
    setGitDetailsLoading(false);
    setGitRepositories([]);
    setActiveGitRepoRoot(null);
    setGitContext(null);
  }, [rootPath]);

  const loadGitBundle = useCallback(async (cwd: string | undefined = rootPath ?? undefined, options: { reloadDiff?: boolean; preloadDiff?: boolean } = {}) => {
    const requestId = gitBundleRequestIdRef.current + 1;
    gitBundleRequestIdRef.current = requestId;
    gitBundleAbortRef.current?.abort();
    const controller = new AbortController();
    gitBundleAbortRef.current = controller;
    let slowTimer: number | null = null;
    setGitBundleLoading(true);
    setGitBundleSlow(false);
    setGitBundleError(null);
    if (typeof window !== 'undefined') {
      slowTimer = window.setTimeout(() => {
        if (gitBundleRequestIdRef.current === requestId) setGitBundleSlow(true);
      }, GIT_BUNDLE_SLOW_MS);
    }

    try {
      const bundle = await getGitBundle(cwd, controller.signal, { includeNested: true, refresh: options.reloadDiff ?? false });
      if (gitBundleRequestIdRef.current !== requestId) return null;
      applyGitBundle(bundle, { reloadDiff: options.reloadDiff ?? false });
      if (options.preloadDiff) {
        const current = useSidebarStore.getState().selectedFilePath;
        const currentFile = current ? bundle.files.find((file) => file.path === current || file.absolutePath === current) : undefined;
        preloadSidebarDiff(cwd ?? rootPath, currentFile ? current : null, { force: options.reloadDiff ?? false, repoRoot: currentFile?.repoRoot });
      }
      return bundle;
    } catch (err) {
      if (gitBundleRequestIdRef.current !== requestId || isAbortError(err)) return null;
      setGitContext(null);
      setGitBundleError(err instanceof Error ? err.message : 'Failed to load Git changes');
      return null;
    } finally {
      if (slowTimer !== null) window.clearTimeout(slowTimer);
      if (gitBundleAbortRef.current === controller) gitBundleAbortRef.current = null;
      if (gitBundleRequestIdRef.current === requestId) markGitBundleLoaded();
    }
  }, [applyGitBundle, markGitBundleLoaded, rootPath, setGitBundleError, setGitBundleLoading, setGitBundleSlow]);

  const refreshGitState = useCallback(async () => {
    if (!rootPath) return;
    await loadGitBundle(rootPath, { reloadDiff: true });
  }, [loadGitBundle, rootPath]);

  const loadGitDetails = useCallback(async (cwd: string | undefined = rootPath ?? undefined) => {
    if (!cwd) return null;
    const requestId = gitDetailsRequestIdRef.current + 1;
    gitDetailsRequestIdRef.current = requestId;
    setGitDetailsLoading(true);
    try {
      const context = await getGitContext(cwd);
      if (gitDetailsRequestIdRef.current !== requestId) return null;
      setGitContext((current) => {
        if (!current?.available || !context.available) return context;
        return { ...current, ...context };
      });
      return context;
    } catch (error) {
      if (gitDetailsRequestIdRef.current === requestId) {
        setGitActionError(error instanceof Error ? error.message : 'Failed to load Git details');
      }
      return null;
    } finally {
      if (gitDetailsRequestIdRef.current === requestId) setGitDetailsLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    if (!isOpen) {
      setFileQuery('');
      setRightSearchOpen(false);
      setLineRange(null);
      // Keep diff view mode + wrap preference across close/open so the
      // user's chosen reading mode is preserved within a session.
    }
  }, [isOpen, setRightSearchOpen]);

  // Focus the search input whenever the search box opens, regardless of whether
  // it was opened by the header button or a global keyboard shortcut.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      document.querySelector<HTMLInputElement>('input[data-right-search]')?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [searchOpen]);

  useEffect(() => {
    if (!isMobile) setMobileFilePreviewOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (rightSidebarFilePreviewCloseSignal !== undefined) {
      setMobileFilePreviewOpen(false);
      setLineRange(null);
    }
  }, [rightSidebarFilePreviewCloseSignal]);

  useEffect(() => {
    if (rightSidebarRepoPickerCloseSignal !== undefined) {
      // The open state is owned by App/history. This effect exists so the
      // component reacts consistently when Android Back closes the sheet.
    }
  }, [rightSidebarRepoPickerCloseSignal]);

  useEffect(() => {
    if (!isMobile && rightSidebarFilePreviewOpen) {
      onCloseRightSidebarFilePreview?.();
    }
  }, [isMobile, onCloseRightSidebarFilePreview, rightSidebarFilePreviewOpen]);

  useEffect(() => {
    setFileTreeWidthPx((width) => clampFileTreeWidth(width, drawerWidthPx));
  }, [drawerWidthPx]);

  const startFileTreeResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!isWide) return;
    event.preventDefault();
    fileTreeResizeRef.current = {
      startX: event.clientX,
      startWidth: fileTreeWidthPx,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [fileTreeWidthPx, isWide]);

  const handleFileTreeResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = fileTreeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextWidth = clampFileTreeWidth(resize.startWidth + event.clientX - resize.startX, drawerWidthPx);
    setFileTreeWidthPx(nextWidth);
    writeCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY, nextWidth, FILE_TREE_WIDTH_WRITE_MS);
  }, [drawerWidthPx]);

  const stopFileTreeResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = fileTreeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    fileTreeResizeRef.current = null;
    flushCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the browser cancelled drag.
    }
  }, []);

  const gitKnownUnavailable = Boolean(rootPath && gitBundleLastLoadedAt !== null && gitContext?.available === false);
  // Non-Git workspaces have no Git/Changes tabs. Only the medium-width desktop
  // layout keeps a separate "Preview" tab; mobile (overlay) and wide (side-by-
  // side) layouts render the preview without a dedicated tab.
  const effectiveRightTab: RightSidebarTab = gitKnownUnavailable
    ? (!isMobile && !isWide && rightTab === 'file' ? 'file' : 'files')
    : (isMobile || isWide) && rightTab === 'file' ? 'files' : rightTab;
  const gitPaneActive = effectiveRightTab === 'git';
  const filesPaneActive = effectiveRightTab === 'files';
  const diffPaneActive = effectiveRightTab === 'diff';
  const previewPaneActive = effectiveRightTab === 'file' && !isMobile && !isWide;
  const mobilePreviewActive = isMobile && mobileFilePreviewOpen && Boolean(selectedFilePath);

  // Load Git state only when the Git/Changes panes are actually used. On large
  // repositories, even a delayed status probe can compete with file browsing
  // for disk I/O, so Files stays isolated from Git unless the user asks for it.
  useEffect(() => {
    const shouldPreloadDiff = gitPaneActive || diffPaneActive || rightTab === 'git' || rightTab === 'diff';
    if (!shouldPreloadDiff || !rootPath || gitBundleLoading) return;
    if (!rootEntriesLoaded) return;
    const hasCachedGitBundle = gitBundleLastLoadedAt !== null;
    if (hasCachedGitBundle && lastAutoRefreshRootRef.current === rootPath) return;
    lastAutoRefreshRootRef.current = rootPath;
    const handle = window.setTimeout(() => {
      void loadGitBundle(rootPath, { preloadDiff: shouldPreloadDiff });
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [diffPaneActive, gitBundleLastLoadedAt, gitBundleLoading, gitPaneActive, isOpen, loadGitBundle, rightTab, rootEntriesLoaded, rootPath]);

  const gitDetailsLoaded = Boolean(gitContext?.available && gitContext.branches && gitContext.remotes && gitContext.recentCommits);

  useEffect(() => {
    if (!rootPath || !gitContext?.available || !gitPaneActive || gitDetailsLoaded || gitDetailsLoading) return;
    void loadGitDetails(rootPath);
  }, [gitContext?.available, gitDetailsLoaded, gitDetailsLoading, gitPaneActive, loadGitDetails, rootPath]);

  useEffect(() => {
    if (diffPaneActive) setHasMountedDiffPane(true);
  }, [diffPaneActive]);

  useEffect(() => {
    if (previewPaneActive) setHasMountedPreviewPane(true);
  }, [previewPaneActive]);

  const handleFileTreeScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!fileTreeRoot) return;
    writeFileTreeScrollPosition(fileTreeRoot, event.currentTarget.scrollTop);
  }, [fileTreeRoot]);

  useEffect(() => {
    return () => {
      gitBundleAbortRef.current?.abort();
      flushCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY);
      flushCacheThrottled(FILE_PREVIEW_READING_STATE_STORAGE_KEY);
      flushCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY);
    };
  }, []);

  useEffect(() => {
    if (!fileTreeRoot || !rootEntriesLoaded) return;
    const savedTop = readFileTreeScrollCache()[fileTreeRoot]?.top;
    if (typeof savedTop !== 'number') return;
    let frame = window.requestAnimationFrame(() => {
      if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      frame = window.requestAnimationFrame(() => {
        if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fileTreeRoot, rootEntriesLoaded]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setLineRange(null);
    if (isMobile) {
      setMobileFilePreviewOpen(true);
      onOpenRightSidebarFilePreview?.();
      return;
    }
    // In wide mode the preview is already visible alongside the tree, so we
    // don't need to switch tabs and steal focus from the user's browse flow.
    if (!isWide) setRightTab(isMobile ? 'files' : 'file');
  }, [isMobile, isWide, onOpenRightSidebarFilePreview, selectFile, setRightTab]);

  // Jump straight to a content-search match: open the file and ask the preview
  // to highlight and scroll to the matched line once its content has loaded.
  const handleContentMatchSelect = useCallback((path: string, line: number) => {
    selectFile(path);
    setScrollToLine(line);
    if (isMobile) {
      setMobileFilePreviewOpen(true);
      onOpenRightSidebarFilePreview?.();
      return;
    }
    if (!isWide) setRightTab('file');
  }, [isMobile, isWide, onOpenRightSidebarFilePreview, selectFile, setRightTab]);

  const markReferenceInserted = useCallback((key: string) => {
    setInsertedReferenceKey(key);
    window.setTimeout(() => setInsertedReferenceKey((current) => (current === key ? null : current)), 1400);
  }, []);

  const markReferenceCopied = useCallback((key: string) => {
    setCopiedReferenceKey(key);
    window.setTimeout(() => setCopiedReferenceKey((current) => (current === key ? null : current)), 1400);
  }, []);

  const getPathReferenceText = useCallback((path: string) => {
    const absolutePath = rootPath && !path.startsWith('/') ? `${rootPath}/${path}` : path;
    return buildPromptReference(absolutePath, rootPath);
  }, [rootPath]);
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(markReferenceCopied);

  const insertPathReference = useCallback((path: string, key?: string) => {
    const absolutePath = rootPath && !path.startsWith('/') ? `${rootPath}/${path}` : path;
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: buildReferenceInputText(absolutePath, rootPath), focus: false },
    }));
    markReferenceInserted(key ?? `path:${absolutePath}`);
  }, [markReferenceInserted, rootPath]);

  const insertReferenceText = useCallback((text: string, key: string) => {
    if (!text) return;
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: text.endsWith('\n') || text.endsWith(' ') ? text : `${text} `, focus: false },
    }));
    markReferenceInserted(key);
  }, [markReferenceInserted]);

  const insertContextText = useCallback((label: string, text: string, key?: string) => {
    if (!text) return;
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: text.endsWith(' ') ? text : `${text} `, focus: false },
    }));
    markReferenceInserted(key ?? `context:${label}`);
  }, [markReferenceInserted]);

  const rootName = useMemo(() => {
    if (!rootPath) return t('rightSidebar.workspace');
    return getPathBasename(rootPath);
  }, [rootPath, t]);

  const explorerName = useMemo(() => getPathBasename(fileTreeRoot) || rootName, [fileTreeRoot, rootName]);
  const explorerParentPath = useMemo(() => getParentPath(fileTreeRoot), [fileTreeRoot]);
  const pinnedExplorerRoots = useMemo(() => (rootPath ? pinnedExplorerRootsCache[rootPath] ?? [] : []), [pinnedExplorerRootsCache, rootPath]);
  const pinnedExplorerRootSet = useMemo(() => new Set(pinnedExplorerRoots.map((entry) => entry.path)), [pinnedExplorerRoots]);
  const fileTreeRootPinned = Boolean(fileTreeRoot && pinnedExplorerRootSet.has(fileTreeRoot));
  const canPinFileTreeRoot = Boolean(rootPath && fileTreeRoot && fileTreeRoot !== rootPath);
  const browsingOutsideProject = Boolean(rootPath && explorerRoot && explorerRoot !== rootPath);
  const fileTreeRootReferenceKey = fileTreeRoot ? `path:${fileTreeRoot}` : null;
  const gitContextReferenceKey = 'context:git';

  const goToExplorerParent = useCallback(() => {
    if (explorerParentPath) setExplorerRoot(explorerParentPath);
  }, [explorerParentPath, setExplorerRoot]);

  const goToProjectRoot = useCallback(() => {
    resetExplorerToProject();
  }, [resetExplorerToProject]);

  const refreshExplorerRoot = useCallback(() => {
    if (!fileTreeRoot) return;
    invalidateDirectoryCache(fileTreeRoot, false);
  }, [fileTreeRoot, invalidateDirectoryCache]);

  const togglePinnedExplorerRoot = useCallback(() => {
    if (!fileTreeRoot || !canPinFileTreeRoot) return;
    if (fileTreeRootPinned) unpinExplorerRoot(fileTreeRoot);
    else pinExplorerRoot(fileTreeRoot, 'directory');
  }, [canPinFileTreeRoot, fileTreeRoot, fileTreeRootPinned, pinExplorerRoot, unpinExplorerRoot]);

  const openDirectoryAsExplorerRoot = useCallback((path: string) => {
    setExplorerRoot(path);
    setFileQuery('');
  }, [setExplorerRoot]);

  const togglePinnedDirectory = useCallback((path: string) => {
    if (!rootPath || path === rootPath) return;
    if (pinnedExplorerRootSet.has(path)) unpinExplorerRoot(path);
    else pinExplorerRoot(path, 'directory');
  }, [pinExplorerRoot, pinnedExplorerRootSet, rootPath, unpinExplorerRoot]);

  const togglePinnedFile = useCallback((path: string) => {
    if (!rootPath || !path) return;
    if (pinnedExplorerRootSet.has(path)) unpinExplorerRoot(path);
    else pinExplorerRoot(path, 'file');
  }, [pinExplorerRoot, pinnedExplorerRootSet, rootPath, unpinExplorerRoot]);

  const watchedFileRoots = useMemo(() => {
    if (!rootPath || !selectedFilePath) return [];
    const selectedAbsolutePath = selectedFilePath.startsWith('/') ? selectedFilePath : `${rootPath}/${selectedFilePath}`;
    const selectedParent = getParentPath(selectedAbsolutePath);
    return selectedParent ? [selectedParent] : [];
  }, [rootPath, selectedFilePath]);

  useEffect(() => {
    if (!isOpen || watchedFileRoots.length === 0) return;
    const controller = new AbortController();
    let cancelled = false;
    setFileWatchError(null);
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      watchFileSystem(watchedFileRoots, (events) => {
        applyFileWatchEvents(events);
      }, controller.signal).catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setFileWatchError(error instanceof Error ? error.message : 'File watching unavailable');
      });
    }, SIDEBAR_BACKGROUND_IO_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [applyFileWatchEvents, isOpen, watchedFileRoots]);

  const changedSummary = useMemo(() => {
    const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, conflicted: 0, staged: 0, other: 0 };
    for (const file of changedFiles.values()) {
      if (file.status === 'added') counts.added += 1;
      else if (file.status === 'modified') counts.modified += 1;
      else if (file.status === 'deleted') counts.deleted += 1;
      else if (file.status === 'renamed') counts.renamed += 1;
      else if (file.status === 'copied') counts.copied += 1;
      else if (file.status === 'untracked') counts.untracked += 1;
      else if (file.status === 'conflicted') counts.conflicted += 1;
      else counts.other += 1;
      if (file.staged) counts.staged += 1;
    }
    return counts;
  }, [changedFiles]);

  const gitRepositoryByRoot = useMemo(() => {
    const map = new Map<string, GitRepositoryBundle>();
    for (const repo of gitRepositories) map.set(repo.root, repo);
    return map;
  }, [gitRepositories]);

  const changedRepoSummaries = useMemo(() => {
    const summaries = new Map<string, { root: string; label: string; branch?: string | null; count: number; staged: number }>();
    for (const file of changedFiles.values()) {
      const repoRoot = getChangedFileRepoRoot(file, rootPath);
      if (!repoRoot) continue;
      const repo = gitRepositoryByRoot.get(repoRoot);
      const label = getChangedFileRepoLabel(file) || repo?.relativeRoot || repo?.name || rootName;
      const current = summaries.get(repoRoot) ?? { root: repoRoot, label, branch: repo?.context?.branch, count: 0, staged: 0 };
      current.count += 1;
      if (file.staged) current.staged += 1;
      summaries.set(repoRoot, current);
    }
    return Array.from(summaries.values()).sort((a, b) => {
      if (a.label === rootName) return -1;
      if (b.label === rootName) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [changedFiles, gitRepositories, gitRepositoryByRoot, rootName, rootPath]);

  const activeGitRepoSummary = useMemo(() => (
    activeGitRepoRoot ? changedRepoSummaries.find((repo) => repo.root === activeGitRepoRoot) ?? null : null
  ), [activeGitRepoRoot, changedRepoSummaries]);

  const activeGitRepoIndex = useMemo(() => {
    if (!activeGitRepoRoot) return 0;
    const index = changedRepoSummaries.findIndex((repo) => repo.root === activeGitRepoRoot);
    return index >= 0 ? index + 1 : 0;
  }, [activeGitRepoRoot, changedRepoSummaries]);

  const gitRepoSwitcherItems = useMemo(() => [
    { root: null as string | null, label: t('rightSidebar.allRepositories'), count: changedFiles.size, branch: null as string | null },
    ...changedRepoSummaries.map((repo) => ({ root: repo.root, label: repo.label, count: repo.count, branch: repo.branch ?? null })),
  ], [changedFiles.size, changedRepoSummaries, t]);

  const activeGitRepoSwitcherItem = gitRepoSwitcherItems[activeGitRepoIndex] ?? gitRepoSwitcherItems[0];

  useEffect(() => {
    if (activeGitRepoRoot && !changedRepoSummaries.some((repo) => repo.root === activeGitRepoRoot)) {
      setActiveGitRepoRoot(null);
    }
  }, [activeGitRepoRoot, changedRepoSummaries]);

  const switchBranchOptions = useMemo<GitPickerOption[]>(() => {
    const values = new Set<string>();
    if (gitContext?.branch) values.add(gitContext.branch);
    for (const branch of gitContext?.branches ?? []) values.add(branch);
    return Array.from(values).map((branch) => ({
      value: branch,
      label: branch,
      meta: branch === gitContext?.branch ? t('rightSidebar.pushCurrentBranchBadge') : undefined,
    }));
  }, [gitContext?.branch, gitContext?.branches, t]);

  const pushRemoteOptions = useMemo<GitPickerOption[]>(() => {
    const values = new Set<string>();
    if (gitContext?.upstreamRemote) values.add(gitContext.upstreamRemote);
    for (const remote of gitContext?.remotes ?? []) values.add(remote);
    return Array.from(values).map((remote) => ({
      value: remote,
      label: remote,
      meta: remote === gitContext?.upstreamRemote ? t('rightSidebar.pushUpstreamBadge') : undefined,
    }));
  }, [gitContext?.remotes, gitContext?.upstreamRemote, t]);

  const pushBranchOptions = useMemo<GitPickerOption[]>(() => {
    const values = new Set<string>();
    if (gitContext?.upstreamBranch) values.add(gitContext.upstreamBranch);
    if (gitContext?.branch) values.add(gitContext.branch);
    for (const branch of gitContext?.branches ?? []) values.add(branch);
    return Array.from(values).map((branch) => ({
      value: branch,
      label: branch,
      meta: branch === gitContext?.upstreamBranch
        ? t('rightSidebar.pushUpstreamBadge')
        : branch === gitContext?.branch ? t('rightSidebar.pushCurrentBranchBadge') : undefined,
    }));
  }, [gitContext?.branch, gitContext?.branches, gitContext?.upstreamBranch, t]);

  useEffect(() => {
    if (!gitContext?.available) return;
    setSwitchBranch(gitContext.branch || (gitContext.branches?.[0] ?? ''));
    setPushRemote((current) => current || gitContext.upstreamRemote || (gitContext.remotes?.includes('origin') ? 'origin' : gitContext.remotes?.[0] ?? ''));
    setPushBranch((current) => current || gitContext.upstreamBranch || gitContext.branch || (gitContext.branches?.[0] ?? ''));
  }, [gitContext]);

  const pushSyncInfo = useMemo(() => {
    if (!gitContext?.upstream) {
      return { text: t('rightSidebar.pushNoUpstream'), className: 'bg-surface-2 text-muted-foreground' };
    }
    const ahead = gitContext.ahead ?? 0;
    const behind = gitContext.behind ?? 0;
    if (ahead > 0 && behind > 0) {
      return { text: t('rightSidebar.pushDivergedCount', { ahead, behind }), className: 'bg-destructive/10 text-destructive' };
    }
    if (ahead > 0) {
      return { text: t('rightSidebar.pushAheadCount', { count: ahead }), className: 'bg-accent/10 text-accent' };
    }
    if (behind > 0) {
      return { text: t('rightSidebar.pushBehindCount', { count: behind }), className: 'bg-surface-2 text-[color:var(--diff-hunk-accent)]' };
    }
    return { text: t('rightSidebar.pushUpToDate'), className: 'bg-surface-2 text-muted-foreground' };
  }, [gitContext?.ahead, gitContext?.behind, gitContext?.upstream, t]);

  function renderGitRepoFilter() {
    if (changedRepoSummaries.length <= 1) return null;
    return (
      <div className="bg-surface px-2 py-2">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Repositories
        </div>
        <div className="space-y-1 pr-1">
        <button
          type="button"
          onClick={() => setActiveGitRepoRoot(null)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition active:scale-[0.99] ${
            activeGitRepoRoot === null
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
          }`}
          title={t('rightSidebar.allRepositories')}
        >
          <RiGitBranch size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{t('rightSidebar.allRepositories')}</span>
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{changedFiles.size}</span>
        </button>
        {changedRepoSummaries.map((repo) => (
          <button
            key={repo.root}
            type="button"
            onClick={() => setActiveGitRepoRoot(repo.root)}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition active:scale-[0.99] ${
              activeGitRepoRoot === repo.root
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
            }`}
            title={repo.label}
          >
            <RiGitBranch size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block break-all text-[11px] font-semibold leading-snug">{getPathBasename(repo.label)}</span>
              <span className="block break-all text-[10px] leading-snug text-muted-foreground/75">{repo.label}</span>
            </span>
            <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${repo.count > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>{repo.count}</span>
          </button>
        ))}
        </div>
      </div>
    );
  }

  function renderMobileRepoSwitcher() {
    if (!isMobile || !diffPaneActive || changedRepoSummaries.length <= 1) return null;
    const label = activeGitRepoSwitcherItem?.label ?? t('rightSidebar.allRepositories');
    const count = activeGitRepoSwitcherItem?.count ?? changedFiles.size;
    return (
      <>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-drawer-panel px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <button
            type="button"
            onPointerDown={handleRepoSwitcherPointerDown}
            onPointerUp={handleRepoSwitcherPointerUp}
            onPointerCancel={() => { repoSwitcherPointerRef.current = null; }}
            className="pointer-events-auto flex min-h-11 w-full touch-pan-y items-center gap-2 rounded-xl border border-border/20 bg-surface-elevated px-3 py-2 text-left shadow-2xl active:scale-[0.99]"
            title={label}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground">
              <RiGitBranch size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-foreground">{getPathBasename(label) || label}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{label}</span>
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${count > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>{count}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{activeGitRepoIndex + 1}/{gitRepoSwitcherItems.length}</span>
          </button>
        </div>
        {rightSidebarRepoPickerOpen && (
          <div className="fixed inset-0 z-drawer-backdrop bg-[var(--app-backdrop)]" onClick={onCloseRightSidebarRepoPicker}>
            <div
              className="fixed inset-x-0 bottom-0 z-drawer-panel max-h-[72vh] overflow-hidden rounded-t-2xl border-t border-border/20 bg-surface-elevated shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border/15 px-4 py-3">
                <div className="text-sm font-semibold text-foreground">Repositories</div>
                <button
                  type="button"
                  onClick={onCloseRightSidebarRepoPicker}
                  className="rounded-full bg-surface-2 p-1.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                  aria-label={t('rightSidebar.close')}
                >
                  <RiCloseLine size={16} />
                </button>
              </div>
              <div className="max-h-[calc(72vh-3.25rem)] overflow-y-auto overscroll-contain px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
                {gitRepoSwitcherItems.map((repo) => {
                  const selected = (repo.root ?? null) === activeGitRepoRoot;
                  return (
                    <button
                      key={repo.root ?? 'all'}
                      type="button"
                      onClick={() => {
                        selectGitRepoRoot(repo.root);
                        onCloseRightSidebarRepoPicker?.();
                      }}
                      className={`mb-1 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition active:scale-[0.99] ${
                        selected ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                      }`}
                      title={repo.label}
                    >
                      <RiGitBranch size={14} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-all text-[13px] font-semibold leading-snug">{getPathBasename(repo.label) || repo.label}</span>
                        <span className="block break-all text-[11px] leading-snug text-muted-foreground/75">{repo.label}</span>
                        {repo.branch && <span className="mt-1 block truncate text-[10px] text-muted-foreground/70">{repo.branch}</span>}
                      </span>
                      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${repo.count > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>{repo.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  function renderChangeRow(entry: [string, GitChangedFile], options: { compact: boolean; expandable?: boolean }) {
    const [, file] = entry;
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);
    const display = getRelativeDisplayPath(absolutePath, repoRoot ?? rootPath);
    const selectionPath = getChangedFileSelectionPath(file);
    const isExpanded = expandedDiffFiles.has(selectionPath);
    const isSelected = selectedFilePath === file.path || selectedFilePath === absolutePath;
    const referenceKey = `path:${absolutePath}`;
    const referenceInserted = insertedReferenceKey === referenceKey;
    const referenceCopied = copiedReferenceKey === referenceKey;
    const actions = buildGitActionButtons(file);
    const busyPath = getChangedFileBusyPath(file);
    if (!options.expandable) {
      return (
        <div
          key={getChangedFileKey(file)}
          className={`group rounded-lg px-2 py-1.5 transition ${
            isSelected
              ? 'bg-surface-elevated text-foreground'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
          }`}
          title={absolutePath}
        >
          <button
            type="button"
            onClick={() => selectDiffFile(selectionPath)}
            className="flex w-full items-center gap-2 text-left active:scale-[0.99]"
          >
            <ChangeBadge status={file.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium">{display.name}</span>
              {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
              {file.oldPath && <span className="block truncate text-[10px] text-muted-foreground/60">{t('rightSidebar.changedFromPath', { path: file.oldPath })}</span>}
            </span>
          </button>
          <div className="mt-1 flex items-center justify-between gap-1 pl-6">
            <GitActionChips actions={actions} running={runningGitAction} completed={completedGitAction?.path === busyPath ? completedGitAction : null} />
            <button
              type="button"
              onClick={() => insertPathReference(absolutePath, referenceKey)}
              {...getReferenceLongPressHandlers(getPathReferenceText(absolutePath), referenceKey)}
              className={`ml-auto inline-flex h-6 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold opacity-100 transition active:scale-95 md:opacity-0 md:group-hover:opacity-100 ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
              title={t('rightSidebar.insertThisFile')}
            >
              {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertFileRef')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <section
        key={getChangedFileKey(file)}
        className={`relative scroll-mt-2 overflow-hidden rounded-xl border transition ${
          isExpanded
            ? 'border-primary/25 bg-surface-elevated shadow-sm'
            : 'border-border/15 bg-surface hover:border-border/30'
        }`}
      >
        <div
          className={`sticky -top-px z-20 flex w-full items-center gap-1 rounded-t-xl ${
            isExpanded ? 'border-b border-border/15 bg-surface-elevated shadow-sm' : ''
          }`}
        >
          <button
            type="button"
            onClick={() => toggleDiffFile(selectionPath)}
            aria-expanded={isExpanded}
            className="group flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2.5 text-left transition active:scale-[0.99]"
            title={absolutePath}
          >
            <span className="shrink-0 text-muted-foreground transition-transform">
              {isExpanded ? <RiChevronDown size={15} /> : <RiChevronRight size={15} />}
            </span>
            <ChangeBadge status={file.status} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] ${isSelected || isExpanded ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>{display.name}</span>
              {display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
              {file.oldPath && <span className="block truncate text-[10px] text-muted-foreground/60">{t('rightSidebar.changedFromPath', { path: file.oldPath })}</span>}
            </span>
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              insertPathReference(absolutePath, referenceKey);
            }}
            {...getReferenceLongPressHandlers(getPathReferenceText(absolutePath), referenceKey)}
            className={`mr-2 inline-flex h-7 min-w-10 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold transition active:scale-95 sm:h-6 sm:min-w-8 md:opacity-0 md:group-hover:opacity-100 ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
            title={t('rightSidebar.insertThisFile')}
          >
            {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertFileRef')}
          </button>
        </div>
        {actions.length > 0 && (
          <div className="flex border-t border-border/10 px-2 py-1.5">
            <GitActionChips actions={actions} running={runningGitAction} completed={completedGitAction?.path === busyPath ? completedGitAction : null} />
          </div>
        )}
        {isExpanded && (
          <div>
            <DiffViewer
              active={diffPaneActive}
              repoRoot={repoRoot}
              filePath={file.path}
              changedFile={file}
              wrap={diffWrap}
              showScrollHint={!diffWrap}
              reloadKey={diffRefreshKey}
              embedded
              onInsertDiffReference={insertContextText}
              onReferenceCopied={markReferenceCopied}
              insertedReferenceKey={insertedReferenceKey}
              copiedReferenceKey={copiedReferenceKey}
            />
          </div>
        )}
      </section>
    );
  }

  function renderChangeGroups(options: { compact: boolean; expandable?: boolean }) {
    return (
    <div className={options.expandable ? 'space-y-3 pt-2' : 'space-y-2'}>
      {filteredChangedFileGroups.map((group) => {
        const staged = countStagedChanges(group.files.map(([, file]) => file));
        const showRepoHeader = !activeGitRepoRoot && (filteredChangedFileGroups.length > 1 || group.label !== rootName);
        const collapsed = Boolean(group.root && collapsedGitRepoGroups.has(group.root));
        // Rounded cards with hover/expanded child backgrounds must clip their
        // contents; otherwise collapsed headers visually cover the corner radius.
        return (
          <section key={group.root ?? group.label} className={showRepoHeader ? 'overflow-hidden rounded-lg border border-border/15 bg-surface/60' : ''}>
            {showRepoHeader && (
              <button
                type="button"
                onClick={() => toggleGitRepoGroup(group.root)}
                aria-expanded={!collapsed}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-surface-2 active:scale-[0.99] ${collapsed ? 'rounded-lg' : 'rounded-t-lg border-b border-border/10'}`}
              >
                <span className="shrink-0 text-muted-foreground">
                  {collapsed ? <RiChevronRight size={13} /> : <RiChevronDown size={13} />}
                </span>
                <RiGitBranch size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-foreground">{group.label}</span>
                  {group.branch && <span className="block truncate text-[10px] text-muted-foreground">{group.branch}</span>}
                </span>
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.files.length}</span>
                {staged > 0 && <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{staged}</span>}
                {group.root && (
                  <>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        runRepoGitAction('stage-all', group.root, group.label);
                      }}
                      disabled={Boolean(runningGitAction)}
                      className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                      title={t('rightSidebar.stageAll')}
                    >
                      {t('rightSidebar.stageAll')}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        runRepoGitAction('stash-all', group.root, group.label);
                      }}
                      disabled={Boolean(runningGitAction)}
                      className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                      title={t('rightSidebar.stashAll')}
                    >
                      {t('rightSidebar.stashAll')}
                    </button>
                  </>
                )}
              </button>
            )}
            {!collapsed && (
              <div className={options.expandable ? 'space-y-1.5 bg-surface/60 p-2' : showRepoHeader ? 'space-y-px bg-surface/60 p-1.5' : 'space-y-px'}>
                {group.files.map((entry) => renderChangeRow(entry, options))}
              </div>
            )}
          </section>
        );
      })}
    </div>
    );
  }

  const canPull = Boolean(!runningGitAction && (gitContext?.upstream || (pushRemote.trim() && pushBranch.trim())));
  const canPush = Boolean(!runningGitAction && (gitContext?.upstream || (pushRemote.trim() && pushBranch.trim())));
  const canSwitchBranch = Boolean(!runningGitAction && switchBranch.trim() && switchBranch.trim() !== gitContext?.branch);

  const filteredChangedFiles = useMemo(() => {
    const query = deferredFileQuery.trim().toLowerCase();
    const entries = Array.from(changedFiles.entries())
      .filter(([, file]) => !activeGitRepoRoot || getChangedFileRepoRoot(file, rootPath) === activeGitRepoRoot)
      .sort(([a], [b]) => a.localeCompare(b));
    if (!query) return entries;
    return entries.filter(([path, file]) => `${path} ${file.path} ${file.status} ${file.repoRelativeRoot ?? ''} ${file.repoName ?? ''}`.toLowerCase().includes(query));
  }, [activeGitRepoRoot, changedFiles, deferredFileQuery, rootPath]);

  const selectedChangedFile = useMemo(() => {
    if (!selectedFilePath) return null;
    return Array.from(changedFiles.values()).find((file) => (
      file.path === selectedFilePath || file.absolutePath === selectedFilePath
    )) ?? null;
  }, [changedFiles, selectedFilePath]);

  const filteredChangedFileGroups = useMemo(() => {
    const groups = new Map<string, { root: string | null; label: string; branch?: string | null; files: Array<[string, GitChangedFile]> }>();
    for (const entry of filteredChangedFiles) {
      const [, file] = entry;
      const repoRoot = getChangedFileRepoRoot(file, rootPath);
      const label = getChangedFileRepoLabel(file) || rootName;
      const key = repoRoot ?? label;
      const repo = repoRoot ? gitRepositoryByRoot.get(repoRoot) : undefined;
      const group = groups.get(key) ?? { root: repoRoot, label, branch: repo?.context?.branch, files: [] };
      group.files.push(entry);
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.label === rootName) return -1;
      if (b.label === rootName) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [filteredChangedFiles, gitRepositoryByRoot, rootName, rootPath]);

  const gitContextText = useMemo(() => {
    if (!gitContext?.available) return '';
    const changed = (gitContext.changedFiles ?? []).map((file) => `- ${file.status} ./${file.path}`).join('\n');
    const commits = (gitContext.recentCommits ?? []).map((commit) => `- ${commit}`).join('\n');
    return [
      `Git root: ${gitContext.root ?? rootPath ?? ''}`,
      `Branch: ${gitContext.branch ?? '(detached or unknown)'}`,
      changed ? `Changed files:\n${changed}` : 'Changed files: none',
      commits ? `Recent commits:\n${commits}` : '',
    ].filter(Boolean).join('\n\n');
  }, [gitContext, rootPath]);

  const gitContextInputText = useMemo(() => {
    if (!gitContext?.available) return '';
    const changed = (gitContext.changedFiles ?? [])
      .slice(0, 20)
      .map((file) => `${file.status} ./${file.path}`)
      .join('; ');
    const more = (gitContext.changedFiles?.length ?? 0) > 20 ? '; ...' : '';
    return [
      `Git root: ${gitContext.root ?? rootPath ?? ''}`,
      `branch: ${gitContext.branch ?? 'unknown'}`,
      changed ? `changed files: ${changed}${more}` : 'changed files: none',
    ].join('; ') + ' ';
  }, [gitContext, rootPath]);

  const insertGitContext = useCallback(() => {
    if (!gitContextInputText) return;
    insertContextText(t('rightSidebar.gitInfo'), gitContextInputText, gitContextReferenceKey);
    if (!push) onClose();
  }, [gitContextInputText, insertContextText, onClose, push, t]);

  const selectDiffFile = useCallback((path: string | null) => {
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const toggleDiffFile = useCallback((path: string) => {
    setExpandedDiffFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    selectFile(path);
    setRightTab('diff');
  }, [selectFile, setRightTab]);

  const toggleGitRepoGroup = useCallback((repoRoot: string | null) => {
    if (!repoRoot) return;
    setCollapsedGitRepoGroups((current) => {
      const next = new Set(current);
      if (next.has(repoRoot)) next.delete(repoRoot);
      else next.add(repoRoot);
      return next;
    });
  }, []);

  const runSidebarGitAction = useCallback(async (request: GitActionRequest, label: string, pathForBusy?: string): Promise<boolean> => {
    setGitActionError(null);
    setCompletedGitAction(null);
    setRunningGitAction({ action: request.action, path: pathForBusy });
    try {
      const result = await runGitAction(request);
      const refreshedBundle = rootPath
        ? await getGitBundle(rootPath, undefined, { includeNested: true, refresh: true }).catch(() => result.bundle)
        : result.bundle;
      applyGitBundle(refreshedBundle, { reloadDiff: true });
      const completedAction = { action: request.action, path: pathForBusy, label };
      setCompletedGitAction(completedAction);
      window.setTimeout(() => setCompletedGitAction((current) => (
        current?.action === completedAction.action && current.path === completedAction.path ? null : current
      )), 1400);
      setConfirmGitAction(null);
      return true;
    } catch (err) {
      setCompletedGitAction(null);
      setGitActionError(t('rightSidebar.gitActionFailed', { message: err instanceof Error ? err.message : 'Unknown error' }));
      return false;
    } finally {
      setRunningGitAction(null);
    }
  }, [applyGitBundle, rootPath, t]);

  const runRepoGitAction = useCallback((action: 'stage-all' | 'stash-all', repoRoot: string | null, repoLabel: string) => {
    if (!repoRoot) return;
    if (action === 'stage-all') {
      void runSidebarGitAction({ action: 'stage-all', cwd: repoRoot }, t('rightSidebar.stageAll'), `repo:${repoRoot}`);
      return;
    }
    setConfirmGitAction({ kind: 'stash-all', repoRoot, repoLabel });
  }, [runSidebarGitAction, t]);

  const selectGitRepoByIndex = useCallback((index: number) => {
    if (gitRepoSwitcherItems.length === 0) return;
    const wrapped = (index + gitRepoSwitcherItems.length) % gitRepoSwitcherItems.length;
    setActiveGitRepoRoot(gitRepoSwitcherItems[wrapped]?.root ?? null);
    selectDiffFile(null);
  }, [gitRepoSwitcherItems, selectDiffFile]);

  const selectGitRepoRoot = useCallback((repoRoot: string | null) => {
    setActiveGitRepoRoot(repoRoot);
    selectDiffFile(null);
  }, [selectDiffFile]);

  const handleRepoSwitcherPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    repoSwitcherPointerRef.current = { startX: event.clientX, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleRepoSwitcherPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const start = repoSwitcherPointerRef.current;
    repoSwitcherPointerRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = event.clientX - start.startX;
    if (Math.abs(delta) < 36) {
      onOpenRightSidebarRepoPicker?.();
      return;
    }
    selectGitRepoByIndex(activeGitRepoIndex + (delta < 0 ? 1 : -1));
  }, [activeGitRepoIndex, onOpenRightSidebarRepoPicker, selectGitRepoByIndex]);

  const handleSwitchBranch = useCallback(async () => {
    if (!rootPath) return;
    const branch = switchBranch.trim();
    if (!branch || branch === gitContext?.branch) return;
    await runSidebarGitAction({ action: 'switch-branch', cwd: rootPath, branch }, t('rightSidebar.switchBranch'));
  }, [gitContext?.branch, rootPath, runSidebarGitAction, switchBranch, t]);

  const handleQuickCommit = useCallback(async () => {
    if (!rootPath) return;
    const message = commitMessage.trim();
    if (!message) return;
    const ok = await runSidebarGitAction({ action: 'commit', cwd: rootPath, message }, t('rightSidebar.commitChanges'));
    if (ok) setCommitMessage('');
  }, [commitMessage, rootPath, runSidebarGitAction, t]);

  const handleQuickPush = useCallback(async () => {
    if (!rootPath) return;
    const remote = pushRemote.trim();
    const branch = pushBranch.trim();
    await runSidebarGitAction({
      action: 'push',
      cwd: rootPath,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    }, t('rightSidebar.pushChanges'));
  }, [pushBranch, pushRemote, rootPath, runSidebarGitAction, t]);

  const handleQuickPull = useCallback(async () => {
    if (!rootPath) return;
    const remote = pushRemote.trim();
    const branch = pushBranch.trim();
    await runSidebarGitAction({
      action: 'pull',
      cwd: rootPath,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    }, t('rightSidebar.pullChanges'));
  }, [pushBranch, pushRemote, rootPath, runSidebarGitAction, t]);

  const commitActionCompleted = completedGitAction?.action === 'commit';
  const switchBranchActionCompleted = completedGitAction?.action === 'switch-branch';
  const pullActionCompleted = completedGitAction?.action === 'pull';
  const pushActionCompleted = completedGitAction?.action === 'push';
  const effectiveGitQuickActionsOpen = gitPaneActive || gitQuickActionsOpen;

  const gitQuickActionsPanel = gitContext?.available && rootPath ? (
    <div className={effectiveGitQuickActionsOpen ? 'overflow-visible' : 'overflow-hidden'}>
      <button
        type="button"
        onClick={() => {
          if (gitPaneActive) return;
          setGitQuickActionsOpen((open) => {
            const next = !open;
            if (next && !gitDetailsLoaded && !gitDetailsLoading) void loadGitDetails(rootPath);
            return next;
          });
        }}
        aria-expanded={effectiveGitQuickActionsOpen}
        className={`group flex w-full items-center gap-2 px-1 py-1.5 text-left transition ${gitPaneActive ? 'cursor-default' : 'rounded-lg hover:bg-surface-2 active:scale-[0.99]'}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground group-hover:text-foreground">
          <RiGitBranch size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
          {t('rightSidebar.gitQuickActions')}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${changedSummary.staged > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>
            {gitDetailsLoading && <RiLoader size={10} className="animate-spin" />}
            {changedSummary.staged > 0 ? t('rightSidebar.stagedCount', { count: changedSummary.staged }) : t('rightSidebar.noStagedChangesShort')}
          </span>
          {!gitPaneActive && (
            <span className={`flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition group-hover:bg-surface-elevated group-hover:text-foreground ${effectiveGitQuickActionsOpen ? 'rotate-90' : ''}`}>
              <RiChevronRight size={13} />
            </span>
          )}
        </span>
      </button>
      {effectiveGitQuickActionsOpen && (
        <div className="space-y-0">
          <div className="border-b border-border/10 px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.branchSectionTitle')}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{gitContext.branch ?? 'HEAD'}</div>
              </div>
              <button
                type="button"
                onClick={() => void handleSwitchBranch()}
                disabled={!canSwitchBranch}
                className={`relative inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${switchBranchActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                title={t('rightSidebar.switchBranch')}
              >
                <span className={runningGitAction?.action === 'switch-branch' || switchBranchActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.switchBranch')}</span>
                {runningGitAction?.action === 'switch-branch' && <RiLoader size={12} className="absolute animate-spin" />}
                {switchBranchActionCompleted && runningGitAction?.action !== 'switch-branch' && <span className="absolute">✓</span>}
              </button>
            </div>
            <GitTargetPicker
              label={t('rightSidebar.currentBranchLabel')}
              value={switchBranch}
              options={switchBranchOptions}
              placeholder={t('rightSidebar.switchBranchPlaceholder')}
              searchPlaceholder={t('rightSidebar.switchBranchSearchPlaceholder')}
              emptyText={t('rightSidebar.switchNoBranches')}
              disabled={Boolean(runningGitAction)}
              onChange={setSwitchBranch}
            />
          </div>
          <div className="border-b border-border/10 px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.commitSectionTitle')}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {changedSummary.staged > 0 ? t('rightSidebar.commitReadyHint', { count: changedSummary.staged }) : t('rightSidebar.commitNeedsStaged')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleQuickCommit()}
                disabled={Boolean(runningGitAction) || changedSummary.staged === 0 || !commitMessage.trim()}
                className={`relative inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition active:scale-95 ${commitActionCompleted ? 'bg-accent/10 text-accent disabled:bg-accent/10 disabled:text-accent' : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-surface-2 disabled:text-muted-foreground'} disabled:cursor-not-allowed`}
                title={changedSummary.staged === 0 ? t('rightSidebar.commitNeedsStaged') : t('rightSidebar.commitChanges')}
              >
                <span className={runningGitAction?.action === 'commit' || commitActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.commitChanges')}</span>
                {runningGitAction?.action === 'commit' && <RiLoader size={12} className="absolute animate-spin" />}
                {commitActionCompleted && runningGitAction?.action !== 'commit' && <span className="absolute">✓</span>}
              </button>
            </div>
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleQuickCommit();
                }
              }}
              placeholder={t('rightSidebar.commitMessagePlaceholder')}
              disabled={Boolean(runningGitAction)}
              className="w-full rounded-md border border-border/15 bg-surface-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary/35 focus:ring-1 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-60"
              maxLength={300}
            />
          </div>
          <div className="px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.pushSectionTitle')}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleQuickPull()}
                  disabled={!canPull}
                  className={`relative inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${pullActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                  title={t('rightSidebar.pullChanges')}
                >
                  <span className={runningGitAction?.action === 'pull' || pullActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.pullChanges')}</span>
                  {runningGitAction?.action === 'pull' && <RiLoader size={12} className="absolute animate-spin" />}
                  {pullActionCompleted && runningGitAction?.action !== 'pull' && <span className="absolute">✓</span>}
                </button>
                <button
                  type="button"
                  onClick={() => void handleQuickPush()}
                  disabled={!canPush}
                  className={`relative inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${pushActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                  title={t('rightSidebar.pushChanges')}
                >
                  <span className={runningGitAction?.action === 'push' || pushActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.pushChanges')}</span>
                  {runningGitAction?.action === 'push' && <RiLoader size={12} className="absolute animate-spin" />}
                  {pushActionCompleted && runningGitAction?.action !== 'push' && <span className="absolute">✓</span>}
                </button>
              </div>
            </div>
            <div
              className={`mb-2 flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] ${pushSyncInfo.className}`}
              title={gitContext.upstream ?? undefined}
            >
              <span className="truncate font-medium">{pushSyncInfo.text}</span>
              {gitContext.upstream && <span className="shrink-0 truncate text-[10px] opacity-75">{gitContext.upstream}</span>}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <GitTargetPicker
                label={t('rightSidebar.pushRemoteLabel')}
                value={pushRemote}
                options={pushRemoteOptions}
                placeholder={t('rightSidebar.pushRemotePlaceholder')}
                searchPlaceholder={t('rightSidebar.pushRemoteSearchPlaceholder')}
                emptyText={t('rightSidebar.pushNoRemotes')}
                disabled={Boolean(runningGitAction)}
                onChange={setPushRemote}
              />
              <GitTargetPicker
                label={t('rightSidebar.pushBranchLabel')}
                value={pushBranch}
                options={pushBranchOptions}
                placeholder={t('rightSidebar.pushBranchPlaceholder', { branch: gitContext.branch ?? 'HEAD' })}
                searchPlaceholder={t('rightSidebar.pushBranchSearchPlaceholder')}
                emptyText={t('rightSidebar.pushNoBranches')}
                disabled={Boolean(runningGitAction)}
                onChange={setPushBranch}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null;

  const buildGitActionButtons = useCallback((file: GitChangedFile): GitActionButton[] => {
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    if (!repoRoot) return [];
    const busyPath = getChangedFileBusyPath(file);
    const buttons: GitActionButton[] = [];
    if (file.canStage) {
      buttons.push({
        key: 'stage-file',
        label: t('rightSidebar.stageFile'),
        onClick: () => void runSidebarGitAction({ action: 'stage-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.stageFile'), busyPath),
      });
    }
    if (file.canUnstage) {
      buttons.push({
        key: 'unstage-file',
        label: t('rightSidebar.unstageFile'),
        onClick: () => void runSidebarGitAction({ action: 'unstage-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.unstageFile'), busyPath),
      });
    }
    if (file.canStash) {
      buttons.push({
        key: 'stash-file',
        label: t('rightSidebar.stashFile'),
        onClick: () => void runSidebarGitAction({ action: 'stash-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.stashFile'), busyPath),
      });
    }
    if (file.canRestoreWorktree) {
      buttons.push({
        key: 'restore-worktree-file',
        label: t('rightSidebar.restoreFile'),
        destructive: true,
        onClick: () => setConfirmGitAction({ kind: 'restore', file, phrase: '' }),
      });
    }
    return buttons;
  }, [rootPath, runSidebarGitAction, t]);

  const closeFilePreview = useCallback(() => {
    if (rightSidebarFilePreviewOpen) {
      onCloseRightSidebarFilePreview?.();
      return;
    }
    setMobileFilePreviewOpen(false);
    setLineRange(null);
  }, [onCloseRightSidebarFilePreview, rightSidebarFilePreviewOpen]);

  const fileExplorerNavigation = (
    <div className="sticky top-0 z-10 border-b border-border/15 bg-surface/95 px-2.5 py-1.5 backdrop-blur">
      <div className="flex min-h-9 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <button
          type="button"
          onClick={goToExplorerParent}
          disabled={!explorerParentPath}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.parentFolder')}
          title={t('rightSidebar.parentFolder')}
        >
          <RiArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={goToProjectRoot}
          disabled={!rootPath || explorerRoot === rootPath}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.backToProjectRoot')}
          title={t('rightSidebar.backToProjectRoot')}
        >
          <RiHome size={14} />
        </button>
        <button
          type="button"
          onClick={refreshExplorerRoot}
          disabled={!fileTreeRoot}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.refreshFiles')}
          title={fileWatchError ? t('rightSidebar.fileWatchUnavailable', { message: fileWatchError }) : t('rightSidebar.refreshFiles')}
        >
          <RiRefresh size={13} />
        </button>
        <button
          type="button"
          onClick={togglePinnedExplorerRoot}
          disabled={!canPinFileTreeRoot}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-35 active:scale-95 ${fileTreeRootPinned ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          aria-label={fileTreeRootPinned ? t('rightSidebar.unpinCurrentFolder') : t('rightSidebar.pinCurrentFolder')}
          title={fileTreeRootPinned ? t('rightSidebar.unpinCurrentFolder') : t('rightSidebar.pinCurrentFolder')}
        >
          {fileTreeRootPinned ? <RiPinOff size={13} /> : <RiPin size={13} />}
        </button>
        <button
          type="button"
          onClick={toggleShowHiddenFiles}
          aria-pressed={showHiddenFiles}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition active:scale-95 ${showHiddenFiles ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          aria-label={showHiddenFiles ? t('rightSidebar.hideHiddenFiles') : t('rightSidebar.showHiddenFiles')}
          title={showHiddenFiles ? t('rightSidebar.hideHiddenFiles') : t('rightSidebar.showHiddenFiles')}
        >
          {showHiddenFiles ? <RiEye size={13} /> : <RiEyeOff size={13} />}
        </button>
        <div className="mx-1 hidden h-4 w-px shrink-0 bg-border/20 sm:block" />
        <div className="min-w-0 flex-1 basis-full pt-0.5 sm:basis-0 sm:pt-0" title={fileTreeRoot ?? undefined}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {t('rightSidebar.browsingLocation')}
              </span>
              <span className="truncate text-[12px] font-medium text-foreground">{explorerName}</span>
            </div>
              <button
                type="button"
                onClick={() => fileTreeRoot && insertPathReference(fileTreeRoot, fileTreeRootReferenceKey ?? undefined)}
                disabled={!fileTreeRoot}
                {...(fileTreeRoot && fileTreeRootReferenceKey ? getReferenceLongPressHandlers(getPathReferenceText(fileTreeRoot), fileTreeRootReferenceKey) : {})}
                className={`inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 active:scale-95 ${
                fileTreeRootReferenceKey && (insertedReferenceKey === fileTreeRootReferenceKey || copiedReferenceKey === fileTreeRootReferenceKey)
                  ? 'bg-surface-elevated text-foreground'
                  : 'bg-primary/10 text-primary hover:bg-primary/20'
              }`}
                aria-label={t('rightSidebar.insertCurrentFolder')}
                title={t('rightSidebar.insertCurrentFolder')}
              >
                <RiLink size={12} />
              <span>{fileTreeRootReferenceKey && copiedReferenceKey === fileTreeRootReferenceKey ? t('rightSidebar.copied') : fileTreeRootReferenceKey && insertedReferenceKey === fileTreeRootReferenceKey ? t('rightSidebar.inserted') : t('rightSidebar.insertCurrentFolderShort')}</span>
              </button>
          </div>
          {fileTreeRoot && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">
              {fileTreeRoot}
            </div>
          )}
        </div>
        {browsingOutsideProject && (
          <span
            className="hidden shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline-flex"
            title={t('rightSidebar.browsingOutsideProjectHint')}
          >
            {t('rightSidebar.browsingOutsideProject')}
          </span>
        )}
      </div>
      {rootPath && (pinnedExplorerRoots.length > 0 || browsingOutsideProject) && (
        <div className="mt-1 flex items-center gap-1 overflow-x-auto pb-0.5 text-[11px]">
          <span className="shrink-0 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('rightSidebar.pinnedFolders')}
          </span>
          <button
            type="button"
            onClick={goToProjectRoot}
            className={`inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium transition active:scale-95 ${fileTreeRoot === rootPath ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
            title={rootPath}
          >
            <RiHome size={10} className="shrink-0" />
            <span className="truncate">{rootName}</span>
          </button>
          {pinnedExplorerRoots.map((entry) => {
            const path = entry.path;
            const isFile = entry.kind === 'file';
            const active = isFile ? selectedFilePath === path : fileTreeRoot === path;
            return (
              <span key={path} className={`group inline-flex max-w-[12rem] shrink-0 items-center rounded-full transition ${active ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`} title={path}>
                <button
                  type="button"
                  onClick={() => (isFile ? handleFileSelect(path) : setExplorerRoot(path))}
                  className="inline-flex min-w-0 items-center gap-1 px-2 py-0.5 font-medium active:scale-95"
                >
                  {isFile ? <RiFileText size={10} className="shrink-0" /> : <RiPin size={10} className="shrink-0" />}
                  <span className="truncate">{getPathBasename(path)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => unpinExplorerRoot(path)}
                  className="mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                  aria-label={t('rightSidebar.unpinFolder', { name: getPathBasename(path) })}
                  title={t('rightSidebar.unpinFolder', { name: getPathBasename(path) })}
                >
                  <RiCloseLine size={9} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );

  const diffRefreshButton = gitContext?.available ? (
    <button
      type="button"
      onClick={() => void refreshGitState()}
      disabled={gitBundleLoading}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
      aria-label={t('rightSidebar.refreshGit')}
      title={t('rightSidebar.refreshGit')}
    >
      <RiRefresh size={13} className={gitBundleLoading ? 'animate-spin' : ''} />
    </button>
  ) : null;

  return (
    <Sidebar
      side="right"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {/* Header — single compact row + tab bar. The header is laid out as a
          fixed-shape column: every conditional block (search, chip row,
          recent refs) reserves a minimum slot so opening/closing them never
          reflows the content below. The toast is absolutely positioned
          inside the header so its appearance doesn't push siblings. */}
      <div className="relative shrink-0 border-b border-border/15 bg-surface px-2 pt-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 px-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground" title={rootPath ?? undefined}>
                {rootName}
              </span>
              {gitContext?.available && gitContext.branch && (
                <span className="inline-flex items-center gap-0.5 truncate text-[11px] text-muted-foreground" title={gitContext.branch}>
                  <RiGitBranch size={10} className="shrink-0" />
                  <span className="truncate max-w-[7rem]">{gitContext.branch}</span>
                </span>
              )}
              {changedFiles.size > 0 && (
                <span className="text-[11px] text-accent">{changedFiles.size}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRightSearchOpen(!searchOpen)}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-label={t('rightSidebar.toggleSearch')}
            title={t('common.search')}
          >
            <RiSearch size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label={t('rightSidebar.close')}
          >
            <RiCloseLine size={14} />
          </button>
        </div>

        {searchOpen && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
              <RiSearch size={12} className="shrink-0" />
              <input
                data-right-search
                type="search"
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder={searchMode === 'content' ? t('rightSidebar.searchPlaceholderContent') : t('rightSidebar.filterChanges')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                enterKeyHint="search"
                spellCheck={false}
              />
              {/* Desktop keeps the mode switch compact and inline so it doesn't
                  add a second full-width row. Mobile uses the larger segmented
                  control below where tap targets matter more. */}
              {!isMobile && (
                <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface/70 p-0.5 text-[10px] font-medium">
                  <button
                    type="button"
                    onClick={() => setSearchMode('name')}
                    aria-pressed={searchMode === 'name'}
                    className={`rounded-full px-2 py-0.5 transition active:scale-95 ${searchMode === 'name' ? 'bg-primary/15 text-primary' : 'text-muted-foreground/80 hover:text-foreground'}`}
                  >
                    {t('rightSidebar.searchModeName')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchMode('content')}
                    aria-pressed={searchMode === 'content'}
                    className={`rounded-full px-2 py-0.5 transition active:scale-95 ${searchMode === 'content' ? 'bg-primary/15 text-primary' : 'text-muted-foreground/80 hover:text-foreground'}`}
                  >
                    {t('rightSidebar.searchModeContent')}
                  </button>
                </div>
              )}
              {fileQuery && (
                <button
                  type="button"
                  onClick={() => setFileQuery('')}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                  aria-label={t('rightSidebar.clearSearch')}
                >
                  <RiCloseLine size={12} />
                </button>
              )}
            </div>
            {isMobile && (
            <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5 text-[11px] font-medium">
              <button
                type="button"
                onClick={() => setSearchMode('name')}
                aria-pressed={searchMode === 'name'}
                className={`flex-1 rounded-full px-2 py-1 transition active:scale-95 ${searchMode === 'name' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('rightSidebar.searchModeName')}
              </button>
              <button
                type="button"
                onClick={() => setSearchMode('content')}
                aria-pressed={searchMode === 'content'}
                className={`flex-1 rounded-full px-2 py-1 transition active:scale-95 ${searchMode === 'content' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('rightSidebar.searchModeContent')}
              </button>
            </div>
            )}
          </div>
        )}

        {/* Changed-file mini summary chips (only when there are changes) */}
        {changedFiles.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] font-medium">
            {changedSummary.modified > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-hunk-accent)]">{changedSummary.modified}M</span>
            )}
            {changedSummary.added > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">+{changedSummary.added}</span>
            )}
            {changedSummary.deleted > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-delete-strong)]">-{changedSummary.deleted}</span>
            )}
            {changedSummary.renamed > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground">{changedSummary.renamed}R</span>
            )}
            {changedSummary.copied > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.copied}C</span>
            )}
            {changedSummary.untracked > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.untracked}U</span>
            )}
            {changedSummary.conflicted > 0 && (
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{changedSummary.conflicted}!</span>
            )}
            {changedSummary.other > 0 && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground">{changedSummary.other}?</span>
            )}
            {changedSummary.staged > 0 && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">已暂存 {changedSummary.staged}</span>
            )}
            {gitContext?.available && rootPath && changedFiles.size > 0 && gitRepositories.length <= 1 && (
              <button
                type="button"
                onClick={() => void runSidebarGitAction({ action: 'stage-all', cwd: rootPath }, t('rightSidebar.stageAll'))}
                disabled={Boolean(runningGitAction)}
                className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                title={t('rightSidebar.stageAll')}
              >
                {t('rightSidebar.stageAll')}
              </button>
            )}
            {gitContext?.available && rootPath && changedFiles.size > 0 && gitRepositories.length <= 1 && (
              <button
                type="button"
                onClick={() => setConfirmGitAction({ kind: 'stash-all', repoRoot: rootPath, repoLabel: rootName })}
                disabled={Boolean(runningGitAction)}
                className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                title={t('rightSidebar.stashAll')}
              >
                {t('rightSidebar.stashAll')}
              </button>
            )}
            {gitContext?.available && (
              <>
                <button
                  type="button"
                  onClick={insertGitContext}
                  {...getReferenceLongPressHandlers(gitContextInputText.trimEnd(), gitContextReferenceKey)}
                  className={`ml-auto rounded-full px-2 py-0.5 font-medium ${insertedReferenceKey === gitContextReferenceKey || copiedReferenceKey === gitContextReferenceKey ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}
                  title={t('rightSidebar.insertGitContext')}
                >
                  {copiedReferenceKey === gitContextReferenceKey ? t('rightSidebar.copied') : insertedReferenceKey === gitContextReferenceKey ? t('rightSidebar.inserted') : t('rightSidebar.insertPreset', { label: t('rightSidebar.gitInfo') })}
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(gitContextText)}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                  title={t('rightSidebar.copyGitContext')}
                >
                  {t('common.copy')}
                </button>
              </>
            )}
          </div>
        )}

        {/* Tab bar — non-Git workspaces drop the Git/Changes tabs. On mobile
            (overlay preview) and wide (side-by-side preview) layouts the file
            browser fills the panel with no tab bar at all; only the medium
            desktop layout keeps a Files/Preview switch. */}
        {gitKnownUnavailable ? (
          !isMobile && !isWide ? (
            <div className="mt-2 grid grid-cols-2 gap-0.5 rounded-md bg-surface-2 p-0.5">
              <button
                type="button"
                onClick={() => setRightTab('files')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'files'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFolder size={12} />
                {t('rightSidebar.tabFiles')}
              </button>
              <button
                type="button"
                onClick={() => setRightTab('file')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'file'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFileText size={12} />
                {t('rightSidebar.tabPreview')}
              </button>
            </div>
          ) : null
        ) : (
          <div className={`mt-2 grid gap-0.5 rounded-md bg-surface-2 p-0.5 ${isMobile ? 'grid-cols-3' : isWide ? 'grid-cols-3' : 'grid-cols-4'}`}>
            <button
              type="button"
              onClick={() => setRightTab('git')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'git'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiGitBranch size={12} />
              {t('rightSidebar.tabGit')}
              {gitBundleLoading && effectiveRightTab === 'git' ? <RiLoader size={12} className="animate-spin text-muted-foreground" /> : null}
            </button>
            <button
              type="button"
              onClick={() => setRightTab('diff')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'diff'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiGitCompare size={12} />
              {t('rightSidebar.tabChanges')}
              {gitBundleLoading ? (
                <RiLoader size={12} className="animate-spin text-muted-foreground" />
              ) : changedFiles.size > 0 ? (
                <span className="text-[10px] text-accent">{changedFiles.size}</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setRightTab('files')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'files'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiFolder size={12} />
              {t('rightSidebar.tabFiles')}
            </button>
            {!isMobile && !isWide && (
              <button
                type="button"
                onClick={() => setRightTab('file')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'file'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFileText size={12} />
                {t('rightSidebar.tabPreview')}
              </button>
            )}
          </div>
        )}
        <div className="h-2" />

        {gitActionError && (
          <div className="pointer-events-none absolute right-3 top-10 z-20 max-w-[72%] rounded-lg bg-destructive/95 px-3 py-2 text-[11px] font-medium text-destructive-foreground shadow-md animate-fade-in">
            {gitActionError}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        <Pane active={gitPaneActive}>
          <div className="h-full overflow-y-auto overscroll-contain px-2 py-2">
            {gitQuickActionsPanel ? (
              gitQuickActionsPanel
            ) : gitBundleLoading ? (
              <GitChangesLoadingState slow={gitBundleSlow} />
            ) : gitBundleError ? (
              <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {rootPath ? t('rightSidebar.gitUnavailable') : t('fileTree.noWorkingDir')}
              </div>
            )}
          </div>
        </Pane>

        <Pane active={filesPaneActive}>
          {isWide ? (
            <div className="flex h-full min-h-0">
              <div
                ref={fileTreeScrollRef}
                onScroll={handleFileTreeScroll}
                className="shrink-0 overflow-y-auto overscroll-contain bg-surface"
                style={{ width: fileTreeWidthPx }}
              >
                {fileExplorerNavigation}
                <FileTree
                  rootPath={fileTreeRoot ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  getReferenceText={getPathReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  onDirectoryRoot={openDirectoryAsExplorerRoot}
                  onDirectoryPinToggle={togglePinnedDirectory}
                  onFilePinToggle={togglePinnedFile}
                  pinnedPaths={pinnedExplorerRootSet}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                  searchMode={searchMode}
                  onContentMatchSelect={handleContentMatchSelect}
                />
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('rightSidebar.resizeFileTree')}
                title={t('rightSidebar.resizeFileTree')}
                className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none border-l border-border/15 bg-surface"
                onPointerDown={startFileTreeResize}
                onPointerMove={handleFileTreeResizeMove}
                onPointerUp={stopFileTreeResize}
                onPointerCancel={stopFileTreeResize}
                onDoubleClick={() => {
                  setFileTreeWidthPx(DEFAULT_FILE_TREE_WIDTH_PX);
                  writeCache(FILE_TREE_WIDTH_STORAGE_KEY, DEFAULT_FILE_TREE_WIDTH_PX);
                }}
              >
                <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border/20 transition group-hover:bg-primary/45" />
              </div>
              <div className="min-w-0 flex-1 overflow-hidden bg-surface">
                <FilePreview
                  filePath={selectedFilePath}
                  onInsertReference={insertPathReference}
                  onInsertText={insertReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  isMobile={false}
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  scrollToLine={scrollToLine}
                  onScrollToLineHandled={() => setScrollToLine(null)}
                  markdownOutlineOpen={markdownOutlineOpen}
                  markdownOutlineCloseSignal={markdownOutlineCloseSignal}
                  onOpenMarkdownOutline={onOpenMarkdownOutline}
                  onCloseMarkdownOutline={onCloseMarkdownOutline}
                  markdownImageLightboxOpen={markdownImageLightboxOpen}
                  markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
                  onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
                  onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
                />
              </div>
            </div>
          ) : isMobile ? (
            <div className="relative h-full min-h-0 overflow-hidden">
              <div
                ref={fileTreeScrollRef}
                onScroll={handleFileTreeScroll}
                className={`h-full overflow-y-auto overscroll-contain bg-surface ${mobilePreviewActive ? 'hidden' : 'block'}`}
                aria-hidden={mobilePreviewActive}
              >
                {fileExplorerNavigation}
                <FileTree
                  rootPath={fileTreeRoot ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  getReferenceText={getPathReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  onDirectoryRoot={openDirectoryAsExplorerRoot}
                  onDirectoryPinToggle={togglePinnedDirectory}
                  onFilePinToggle={togglePinnedFile}
                  pinnedPaths={pinnedExplorerRootSet}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                  searchMode={searchMode}
                  onContentMatchSelect={handleContentMatchSelect}
                />
              </div>
              <div className={`h-full overflow-hidden bg-surface ${mobilePreviewActive ? 'block' : 'hidden'}`} aria-hidden={!mobilePreviewActive}>
                <FilePreview
                  filePath={selectedFilePath}
                  onInsertReference={insertPathReference}
                  onInsertText={insertReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  onClose={closeFilePreview}
                  isMobile
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  scrollToLine={scrollToLine}
                  onScrollToLineHandled={() => setScrollToLine(null)}
                  markdownOutlineOpen={markdownOutlineOpen}
                  markdownOutlineCloseSignal={markdownOutlineCloseSignal}
                  onOpenMarkdownOutline={onOpenMarkdownOutline}
                  onCloseMarkdownOutline={onCloseMarkdownOutline}
                  markdownImageLightboxOpen={markdownImageLightboxOpen}
                  markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
                  onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
                  onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
                />
              </div>
            </div>
          ) : (
            <div
              ref={fileTreeScrollRef}
              onScroll={handleFileTreeScroll}
              className="h-full overflow-y-auto overscroll-contain"
            >
              {fileExplorerNavigation}
              <FileTree
                rootPath={fileTreeRoot ?? ''}
                onFileSelect={handleFileSelect}
                onPathReference={insertPathReference}
                getReferenceText={getPathReferenceText}
                onReferenceCopied={markReferenceCopied}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
                onDirectoryRoot={openDirectoryAsExplorerRoot}
                onDirectoryPinToggle={togglePinnedDirectory}
                onFilePinToggle={togglePinnedFile}
                pinnedPaths={pinnedExplorerRootSet}
                selectedFilePath={selectedFilePath}
                query={deferredFileQuery}
                searchMode={searchMode}
                onContentMatchSelect={handleContentMatchSelect}
              />
            </div>
          )}
        </Pane>

        <Pane active={previewPaneActive} mounted={hasMountedPreviewPane}>
          <FilePreview
            filePath={selectedFilePath}
            onInsertReference={insertPathReference}
            onInsertText={insertReferenceText}
            onReferenceCopied={markReferenceCopied}
            isMobile={false}
            lineRange={lineRange}
            onLineRangeChange={setLineRange}
            insertedReferenceKey={insertedReferenceKey}
            copiedReferenceKey={copiedReferenceKey}
            scrollToLine={scrollToLine}
            onScrollToLineHandled={() => setScrollToLine(null)}
            markdownOutlineOpen={markdownOutlineOpen}
            markdownOutlineCloseSignal={markdownOutlineCloseSignal}
            onOpenMarkdownOutline={onOpenMarkdownOutline}
            onCloseMarkdownOutline={onCloseMarkdownOutline}
            markdownImageLightboxOpen={markdownImageLightboxOpen}
            markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
            onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
            onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
          />
        </Pane>

        <Pane active={diffPaneActive} mounted={hasMountedDiffPane}>
          {isWide ? (
            <div className="flex h-full min-h-0">
              {gitContext?.available && changedRepoSummaries.length > 1 && (
                <div className="w-[220px] min-w-[180px] shrink-0 overflow-y-auto overscroll-contain border-r border-border/15 bg-surface">
                  {renderGitRepoFilter()}
                </div>
              )}
              <div className="w-[320px] min-w-[260px] shrink-0 flex flex-col overflow-hidden border-r border-border/15">
                {gitContext?.available && (
                  <div className="shrink-0 border-b border-border/15">
                    <div className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      {changedFiles.size > 0 ? (
                        <button
                          type="button"
                          onClick={() => selectDiffFile(null)}
                          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                            selectedFilePath === null
                              ? 'bg-surface-elevated text-foreground'
                              : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                          }`}
                        >
                          {t('rightSidebar.allChanges')}
                        </button>
                      ) : (
                        <span className="px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          {t('rightSidebar.allChanges')}
                        </span>
                      )}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                        {diffRefreshButton}
                      </div>
                    </div>
                    {activeGitRepoSummary && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                        {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                        <button
                          type="button"
                          onClick={() => runRepoGitAction('stage-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                          disabled={Boolean(runningGitAction)}
                          className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                          title={t('rightSidebar.stageAll')}
                        >
                          {t('rightSidebar.stageAll')}
                        </button>
                        <button
                          type="button"
                          onClick={() => runRepoGitAction('stash-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                          disabled={Boolean(runningGitAction)}
                          className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                          title={t('rightSidebar.stashAll')}
                        >
                          {t('rightSidebar.stashAll')}
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                  {gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                    <GitChangesLoadingState slow={gitBundleSlow} />
                  ) : gitBundleError && changedFiles.size === 0 ? (
                    <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                  ) : changedFiles.size === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {t('rightSidebar.noChanges')}
                    </div>
                  ) : filteredChangedFiles.length === 0 ? (
                    <div className="bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground">
                      {t('rightSidebar.noMatchingChanges')}
                    </div>
                  ) : renderChangeGroups({ compact: true })}
                </div>
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <DiffViewer active={diffPaneActive} repoRoot={selectedChangedFile?.repoRoot} filePath={selectedChangedFile?.path ?? selectedFilePath} changedFile={selectedChangedFile} reloadKey={diffRefreshKey} onInsertDiffReference={insertContextText} onReferenceCopied={markReferenceCopied} insertedReferenceKey={insertedReferenceKey} copiedReferenceKey={copiedReferenceKey} />
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {gitContext?.available && (
                <div className="shrink-0 border-b border-border/15">
                  <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t('rightSidebar.allChanges')}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {filteredChangedFiles.length}/{changedFiles.size}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {diffRefreshButton}
                      <button
                        type="button"
                        onClick={() => setDiffWrap((prev) => !prev)}
                        aria-pressed={diffWrap}
                        title={t('rightSidebar.wrapLongLines')}
                        className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition active:scale-95 ${
                          diffWrap
                            ? 'bg-primary/15 text-primary'
                            : 'bg-surface-2 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className="font-mono text-[12px] leading-none">Aa</span>
                        <span>{diffWrap ? t('rightSidebar.wrapOn') : t('rightSidebar.wrapOff')}</span>
                      </button>
                    </div>
                  </div>
                  {activeGitRepoSummary && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                      {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stage-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                        title={t('rightSidebar.stageAll')}
                      >
                        {t('rightSidebar.stageAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stash-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                        title={t('rightSidebar.stashAll')}
                      >
                        {t('rightSidebar.stashAll')}
                      </button>
                    </div>
                  )}
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
                {gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                  <GitChangesLoadingState slow={gitBundleSlow} />
                ) : gitBundleError && changedFiles.size === 0 ? (
                  <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                ) : changedFiles.size === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noChanges')}
                  </div>
                ) : filteredChangedFiles.length === 0 ? (
                  <div className="bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noMatchingChanges')}
                  </div>
                ) : renderChangeGroups({ compact: false, expandable: true })}
              </div>
            </div>
          )}
        </Pane>
      </div>
        {renderMobileRepoSwitcher()}
        {confirmGitAction && (
          <div className="fixed inset-0 z-modal-panel bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={() => setConfirmGitAction(null)}>
            <div
              className="fixed inset-x-3 bottom-6 mx-auto max-w-md rounded-2xl border border-border/20 bg-surface-elevated p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-sm font-semibold text-foreground">
                {confirmGitAction.kind === 'restore' ? t('rightSidebar.confirmRestoreTitle') : t('rightSidebar.confirmStashAllTitle')}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {confirmGitAction.kind === 'restore'
                  ? t('rightSidebar.confirmRestoreDescription', { path: buildFileReference(confirmGitAction.file.absolutePath, rootPath) })
                  : t('rightSidebar.confirmStashAllDescription')}
              </div>
              {confirmGitAction.kind === 'restore' && (
                <input
                  value={confirmGitAction.phrase}
                  onChange={(event) => setConfirmGitAction({ ...confirmGitAction, phrase: event.target.value })}
                  placeholder={t('rightSidebar.confirmRestorePlaceholder')}
                  className="mt-3 w-full rounded-xl border border-border/20 bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  autoFocus
                />
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmGitAction(null)}
                  className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(runningGitAction) || (confirmGitAction.kind === 'restore' && confirmGitAction.phrase.trim() !== t('rightSidebar.confirmRestorePhrase'))}
                  onClick={() => {
                    if (confirmGitAction.kind === 'restore') {
                      const repoRoot = getChangedFileRepoRoot(confirmGitAction.file, rootPath);
                      if (!repoRoot) return;
                      void runSidebarGitAction({
                        action: 'restore-worktree-file',
                        cwd: repoRoot,
                        paths: [confirmGitAction.file.path],
                        confirm: { acknowledged: true, phrase: confirmGitAction.phrase },
                      }, t('rightSidebar.restoreFile'), getChangedFileBusyPath(confirmGitAction.file));
                    } else {
                      const repoRoot = confirmGitAction.repoRoot ?? rootPath;
                      if (!repoRoot) return;
                      void runSidebarGitAction({ action: 'stash-all', cwd: repoRoot }, t('rightSidebar.stashAll'), `repo:${repoRoot}`);
                    }
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    confirmGitAction.kind === 'restore'
                      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {runningGitAction ? t('rightSidebar.gitActionRunning') : t('rightSidebar.confirmAction')}
                </button>
              </div>
            </div>
          </div>
        )}
    </Sidebar>
  );
}
