import { DownloadFeedback } from '../ui/DownloadFeedback';
import { useDownloadTask } from '../../hooks/useFileDownload';
import { useDragLifetime } from '../../hooks/useDragLifetime';
import { MarkdownParseBudget } from '../sidebar/markdownParseBudget';
import { scanMarkdownInlineTokens } from '../sidebar/markdownInlineTokens';
import { LoadingSpinner as RiLoader } from '../ui/Loading';
import { fetchPreviewResource } from '../../utils/previewResourceCache';
import { downloadMarkdownImage } from '../sidebar/markdownImageDownload';
import { initializeMermaid, loadMermaid } from '../../utils/mermaid';
import { createContext, useContext, useEffect, useCallback, useLayoutEffect, useMemo, useState, useRef, useId, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useGesture } from '@use-gesture/react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import { X as RiCloseLine, ArrowLeft as RiArrowLeft, ArrowRight as RiArrowRight, Download as RiDownload, ListTree as RiListTree } from 'lucide-react';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { buildVideoPreviewUrl, isPreviewableImagePath, isPreviewableVideoPath } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { loadRefractor, resolveLanguage, shouldHighlight, highlightToLines } from '../../utils/syntaxHighlight';
import { hasNativeTextSelection } from '../sidebar/referenceSelection';
import { isBusinessResource, useEncryptedMediaSource } from '../../federation/mediaSource';
import 'swiper/css';

const MARKDOWN_TABLE_CELL_CLASS = 'border-r px-2 py-1.5 sm:px-3 sm:py-2';
// Cap intrinsic column sizing, but fill extra space allocated by min-w-full tables.
const MARKDOWN_TABLE_CELL_CONTENT_CLASS = 'min-w-full max-w-[18rem] whitespace-normal break-words sm:max-w-[27rem]';
const MARKDOWN_TABLE_HEADER_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-b border-border/15 font-semibold last:border-r-0`;
const MARKDOWN_TABLE_BODY_CELL_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-border/10 align-top text-muted-foreground last:border-r-0`;
// Native horizontal-scroll regions inside the sidebar (code blocks, tables).
// The sidebar gesture arbiter resolves these against the enclosing swiper and
// the drawer per touch sequence, so no swiper-no-swiping / gesture-ignore
// markers are needed — the class only carries the touch-action CSS rule.
export const FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS = 'termdock-file-preview-horizontal-scroll';
const MARKDOWN_TABLE_SCROLL_CLASS = `${FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS} termdock-md-table-scroll min-w-0 max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-border/20 bg-surface`;

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
    || /^<video\b/i.test(trimmed)
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

type MarkdownPreviewImage = {
  kind: 'image';
  src: string;
  alt: string;
  title?: string;
} | {
  kind: 'mermaid';
  svg: string;
  alt: string;
  title?: string;
};

const MarkdownMermaidOpenContext = createContext<((svg: string) => void) | null>(null);

interface MarkdownRenderContext {
  budget: MarkdownParseBudget;
  markdownFilePath: string | null;
  rootPath: string | null;
  referenceDefinitions: MarkdownReferenceDefinitions;
  footnoteDefinitions: MarkdownFootnoteDefinitions;
  headingSlugCounts: Map<string, number>;
  images: MarkdownPreviewImage[];
  onImageOpen?: (index: number) => void;
  footnotesLabel: string;
  backToFootnoteLabel: (index: number) => string;
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

function normalizeMarkdownLocalPath(path: string): string {
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

export interface MarkdownLocalLinkTarget {
  path: string;
  fragment: string | null;
  directory: boolean;
}

export function resolveMarkdownLocalLinkTarget(
  href: string,
  markdownFilePath: string | null,
  rootPath: string | null,
): MarkdownLocalLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:https?:|mailto:|javascript:|data:)/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  // Fragment-only links belong to the current preview, not a new browser window.
  if (trimmed.startsWith('#')) {
    if (!markdownFilePath) return null;
    try {
      return { path: markdownFilePath, fragment: decodeURIComponent(trimmed.slice(1)) || null, directory: false };
    } catch {
      return null;
    }
  }

  const hashIndex = trimmed.indexOf('#');
  const rawPathWithQuery = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const rawFragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : '';
  const rawPath = rawPathWithQuery.split('?', 1)[0];
  if (!rawPath) return null;

  let decodedPath: string;
  let decodedFragment: string | null = null;
  try {
    decodedPath = decodeURIComponent(rawPath);
    decodedFragment = rawFragment ? decodeURIComponent(rawFragment) : null;
  } catch {
    return null;
  }

  const normalizedRoot = rootPath ? normalizeMarkdownLocalPath(rootPath) : null;
  let absolutePath: string;
  if (decodedPath.startsWith('/')) {
    const isFileSystemAbsolute = normalizedRoot
      && (decodedPath === normalizedRoot || decodedPath.startsWith(`${normalizedRoot}/`));
    absolutePath = normalizeMarkdownLocalPath(normalizedRoot && !isFileSystemAbsolute
      ? `${normalizedRoot}/${decodedPath.slice(1)}`
      : decodedPath);
  } else {
    if (!markdownFilePath) return null;
    absolutePath = normalizeMarkdownLocalPath(`${getParentDirectoryPath(markdownFilePath)}/${decodedPath}`);
  }

  if (normalizedRoot && absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}/`)) return null;
  return { path: absolutePath, fragment: decodedFragment, directory: /\/$/.test(rawPath) };
}

// Shared resolver for local media embedded in markdown (both the ![..](..)
// syntax and raw-HTML <img>/<video> tags): remote https URLs pass through,
// data:/javascript: and non-previewable types are rejected, everything else
// resolves against the markdown file's directory (or rootPath for /-prefixed
// paths that are not filesystem-absolute) and maps to a server URL via
// buildUrl. Mirrors the file watcher's /blob?path=&v=N versioning upstream.
function resolveMarkdownFsMediaSrc(
  src: string,
  markdownFilePath: string | null,
  rootPath: string | null,
  isPreviewable: (filePath: string) => boolean,
  buildUrl: (absolutePath: string) => string,
): string | null {
  const trimmed = src.trim();
  if (!trimmed || /^(?:javascript|data):/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!isPreviewable(trimmed.split(/[?#]/, 1)[0])) return null;

  let absolutePath: string;
  if (trimmed.startsWith('/')) {
    const isFileSystemAbsolute = rootPath && (trimmed === rootPath || trimmed.startsWith(`${rootPath}/`));
    absolutePath = normalizeMarkdownLocalPath(rootPath && !isFileSystemAbsolute ? `${rootPath}/${trimmed.slice(1)}` : trimmed);
  } else {
    if (!markdownFilePath) return null;
    absolutePath = normalizeMarkdownLocalPath(`${getParentDirectoryPath(markdownFilePath)}/${trimmed}`);
  }

  return buildUrl(absolutePath);
}

function resolveMarkdownImageSrc(src: string, markdownFilePath: string | null, rootPath: string | null): string | null {
  return resolveMarkdownFsMediaSrc(src, markdownFilePath, rootPath, isPreviewableImagePath, (absolutePath) => (
    `/api/terminal/fs/blob?path=${encodeURIComponent(absolutePath)}`
  ));
}

function resolveMarkdownVideoSrc(src: string, markdownFilePath: string | null, rootPath: string | null): string | null {
  // The /video route streams with Range support, so the native <video> can
  // seek without buffering the whole file (unlike images' blob fetch).
  if (/^https?:\/\//i.test(src.trim())) return src.trim();
  const target = resolveMarkdownLocalLinkTarget(src, markdownFilePath, rootPath);
  if (!target || !isPreviewableVideoPath(target.path)) return null;
  return buildVideoPreviewUrl(target.path) + (target.fragment ? `#${target.fragment}` : '');
}

function isMarkdownVideoTarget(src: string): boolean {
  // Infer videos only from the path, never a query parameter or link label.
  try {
    return isPreviewableVideoPath(decodeURIComponent(new URL(src, 'https://markdown.invalid/').pathname));
  } catch {
    return false;
  }
}

// Display-height band for normalizing SVGs in the markdown preview. SVG files
// carry arbitrary declared sizes (a 24×24 icon vs a 1000×1000 diagram), which
// made some render tiny and others flood the panel. SVGs are vector and scale
// cleanly, so they are sized from a clamped target height with the aspect
// ratio following. Raster images keep their intrinsic size — upscaling them
// would blur.
const MARKDOWN_SVG_MIN_DISPLAY_HEIGHT = 128;
const MARKDOWN_SVG_MAX_DISPLAY_HEIGHT = 360;
const MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT = 480;

export function isSvgImageSrc(src: string): boolean {
  try {
    // Markdown images are served as /api/terminal/fs/blob?path=<encoded>, so
    // the .svg extension lives inside the query string, not the URL path.
    return /\.svg(?=$|[?#&])/i.test(decodeURIComponent(src));
  } catch {
    return false;
  }
}

// Computes the exact display box (px) for a markdown image once its natural
// size is known: SVG normalization (height band above), then caps at the
// container width and the 480px max height, ratio always preserved. Returns
// null when the natural size is unusable. The same box drives the loading
// placeholder and the final img, so swapping them causes no layout shift.
// `requestedWidthPx` comes from a raw-HTML `<img width="210">` attribute:
// when present the author's width wins (capped at the container), with the
// height following the intrinsic ratio instead of the natural size.
export function computeMarkdownImageDisplayBox(
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  containerWidth: number,
  requestedWidthPx = 0,
): { width: number; height: number } | null {
  if (!naturalWidth || !naturalHeight) return null;
  let width: number;
  let height: number;
  if (requestedWidthPx > 0) {
    width = containerWidth > 0 ? Math.min(requestedWidthPx, containerWidth) : requestedWidthPx;
    height = (naturalHeight * width) / naturalWidth;
  } else if (isSvgImageSrc(src)) {
    height = Math.min(Math.max(naturalHeight, MARKDOWN_SVG_MIN_DISPLAY_HEIGHT), MARKDOWN_SVG_MAX_DISPLAY_HEIGHT);
    width = (naturalWidth * height) / naturalHeight;
  } else {
    width = naturalWidth;
    height = naturalHeight;
  }
  if (containerWidth > 0 && width > containerWidth) {
    height = (height * containerWidth) / width;
    width = containerWidth;
  }
  if (height > MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT) {
    width = (width * MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT) / height;
    height = MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// Extracts the local absolute path back out of an /api/terminal/fs/blob URL.
// Returns null for remote (https://) images, which are passed through as-is.
function getLocalPathFromBlobSrc(src: string): string | null {
  if (!src.startsWith('/api/terminal/fs/blob?')) return null;
  try {
    const params = new URLSearchParams(src.slice(src.indexOf('?')));
    return params.get('path');
  } catch {
    return null;
  }
}

// Ties a /api/terminal/fs/blob URL to the file watcher's version state: when
// the underlying file changes on disk (per-path bump) or the watcher reports a
// rescan / reconnects / the user hits refresh (global epoch bump), the version
// changes and `&v=N` is appended so consumers refetch — otherwise they kept
// showing the stale bytes (the blob endpoint is Cache-Control: no-store, but
// fetched object URLs and <img> caches are keyed by URL).
function useVersionedFsBlobSrc(src: string): string {
  const localPath = getLocalPathFromBlobSrc(src);
  const version = useSidebarStore((s) => (
    localPath ? (s.fileChangeVersions.get(localPath) ?? 0) + s.fileWatchEpoch : 0
  ));
  return localPath && version > 0 ? `${src}&v=${version}` : src;
}

type MarkdownImageState =
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string }
  | { status: 'fallback' }; // fetch failed — render the plain <img> natively

// Markdown image that reserves its final display box BEFORE downloading, so
// the preview never jumps when the image arrives:
//  1. IntersectionObserver starts the fetch only near the viewport (the lazy
//     behavior loading="lazy" used to give us).
//  2. The blob endpoint returns X-Image-Width/Height, so the display box
//     (computeMarkdownImageDisplayBox) is known as soon as headers land.
//  3. A pulsing placeholder occupies exactly that box; the ready img is
//     rendered at the same explicit size and fades in — zero layout shift.
// The URL goes through useVersionedFsBlobSrc, so on-disk changes to the image
// file (or a watch rescan / manual refresh) append `&v=N` and refetch.
// `requestedWidthPx` honors a raw-HTML `<img width="…">` attribute once the
// natural size arrives; pre-headers the placeholder guesses at that width.
function MarkdownImage({ src, alt, title, requestedWidthPx }: { src: string; alt: string; title?: string; requestedWidthPx?: number }) {
  const isVector = isSvgImageSrc(src);
  const versionedSrc = useVersionedFsBlobSrc(src);
  const fallbackSrc = useEncryptedMediaSource(versionedSrc);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [state, setState] = useState<MarkdownImageState>({ status: 'loading' });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // Reference-line spans and inline formatting can sit between the image
  // wrapper and its block container. Their clientWidth is zero, so skip them
  // rather than sizing the image as if the sidebar had no width constraint.
  // Tracked with a ResizeObserver because the sidebar width can change.
  useLayoutEffect(() => {
    const root = rootRef.current;
    let container = root?.parentElement?.parentElement ?? root?.parentElement;
    while (container) {
      const display = window.getComputedStyle(container).display;
      if (display !== 'inline' && display !== 'contents') break;
      container = container.parentElement;
    }
    if (!container) return;
    const blockContainer = container;
    const update = () => {
      const style = window.getComputedStyle(blockContainer);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      setContainerWidth(Math.max(0, blockContainer.clientWidth - padding));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(blockContainer);
    return () => observer.disconnect();
  }, []);

  // Lazy-start: only fetch when the image scrolls near the viewport.
  useEffect(() => {
    if (nearViewport) return;
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '400px' });
    observer.observe(root);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    // If the fetch hangs (slow/blocked storage, dev server restart), fall
    // back to the native <img> instead of parking on the placeholder forever.
    const hangTimer = window.setTimeout(() => {
      controller.abort(new DOMException('Image fetch timed out', 'TimeoutError'));
    }, 15_000);
    fetchPreviewResource(versionedSrc, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const width = Number(response.headers.get('X-Image-Width')) || 0;
        const height = Number(response.headers.get('X-Image-Height')) || 0;
        const blob = await response.blob();
        return { blob, width, height };
      })
      .then(({ blob, width, height }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        if (width > 0 && height > 0) setNaturalSize({ width, height });
        setState({ status: 'ready', objectUrl });
      })
      .catch(() => {
        // Plain cleanup aborts (unmount / src change) must not overwrite the
        // next effect's state; the hang-timer abort and real errors fall back
        // to the native <img>.
        const reason = controller.signal.reason;
        const abortedByCleanup = controller.signal.aborted && !(reason instanceof DOMException && reason.name === 'TimeoutError');
        if (!abortedByCleanup) setState({ status: 'fallback' });
      })
      .finally(() => {
        window.clearTimeout(hangTimer);
      });
    return () => {
      window.clearTimeout(hangTimer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [nearViewport, versionedSrc]);

  const box = computeMarkdownImageDisplayBox(src, naturalSize?.width ?? 0, naturalSize?.height ?? 0, containerWidth, requestedWidthPx ?? 0);
  // While headers are pending, reserve a rough guess; the exact size follows
  // as soon as headers land (usually the same round-trip).
  const placeholderBox = box ?? (requestedWidthPx
    ? { width: containerWidth > 0 ? Math.min(requestedWidthPx, containerWidth) : requestedWidthPx, height: Math.round(requestedWidthPx * 0.75) }
    : { width: MARKDOWN_SVG_MIN_DISPLAY_HEIGHT * 2, height: MARKDOWN_SVG_MIN_DISPLAY_HEIGHT });

  return (
    <div ref={rootRef} className="block max-w-full" style={box ? { width: box.width, height: box.height } : undefined}>
      {state.status === 'ready' ? (
        <img
          src={state.objectUrl}
          alt={alt}
          title={title}
          decoding="async"
          className={`${isVector ? '' : 'termdock-fade-in '}block max-h-[480px] max-w-full object-contain`}
          style={box ? { width: box.width, height: box.height } : undefined}
          onLoad={(event) => {
            // Headers are only an estimate (e.g. EXIF rotation). Decoded
            // dimensions also correct the box after an on-disk image change.
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0
              && (naturalSize?.width !== img.naturalWidth || naturalSize?.height !== img.naturalHeight)) {
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
        />
      ) : state.status === 'fallback' ? (
        <img
          src={fallbackSrc}
          alt={alt}
          title={title}
          loading="lazy"
          decoding="async"
          className="block max-h-[480px] max-w-full object-contain"
          style={box ? { width: box.width, height: box.height } : undefined}
          onLoad={(event) => {
            // Fetch failed or remote image without headers: measure after
            // decode and resize once (also rescues 0×0-collapsed SVGs).
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0
              && (naturalSize?.width !== img.naturalWidth || naturalSize?.height !== img.naturalHeight)) {
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
        />
      ) : (
        <div
          aria-hidden
          className="flex max-w-full animate-pulse items-center justify-center rounded bg-surface-elevated/60"
          style={{ width: placeholderBox.width, height: placeholderBox.height }}
        >
          <span className="text-[10px] text-muted-foreground/60">{alt || '…'}</span>
        </div>
      )}
    </div>
  );
}

function renderMarkdownImage(
  key: string,
  alt: string,
  src: string,
  title: string | undefined,
  context: MarkdownRenderContext,
  // `interactive: false` suppresses the lightbox button (used when a parent
  // <a> already owns the click — nesting a button inside an anchor would be
  // invalid HTML with conflicting click targets).
  options?: { fallbackText?: string; requestedWidthPx?: number; interactive?: boolean },
): ReactNode {
  if (!options?.fallbackText && isMarkdownVideoTarget(src)) {
    const url = resolveMarkdownVideoSrc(src, context.markdownFilePath, context.rootPath);
    if (url) return <MarkdownVideo key={key} url={url} label={alt} title={title} hasControls />;
  }
  const imageSrc = resolveMarkdownImageSrc(src, context.markdownFilePath, context.rootPath);
  if (!imageSrc) return options?.fallbackText ?? `![${alt}](${src})`;

  const imageIndex = context.images.length;
  context.images.push({ kind: 'image', src: imageSrc, alt, title });
  const image = <MarkdownImage src={imageSrc} alt={alt} title={title} requestedWidthPx={options?.requestedWidthPx} />;

  return context.onImageOpen && options?.interactive !== false ? (
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
  const { t } = useI18n();
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

  if (sanitized === null) return <div className="py-2 text-xs text-muted-foreground">{t('rightSidebar.renderingHtml')}</div>;
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

// Extracts the key="value" / key='value' / key=value attributes of an HTML
// tag into a lower-cased map (quotes stripped, later duplicates win).
function parseMarkdownHtmlAttrs(html: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of html.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return attrs;
}

// Parses the attributes of a raw-HTML `<img …>` tag. Only the attributes the
// markdown image pipeline understands are returned: src (required), alt,
// title, and a numeric width (bare number or with px) — other values (e.g.
// percentages) are ignored and the image renders at its natural size.
function parseMarkdownHtmlImgAttrs(token: string): { src: string; alt?: string; title?: string; widthPx?: number } {
  const attrs = parseMarkdownHtmlAttrs(token);
  const src = attrs.get('src')?.trim() ?? '';
  const width = attrs.get('width')?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  return { src, alt: attrs.get('alt'), title: attrs.get('title'), widthPx: width ? Number(width[1]) : undefined };
}

// Parses raw-HTML videos with either src or child <source> tags:
// attrs from the open tag, plus the boolean controls attribute (detected on
// the tag with quoted values removed, so words inside src don't false-positive)
// and the inner text between the tags as the author's unsupported-reader fallback.
function parseMarkdownHtmlVideoTag(token: string): { sources: string[]; poster?: string; fallbackText: string; widthPx?: number; maxWidthPx?: number; controls: boolean } {
  const openEnd = token.indexOf('>');
  const openTag = openEnd < 0 ? token : token.slice(0, openEnd + 1);
  const attrs = parseMarkdownHtmlAttrs(openTag);
  const src = attrs.get('src')?.trim() ?? '';
  const sources = src ? [src] : Array.from(token.slice(openEnd + 1).matchAll(/<source\b[^>]*>/gi), (match) => (
    parseMarkdownHtmlAttrs(match[0]).get('src')?.trim() ?? ''
  )).filter(Boolean);
  const width = attrs.get('width')?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  const maxWidth = attrs.get('style')?.match(/(?:^|;)\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*(?:;|$)/i);
  const quotedStripped = openTag.replace(/=\s*(?:"[^"]*"|'[^']*')/g, ' ');
  const fallbackText = openEnd < 0 ? '' : token.slice(openEnd + 1).replace(/<\/video\s*>$/i, '').replace(/<[^>]*>/g, '').trim();
  return { sources, poster: attrs.get('poster'), fallbackText, widthPx: width ? Number(width[1]) : undefined, maxWidthPx: maxWidth ? Number(maxWidth[1]) : undefined, controls: /\bcontrols\b/i.test(quotedStripped) };
}

// Inline raw-HTML `<video>` in the markdown preview. The URL is the streaming
// /video route (Range support, so seeking works without downloading the whole
// file); auth rides the encrypted media source like the file-preview player.
// On load failure the author's inner text — the content these tags carry
// exactly for readers without video — is shown instead of a dead player.
function MarkdownVideo({ url, poster, fallbackText, widthPx, maxWidthPx, hasControls, label, title }: { url: string; poster?: string; fallbackText?: string; widthPx?: number; maxWidthPx?: number; hasControls: boolean; label?: string; title?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const mediaUrl = useEncryptedMediaSource(url, () => setFailed(true));
  const posterUrl = useEncryptedMediaSource(poster ?? '');
  useEffect(() => setFailed(false), [url]);

  // Not yet served by the worker controlling this page: mount nothing rather
  // than an empty frame; the video appears as soon as the source is usable.
  if (!mediaUrl && !failed) return null;

  return (
    <span className="my-2 block max-w-full overflow-hidden rounded-md border border-border/20 bg-surface-2">
      {failed ? (
        <span className="block px-3 py-2 text-xs text-muted-foreground">{fallbackText?.trim() || t('rightSidebar.videoUnsupported')}</span>
      ) : (
        <video
          className="block max-w-full"
          src={mediaUrl}
          poster={posterUrl || undefined}
          aria-label={label}
          title={title}
          // React does not forward width/height as media-element attributes;
          // CSS width keeps the intrinsic aspect ratio (max-w-full caps it).
          style={{ width: widthPx ? `${widthPx}px` : '100%', maxWidth: maxWidthPx ? `${maxWidthPx}px` : undefined }}
          controls={hasControls}
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function renderMarkdownHtmlInline(token: string, key: string, context: MarkdownRenderContext): ReactNode | null {
  // `<a href="…"><img …></a>` — the GitHub-style "click for the full-size
  // copy" wrapper. When the anchor points at the same file as the image, the
  // lightbox already IS the full-size view, so the redundant anchor is
  // dropped. A different target keeps the anchor (local files still route
  // through the preview's a[href] click capture; remote ones open a new tab).
  if (/^<a\b[^>]*>\s*<\s*img\b[^>]*>\s*<\/a\s*>$/i.test(token)) {
    const openTag = token.slice(0, token.indexOf('>') + 1);
    const href = parseMarkdownHtmlAttrs(openTag).get('href')?.trim() ?? '';
    const imgToken = token.match(/<\s*img\b[^>]*>/i)?.[0] ?? '';
    const { src, alt, title, widthPx } = parseMarkdownHtmlImgAttrs(imgToken);
    if (!src) return null;
    // The image itself must resolve; otherwise the whole tag stays literal.
    const imgAbs = resolveMarkdownFsMediaSrc(src, context.markdownFilePath, context.rootPath, isPreviewableImagePath, (p) => p);
    if (!imgAbs) return null;
    const linkTarget = href ? resolveMarkdownLocalLinkTarget(href, context.markdownFilePath, context.rootPath) : null;
    const sameFile = Boolean(linkTarget && linkTarget.path === imgAbs);
    const safeHref = !sameFile && href ? getSafeMarkdownHref(href) : null;
    // Render once (renderMarkdownImage registers the image in the lightbox
    // list): interactive only when no anchor wraps it.
    const image = renderMarkdownImage(key, alt ?? '', src, title, context, { requestedWidthPx: widthPx, interactive: safeHref ? false : undefined });
    return safeHref ? (
      <a key={key} href={safeHref} target="_blank" rel="noreferrer">
        {image}
      </a>
    ) : image;
  }
  if (/^<\s*img\b[^>]*>$/i.test(token)) {
    const { src, alt, title, widthPx } = parseMarkdownHtmlImgAttrs(token);
    if (!src) return null;
    // Rendered through the same pipeline as ![alt](src) images (relative path
    // resolution against the markdown file, versioned refetch, encrypted
    // media source, lightbox). An unresolvable src keeps the raw tag visible.
    return renderMarkdownImage(key, alt ?? '', src, title, context, { fallbackText: token, requestedWidthPx: widthPx });
  }
  if (/^<\s*video\b[^>]*>[\s\S]*?<\/video\s*>$/i.test(token)) {
    const { sources, poster, fallbackText, widthPx, maxWidthPx, controls } = parseMarkdownHtmlVideoTag(token);
    const videoUrl = sources.map((src) => resolveMarkdownVideoSrc(src, context.markdownFilePath, context.rootPath)).find(Boolean);
    if (!videoUrl) return null;
    const posterUrl = poster ? resolveMarkdownImageSrc(poster, context.markdownFilePath, context.rootPath) : null;
    return <MarkdownVideo key={key} url={videoUrl} poster={posterUrl ?? undefined} fallbackText={fallbackText} widthPx={widthPx} maxWidthPx={maxWidthPx} hasControls={controls} />;
  }
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
  return context.budget.nested(() => renderMarkdownInlineContent(text, keyPrefix, wrapLongTokens, context));
}

function renderMarkdownInlineContent(
  text: string,
  keyPrefix: string,
  wrapLongTokens = true,
  context: MarkdownRenderContext,
): ReactNode[] {
  context.budget.validateInline(text);
  const maskedText = maskMarkdownEscapes(text);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const { index, token } of scanMarkdownInlineTokens(maskedText, context.budget)) {
    if (index > lastIndex) nodes.push(unmaskMarkdownEscapes(maskedText.slice(lastIndex, index)));
    const key = `${keyPrefix}-${index}`;

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
      const videoUrl = safeHref && isMarkdownVideoTarget(safeHref)
        ? resolveMarkdownVideoSrc(safeHref, context.markdownFilePath, context.rootPath) : null;
      const link = safeHref ? (
        <a key={key} href={safeHref} title={inlineTarget?.title ?? definition?.title} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {renderMarkdownInline(label, `${key}-link`, wrapLongTokens, context)}
        </a>
      ) : token;
      nodes.push(videoUrl ? (
        <span key={key}>
          <MarkdownVideo url={videoUrl} label={label} title={inlineTarget?.title ?? definition?.title} hasControls />
          {link}
        </span>
      ) : link);
    }

    lastIndex = index + token.length;
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

// Same line splitting as renderMarkdownInlineLines, but in two phases so the
// inline rendering (which has side effects: image gallery registration) runs
// EAGERLY while the block is built, and only the per-line wrapper spans —
// data-md-ref-* stamps + data-selected highlight — are re-created whenever
// the referenced line range changes. This mirrors how table blocks precompute
// their cells: content functions must never re-run renderMarkdownInline, or
// images would be registered again on every render.
function renderMarkdownRefLineNodes(lines: string[], keyPrefix: string, context: MarkdownRenderContext): { perLine: ReactNode[]; hardBreaks: boolean[] } {
  const perLine: ReactNode[] = [];
  const hardBreaks: boolean[] = [];
  lines.forEach((line, index) => {
    hardBreaks.push(hasMarkdownHardBreak(line));
    perLine.push(renderMarkdownInline(stripMarkdownHardBreak(line), `${keyPrefix}-${index}`, true, context));
  });
  return { perLine, hardBreaks };
}

function wrapMarkdownRefLines(
  perLine: ReactNode[],
  hardBreaks: boolean[],
  lineNums: number[],
  keyPrefix: string,
  lineRange: { start: number; end: number } | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  perLine.forEach((lineNodes, index) => {
    const lineNo = lineNums[index] ?? 0;
    const selected = Boolean(lineRange && lineNo >= lineRange.start && lineNo <= lineRange.end);
    nodes.push(
      <span
        key={`${keyPrefix}-ref-${index}`}
        data-md-ref-start={lineNo}
        data-md-ref-end={lineNo}
        data-selected={selected ? 'true' : undefined}
      >
        {lineNodes}
      </span>,
    );
    if (index < perLine.length - 1) nodes.push(hardBreaks[index] ? <br key={`${keyPrefix}-${index}-br`} /> : ' ');
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
  // 1-based source line range of the item (including nested children and
  // continuation paragraphs), relative to the array passed to
  // parseMarkdownListBlock — absolute for top-level lists, quote-relative for
  // lists nested inside blockquotes (callers add a line offset when stamping
  // data-md-ref-* attributes).
  lineStart: number;
  lineEnd: number;
}

function getMarkdownListIndent(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

function parseMarkdownListItemLine(line: string): { ordered: boolean; start?: number; content: string } | null {
  // Trailing spaces/backslashes carry explicit Markdown line breaks.
  const match = line.replace(/\r$/, '').trimStart().match(/^([-+*]|\d+[.)])\s+(.+)$/);
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
  let paragraphBreak = false;

  while (index < lines.length) {
    const currentLine = lines[index];
    if (skipDefinitionLines && (parseMarkdownReferenceDefinition(currentLine) || footnoteDefinitionLines.has(index))) {
      index += 1;
      continue;
    }

    const itemMatch = parseMarkdownListItemLine(currentLine);
    const indent = getMarkdownListIndent(currentLine);

    if (!itemMatch) {
      if (!currentLine.trim() && stack.length > 0) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        // An indented continuation after a blank line is a new paragraph in
        // this list item. Do not consume the next unindented document block.
        if (next < lines.length && getMarkdownListIndent(lines[next]) > baseIndent) {
          paragraphBreak = true;
          index = next;
          continue;
        }
        break;
      }
      if (indent > baseIndent && stack.length > 0) {
        const target = [...stack].reverse().find((entry) => entry.indent < indent)?.item ?? stack[stack.length - 1].item;
        const text = currentLine.replace(/\r$/, '').trimStart();
        if (paragraphBreak) target.paragraphs.push(text);
        else if (target.paragraphs.length > 0) target.paragraphs[target.paragraphs.length - 1] += `\n${text}`;
        else target.content += `\n${text}`;
        paragraphBreak = false;
        for (const entry of stack) entry.item.lineEnd = index + 1;
        index += 1;
        continue;
      }
      break;
    }

    if (indent < baseIndent) break;
    if (indent === baseIndent && itemMatch.ordered !== ordered) break;

    const item: MarkdownListItem = { content: itemMatch.content, ordered: itemMatch.ordered, start: itemMatch.start, children: [], paragraphs: [], lineStart: index + 1, lineEnd: index + 1 };
    paragraphBreak = false;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.item ?? null;
    if (parent) parent.children.push(item);
    else items.push(item);
    stack.push({ indent, item });
    for (const entry of stack) entry.item.lineEnd = index + 1;
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

// List rendering is split like paragraphs (see renderMarkdownRefLineNodes):
// buildMarkdownListItemRenders runs all inline rendering eagerly (image
// registration happens once, at block-build time), wrapMarkdownListItems only
// re-creates the <li> wrappers — data-md-ref-* stamps and the data-selected
// highlight — when the referenced line range changes.
interface MarkdownListGroupRender {
  ordered: boolean;
  start?: number;
  items: MarkdownListItemRender[];
}

interface MarkdownListItemRender {
  key: string;
  taskItem: boolean;
  refStart: number;
  refEnd: number;
  content: ReactNode;
  groups: MarkdownListGroupRender[];
}

function buildMarkdownListItemRenders(
  items: MarkdownListItem[],
  keyPrefix: string,
  context: MarkdownRenderContext,
  lineOffset = 0,
): MarkdownListItemRender[] {
  return context.budget.nested(() => buildMarkdownListItemRenderContent(items, keyPrefix, context, lineOffset));
}

function buildMarkdownListItemRenderContent(
  items: MarkdownListItem[],
  keyPrefix: string,
  context: MarkdownRenderContext,
  lineOffset = 0,
): MarkdownListItemRender[] {
  return items.map((item, itemIndex) => {
    const taskMatch = item.content.match(/^\[([ xX])\]\s+([\s\S]+)$/);
    return {
      key: `item-${itemIndex}`,
      taskItem: Boolean(taskMatch),
      refStart: item.lineStart + lineOffset,
      refEnd: item.lineEnd + lineOffset,
      content: (
        <>
          {taskMatch ? <input type="checkbox" checked={taskMatch[1].toLowerCase() === 'x'} readOnly className="mr-2 align-[-2px] accent-primary" /> : null}
          {renderMarkdownInlineLines((taskMatch?.[2] ?? item.content).split('\n'), `li-${keyPrefix}-${itemIndex}`, context)}
          {item.paragraphs.length > 0 && (
            <div className="mt-1 space-y-1 text-muted-foreground">
              {item.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`paragraph-${paragraphIndex}`}>
                  {renderMarkdownInlineLines(paragraph.split('\n'), `li-${keyPrefix}-${itemIndex}-p-${paragraphIndex}`, context)}
                </p>
              ))}
            </div>
          )}
        </>
      ),
      groups: buildMarkdownListGroupRenders(item.children, `${keyPrefix}-${itemIndex}`, context, lineOffset),
    };
  });
}

function buildMarkdownListGroupRenders(
  items: MarkdownListItem[],
  keyPrefix: string,
  context: MarkdownRenderContext,
  lineOffset = 0,
): MarkdownListGroupRender[] {
  const groups: Array<{ ordered: boolean; items: MarkdownListItem[] }> = [];
  for (const item of items) {
    const current = groups[groups.length - 1];
    if (current && current.ordered === item.ordered) current.items.push(item);
    else groups.push({ ordered: item.ordered, items: [item] });
  }

  return groups.map((group, groupIndex) => ({
    ordered: group.ordered,
    start: group.ordered ? group.items[0]?.start : undefined,
    items: buildMarkdownListItemRenders(group.items, `${keyPrefix}-g${groupIndex}`, context, lineOffset),
  }));
}

function wrapMarkdownListItems(renders: MarkdownListItemRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return renders.map((item) => {
    const selected = Boolean(lineRange && item.refStart <= lineRange.end && item.refEnd >= lineRange.start);
    return (
      <li
        key={item.key}
        className={item.taskItem ? 'list-none' : undefined}
        data-md-ref-start={item.refStart}
        data-md-ref-end={item.refEnd}
        data-selected={selected ? 'true' : undefined}
      >
        {item.content}
        {item.groups.length > 0 && wrapMarkdownListGroups(item.groups, lineRange)}
      </li>
    );
  });
}

function wrapMarkdownListGroups(groups: MarkdownListGroupRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return groups.map((group, groupIndex) => {
    const ListTag = group.ordered ? 'ol' : 'ul';
    return (
      <ListTag key={`nested-${groupIndex}`} start={group.start} className={`${group.ordered ? 'list-decimal' : 'list-disc'} mt-1 space-y-0.5 pl-4 marker:text-muted-foreground/60`}>
        {wrapMarkdownListItems(group.items, lineRange)}
      </ListTag>
    );
  });
}

function renderMarkdownFootnotes(context: MarkdownRenderContext): ReactNode | null {
  const footnotes = Array.from(context.footnoteDefinitions.values()).sort((a, b) => a.index - b.index);
  if (footnotes.length === 0) return null;

  return (
    <section className="mt-3 border-t border-border/20 pt-2 text-[12px] leading-5 text-muted-foreground">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">{context.footnotesLabel}</div>
      <ol className="list-decimal space-y-1 pl-5">
        {footnotes.map((footnote) => (
          <li key={footnote.id} id={`fn-${footnote.id}`}>
            {renderMarkdownInline(footnote.text, `footnote-${footnote.id}`, true, context)}
            {' '}
            <a href={`#fnref-${footnote.id}`} className="text-primary no-underline" aria-label={context.backToFootnoteLabel(footnote.index)}>↩</a>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Quote content is built in the same two phases as paragraphs/lists (see
// renderMarkdownRefLineNodes): buildMarkdownQuoteNodeRenders runs ALL inline
// rendering eagerly at block-build time (image gallery registration must not
// re-run per render), producing descriptors; wrapMarkdownQuoteNodes then only
// re-assembles the tree with per-line data-selected highlights whenever the
// referenced line range changes.
type MarkdownQuoteNodeRender =
  | { kind: 'static'; node: ReactNode }
  | { kind: 'paragraph'; keyPrefix: string; perLine: ReactNode[]; hardBreaks: boolean[]; lineNums: number[] }
  | { kind: 'list'; keyPrefix: string; ordered: boolean; start?: number; renders: MarkdownListItemRender[] }
  | { kind: 'code'; key: string; code: string; lang: string; blockKey: string; codeStartLine: number };

function buildMarkdownQuoteNodeRenders(lines: string[], keyPrefix: string, context: MarkdownRenderContext, lineNums?: number[]): MarkdownQuoteNodeRender[] {
  const nodes: MarkdownQuoteNodeRender[] = [];
  let index = 0;
  // Quote lines are consumed consecutively, so lineNums[i] is the 1-based
  // source line of quote line i; nested constructs (lists, code) only know
  // their quote-relative index and get shifted back through this.
  const lineAt = (quoteIndex: number) => lineNums?.[quoteIndex] ?? quoteIndex + 1;

  while (index < lines.length) {
    context.budget.check();
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
      nodes.push({
        kind: 'static',
        node: (
          <details key={`${keyPrefix}-details-${blockStart}`} className="overflow-hidden rounded-lg border border-border/20 bg-surface px-3 py-2 text-muted-foreground">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">{renderMarkdownInline(summary, `${keyPrefix}-details-${blockStart}-summary`, true, context)}</summary>
            {bodyLines.length > 0 && (
              <div className="mt-2 text-sm leading-6">{renderMarkdownInlineLines(bodyLines, `${keyPrefix}-details-${blockStart}`, context)}</div>
            )}
          </details>
        ),
      });
      continue;
    }

    if (/^<video\b/i.test(trimmed)) {
      const blockStart = index;
      const videoLines = [line];
      index += 1;
      while (!videoLines[videoLines.length - 1].match(/<\/video\s*>/i) && index < lines.length && lines[index].trim()) {
        context.budget.check();
        videoLines.push(lines[index++]);
      }
      const token = videoLines.join('\n');
      nodes.push({ kind: 'static', node: <div key={`${keyPrefix}-video-${blockStart}`}>{renderMarkdownInline(token, `${keyPrefix}-video-${blockStart}`, true, context)}</div> });
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
      nodes.push({ kind: 'static', node: <MarkdownSanitizedHtml key={`${keyPrefix}-html-${blockStart}`} html={htmlLines.join('\n')} /> });
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
      if (lang.toLowerCase() === 'mermaid') {
        nodes.push({ kind: 'static', node: <MarkdownMermaidBlock key={`${keyPrefix}-code-${blockStart}`} code={codeLines.join('\n')} blockKey={`${keyPrefix}-code-${blockStart}`} /> });
      } else if (['math', 'latex', 'tex'].includes(lang.toLowerCase())) {
        nodes.push({ kind: 'static', node: <MarkdownMath key={`${keyPrefix}-code-${blockStart}`} tex={codeLines.join('\n')} display /> });
      } else {
        nodes.push({ kind: 'code', key: `${keyPrefix}-code-${blockStart}`, code: codeLines.join('\n'), lang, blockKey: `${keyPrefix}-code-${blockStart}`, codeStartLine: lineAt(blockStart) + 1 });
      }
      continue;
    }

    if (isIndentedCodeLine(line)) {
      const codeLines: string[] = [];
      const blockStart = index;
      while (index < lines.length && (isIndentedCodeLine(lines[index]) || !lines[index].trim())) {
        codeLines.push(lines[index].trim() ? stripIndentedCodeLine(lines[index]) : '');
        index += 1;
      }
      nodes.push({ kind: 'code', key: `${keyPrefix}-indented-code-${blockStart}`, code: codeLines.join('\n').replace(/\n+$/, ''), lang: '', blockKey: `${keyPrefix}-indented-code-${blockStart}`, codeStartLine: lineAt(blockStart) });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingText = normalizeMarkdownAtxHeadingText(headingMatch[2]);
      const headingId = getMarkdownHeadingId(headingText, context);
      nodes.push({
        kind: 'static',
        node: (
          <Tag key={`${keyPrefix}-heading-${index}`} id={headingId} className="scroll-mt-16 font-semibold text-foreground">
            {renderMarkdownInline(headingText, `${keyPrefix}-heading-${index}`, true, context)}
          </Tag>
        ),
      });
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
      nodes.push({
        kind: 'static',
        node: (
          <div key={`${keyPrefix}-table-${blockStart}`} className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll data-markdown-native-scroll tabIndex={0} role="region" aria-label="表格，可横向滚动">
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
      const parsed = parseMarkdownListBlock(lines, index, baseIndent, ordered, false);
      index = parsed.nextIndex;
      nodes.push({
        kind: 'list',
        keyPrefix: `${keyPrefix}-list-${blockStart}`,
        ordered,
        start: ordered ? start : undefined,
        renders: buildMarkdownListItemRenders(parsed.items, `${keyPrefix}-list-${blockStart}`, context, lineAt(0) - 1),
      });
      continue;
    }

    const paragraphLines = [line.trimStart()];
    const paragraphNums = [lineAt(index)];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      paragraphLines.push(lines[index].trimStart());
      paragraphNums.push(lineAt(index));
      index += 1;
    }
    const renderedParagraph = renderMarkdownRefLineNodes(paragraphLines, `${keyPrefix}-p-${blockStart}`, context);
    nodes.push({ kind: 'paragraph', keyPrefix: `${keyPrefix}-p-${blockStart}`, perLine: renderedParagraph.perLine, hardBreaks: renderedParagraph.hardBreaks, lineNums: paragraphNums });
  }

  return nodes;
}

function wrapMarkdownQuoteNodes(renders: MarkdownQuoteNodeRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return renders.map((item) => {
    switch (item.kind) {
      case 'static':
        return item.node;
      case 'paragraph':
        return <p key={item.keyPrefix}>{wrapMarkdownRefLines(item.perLine, item.hardBreaks, item.lineNums, item.keyPrefix, lineRange)}</p>;
      case 'list': {
        const ListTag = item.ordered ? 'ol' : 'ul';
        return (
          <ListTag key={item.keyPrefix} start={item.start} className={`${item.ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 marker:text-muted-foreground/70`}>
            {wrapMarkdownListItems(item.renders, lineRange)}
          </ListTag>
        );
      }
      case 'code':
        return <MarkdownCodeBlock key={item.key} code={item.code} lang={item.lang} blockKey={item.blockKey} codeStartLine={item.codeStartLine} lineRange={lineRange} />;
    }
  });
}

interface MarkdownPreviewBlock {
  key: string;
  startLine: number;
  endLine: number;
  content: ReactNode | ((lineRange: { start: number; end: number } | null) => ReactNode);
  heading?: MarkdownHeadingInfo;
  interactive?: boolean;
  kind?: 'table';
  // True when the block stamps data-md-ref-* targets inside (paragraph lines,
  // list items, quote lines, code lines): a partial selection then highlights
  // only the exact lines + a rail segment instead of washing the whole block.
  fineGrained?: boolean;
}

interface MarkdownCodeBlockProps {
  code: string;
  lang: string;
  blockKey: string;
  // 1-based source line of the first code line; when set, every rendered line
  // is stamped with data-md-ref-* so it can be referenced on its own.
  codeStartLine?: number;
  lineRange?: { start: number; end: number } | null;
}

const MERMAID_SVG_PADDING = 16;
const MERMAID_SVG_MIN_WIDTH = 192;

function normalizeMermaidSvgSize(svg: string): string {
  const viewBoxMatch = svg.match(/\sviewBox=(["'])([^"']+)\1/i);
  if (!viewBoxMatch) return svg;
  const [, , viewBox] = viewBoxMatch;
  const values = viewBox.trim().split(/[\s,]+/).map(Number);
  const [, , width, height] = values;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return svg;

  const displayWidth = Math.max(MERMAID_SVG_MIN_WIDTH, Math.ceil(width));
  const displayHeight = Math.ceil((displayWidth / width) * height);
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleanedAttrs = attrs
      .replace(/\s(?:width|height)=(["']).*?\1/gi, '')
      .replace(/\sstyle=(["']).*?\1/gi, '');
    return `<svg${cleanedAttrs} width="${displayWidth}" height="${displayHeight}">`;
  });
}

function fitMermaidSvgToContent(root: HTMLElement | null): void {
  const svg = root?.querySelector<SVGSVGElement>('svg');
  if (!svg) return;

  let box: DOMRect | SVGRect;
  try {
    box = svg.getBBox();
  } catch {
    return;
  }

  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return;

  const viewX = box.x - MERMAID_SVG_PADDING;
  const viewY = box.y - MERMAID_SVG_PADDING;
  const viewWidth = box.width + MERMAID_SVG_PADDING * 2;
  const viewHeight = box.height + MERMAID_SVG_PADDING * 2;
  const displayWidth = Math.max(MERMAID_SVG_MIN_WIDTH, Math.ceil(viewWidth));
  const displayHeight = Math.ceil((displayWidth / viewWidth) * viewHeight);

  svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);
  svg.setAttribute('width', String(displayWidth));
  svg.setAttribute('height', String(displayHeight));
  svg.removeAttribute('style');
}

function normalizeMarkdownFenceLanguage(lang: string): string | null {
  const firstToken = lang.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!firstToken) return null;
  const normalized = firstToken.replace(/^language-/, '');
  return resolveLanguage(`code.${normalized}`) ?? normalized;
}

function MarkdownMermaidBlock({
  code,
  blockKey,
}: {
  code: string;
  blockKey: string;
}) {
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const diagramRef = useRef<HTMLDivElement | null>(null);
  const onOpen = useContext(MarkdownMermaidOpenContext);
  const instanceId = useId();

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    loadMermaid()
      .then(async (mermaid) => {
        initializeMermaid(mermaid);
        const id = `termdock-md-mermaid-${blockKey.replace(/[^a-zA-Z0-9_-]/g, '-')}-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);
        if (cancelled) return;
        setSvg(normalizeMermaidSvgSize(renderedSvg));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [blockKey, code, instanceId]);

  useLayoutEffect(() => {
    if (!svg) return;
    fitMermaidSvgToContent(diagramRef.current);
  }, [svg]);

  const handleOpen = useCallback(() => {
    const currentSvg = diagramRef.current?.querySelector('svg')?.outerHTML ?? svg;
    if (currentSvg) onOpen?.(currentSvg);
  }, [onOpen, svg]);

  if (failed) {
    return <MarkdownCodeBlock code={code} lang="mermaid" blockKey={`${blockKey}-fallback`} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">mermaid</div>
      <div className="bg-surface p-3">
        {svg ? (
          <button
            type="button"
            className="block max-w-full rounded text-left focus:outline-none focus:ring-2 focus:ring-ring/45"
            title={t('rightSidebar.openMermaidDiagram')}
            onClick={(event) => {
              event.stopPropagation();
              handleOpen();
            }}
          >
            <span
              ref={diagramRef}
              role="img"
              aria-label={t('rightSidebar.mermaidDiagram')}
              className="block max-h-[70vh] max-w-full overflow-auto rounded bg-white p-2 text-slate-900 [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </button>
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">{t('rightSidebar.renderingDiagram')}</div>
        )}
      </div>
    </div>
  );
}

function MarkdownCodeBlock({ code, lang, blockKey, codeStartLine, lineRange }: MarkdownCodeBlockProps) {
  const language = normalizeMarkdownFenceLanguage(lang);
  const [highlighted, setHighlighted] = useState<ReactNode[][] | null>(null);

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
          setHighlighted(highlightToLines(refractor, code, language));
        } catch {
          if (!cancelled) setHighlighted(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });
    return () => { cancelled = true; };
  }, [blockKey, code, language]);

  const perLine: ReactNode[][] = highlighted ?? (code || ' ').split('\n').map((line) => [line || ' ']);

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      {lang && <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{lang}</div>}
      <pre data-markdown-native-scroll tabIndex={0} className={`${FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS} termdock-code max-w-full overflow-auto p-3 text-[11px] leading-relaxed text-foreground`}><code>{perLine.map((lineNodes, lineIndex) => {
        const lineNo = codeStartLine != null ? codeStartLine + lineIndex : null;
        const selected = Boolean(lineRange && lineNo != null && lineNo >= lineRange.start && lineNo <= lineRange.end);
        return (
          <span
            key={`${blockKey}-line-${lineIndex}`}
            data-md-ref-start={lineNo ?? undefined}
            data-md-ref-end={lineNo ?? undefined}
            data-selected={selected ? 'true' : undefined}
          >
            {lineNodes}{lineIndex < perLine.length - 1 ? '\n' : null}
          </span>
        );
      })}</code></pre>
    </div>
  );
}

export function buildMarkdownPreviewRenderResult(
  lines: string[],
  markdownFilePath: string | null,
  rootPath: string | null,
  onImageOpen?: (index: number) => void,
  labels?: { footnotes: string; backToFootnote: (index: number) => string },
): MarkdownPreviewRenderResult {
  const budget = new MarkdownParseBudget();
  budget.validateLines(lines);
  lines = maskMarkdownHiddenLines(lines);
  const referenceDefinitions = collectMarkdownReferenceDefinitions(lines);
  const footnoteDefinitionLines = collectMarkdownFootnoteDefinitionLineIndexes(lines);
  const images: MarkdownPreviewImage[] = [];
  const context: MarkdownRenderContext = {
    budget,
    markdownFilePath,
    rootPath,
    referenceDefinitions,
    footnoteDefinitions: collectMarkdownFootnoteDefinitions(lines),
    headingSlugCounts: new Map(),
    images,
    onImageOpen,
    footnotesLabel: labels?.footnotes ?? 'Footnotes',
    backToFootnoteLabel: labels?.backToFootnote ?? ((index) => `Back to footnote ${index}`),
  };
  const blocks: MarkdownPreviewBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    context.budget.check();
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

    if (/^<video\b/i.test(trimmed)) {
      const blockStart = index;
      const videoLines = [line];
      index += 1;
      while (!/<\/video\s*>/i.test(videoLines[videoLines.length - 1]) && index < lines.length && lines[index].trim()) {
        context.budget.check();
        videoLines.push(lines[index++]);
      }
      blocks.push({
        key: `video-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <div>{renderMarkdownInline(videoLines.join('\n'), `video-${blockStart}`, true, context)}</div>,
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
        fineGrained: lang.toLowerCase() !== 'mermaid' && !['math', 'latex', 'tex'].includes(lang.toLowerCase()),
        content: lang.toLowerCase() === 'mermaid'
          ? <MarkdownMermaidBlock code={codeLines.join('\n')} blockKey={`code-${blockStart}`} />
          : ['math', 'latex', 'tex'].includes(lang.toLowerCase())
          ? <MarkdownMath tex={codeLines.join('\n')} display />
          : (lineRange) => <MarkdownCodeBlock code={codeLines.join('\n')} lang={lang} blockKey={`code-${blockStart}`} codeStartLine={blockStart + 2} lineRange={lineRange} />,
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
        fineGrained: true,
        content: (lineRange) => <MarkdownCodeBlock code={codeLines.join('\n').replace(/\n+$/, '')} lang="" blockKey={`indented-code-${blockStart}`} codeStartLine={blockStart + 1} lineRange={lineRange} />,
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
      const quoteLineNums: number[] = [];
      const blockStart = index;
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        quoteLineNums.push(index + 1);
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
        const bodyNums = [
          ...(firstLine ? [quoteLineNums[0]] : []),
          ...quoteLineNums.slice(1),
        ];
        const renderedBody = renderMarkdownRefLineNodes(bodyLines, `callout-${blockStart}`, context);
        blocks.push({
          key: `callout-${blockStart}`,
          startLine: blockStart + 1,
          endLine: index,
          fineGrained: true,
          content: (lineRange) => (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-muted-foreground">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">{label}</div>
              {bodyLines.length > 0 && <div>{wrapMarkdownRefLines(renderedBody.perLine, renderedBody.hardBreaks, bodyNums, `callout-${blockStart}`, lineRange)}</div>}
            </aside>
          ),
        });
        continue;
      }
      const quoteRenders = buildMarkdownQuoteNodeRenders(quoteLines, `quote-${blockStart}`, context, quoteLineNums);
      blocks.push({
        key: `quote-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: true,
        content: (lineRange) => (
          <blockquote className="space-y-2 border-l-2 border-border-strong bg-surface-2/70 py-1.5 pl-2.5 pr-2 text-muted-foreground sm:py-2 sm:pl-3">
            {wrapMarkdownQuoteNodes(quoteRenders, lineRange)}
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
      const renderedHeader = header.map((cell, cellIndex) => renderMarkdownInline(cell, `th-${blockStart}-${cellIndex}`, true, context));
      const renderedRows = rows.map((row, rowIndex) => header.map((_, cellIndex) => renderMarkdownInline(row[cellIndex] ?? '', `td-${blockStart}-${rowIndex}-${cellIndex}`, true, context)));
      blocks.push({
        key: `table-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        interactive: false,
        kind: 'table',
        content: (lineRange) => {
          const isSelectedLine = (line: number) => Boolean(lineRange && line >= lineRange.start && line <= lineRange.end);
          return (
            <div className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll data-markdown-native-scroll tabIndex={0} role="region" aria-label="表格，可横向滚动">
              <table className="w-max min-w-full max-w-none table-auto border-collapse text-left text-[11px] sm:text-xs">
                <thead className="bg-surface-2 text-foreground">
                  <tr data-markdown-table-row-line={blockStart + 1} data-md-ref-start={blockStart + 1} data-md-ref-end={blockStart + 1} data-selected={isSelectedLine(blockStart + 1) ? 'true' : undefined}>{renderedHeader.map((cellContent, cellIndex) => <th key={`h-${cellIndex}`} className={`${MARKDOWN_TABLE_HEADER_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{cellContent}</div></th>)}</tr>
                </thead>
                <tbody>
                  {renderedRows.map((row, rowIndex) => {
                    const rowLine = blockStart + rowIndex + 3;
                    return (
                      <tr key={`r-${rowIndex}`} className="border-t border-border/10" data-markdown-table-row-line={rowLine} data-md-ref-start={rowLine} data-md-ref-end={rowLine} data-selected={isSelectedLine(rowLine) ? 'true' : undefined}>
                        {header.map((_, cellIndex) => <td key={`c-${cellIndex}`} className={`${MARKDOWN_TABLE_BODY_CELL_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{row[cellIndex]}</div></td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        },
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
      const listRenders = buildMarkdownListItemRenders(parsed.items, `list-${blockStart}`, context);
      blocks.push({
        key: `list-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: true,
        content: (lineRange) => (
          <ListTag start={ordered ? start : undefined} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 text-muted-foreground marker:text-muted-foreground/70 sm:space-y-1 sm:pl-5`}>
            {wrapMarkdownListItems(listRenders, lineRange)}
          </ListTag>
        ),
      });
      continue;
    }

    const paragraphLines: string[] = [line.trimStart()];
    const paragraphNums: number[] = [index + 1];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      if (parseMarkdownReferenceDefinition(lines[index]) || footnoteDefinitionLines.has(index)) {
        index += 1;
        continue;
      }
      paragraphLines.push(lines[index].trimStart());
      paragraphNums.push(index + 1);
      index += 1;
    }
    const renderedParagraph = renderMarkdownRefLineNodes(paragraphLines, `p-${blockStart}`, context);
    blocks.push({
      key: `p-${blockStart}`,
      startLine: blockStart + 1,
      endLine: index,
      fineGrained: true,
      content: (lineRange) => <p className="text-muted-foreground">{wrapMarkdownRefLines(renderedParagraph.perLine, renderedParagraph.hardBreaks, paragraphNums, `p-${blockStart}`, lineRange)}</p>,
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

  budget.check();
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

export type MarkdownVariant = 'document' | 'prose' | 'compact';

/** Internal rendering contract. Product surfaces use Markdown or MarkdownPreview. */
export interface MarkdownRendererProps {
  variant?: MarkdownVariant;
  /** File preview adds source-line selection controls. */
  referenceLines?: boolean;
  content: string;
  filePath: string | null;
  rootPath: string | null;
  lineRange: { start: number; end: number } | null;
  onLineRangeClick: (event: MouseEvent<HTMLElement>, startLine: number, endLine: number) => void;
  // Drag-to-select on the selection rails: reports the live range while
  // dragging (phase 'move') and the committed range on release (phase 'end').
  onLineRangeDrag?: (event: MouseEvent<HTMLElement>, startLine: number, endLine: number, phase: 'move' | 'end') => void;
  scrollTop: number;
  outlineOpen: boolean;
  outlineCloseSignal?: number;
  onOutlineOpen?: () => void;
  onOutlineClose?: () => void;
  lightboxOpen?: boolean;
  lightboxCloseSignal?: number;
  onLightboxOpen?: () => void;
  onLightboxClose?: () => void;
  onLocalLinkOpen?: (target: MarkdownLocalLinkTarget) => void;
}

// Lightbox variant of the versioned image: same `&v=N` cache-busting as
// MarkdownImage, so an image that changes on disk while the lightbox is open
// reloads instead of showing the bytes captured when it was opened.
function LightboxZoomableImage({ src, alt, onZoomChange, onDoubleTap }: {
  src: string;
  alt: string;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}) {
  const { t } = useI18n();
  const versionedSrc = useVersionedFsBlobSrc(src);
  const business = isBusinessResource(versionedSrc);
  const [resource, setResource] = useState<{ src: string; objectUrl?: string; failed?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!business) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setResource(null);
    // A clicked image needs no worker-claim grace period: fetch through the
    // page immediately and reuse the preview cache after server validation.
    void fetchPreviewResource(versionedSrc, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResource({ src: versionedSrc, objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResource({ src: versionedSrc, failed: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [business, versionedSrc, retry]);

  const current = resource?.src === versionedSrc ? resource : null;
  if (business && !current?.objectUrl) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground" role={current?.failed ? 'alert' : 'status'}>
        {current?.failed ? (
          <div className="flex flex-col items-center gap-3" onClick={(event) => event.stopPropagation()}>
            <span>{t('rightSidebar.imageLoadFailed')}</span>
            <button type="button" className="rounded bg-surface-2 px-3 py-2 hover:bg-surface-elevated" onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</button>
          </div>
        ) : t('rightSidebar.loadingImage')}
      </div>
    );
  }
  return (
    <ZoomableImage
      src={business ? current!.objectUrl! : versionedSrc}
      vector={isSvgImageSrc(src)}
      alt={alt}
      onLoad={() => undefined}
      onError={() => { if (business) setResource({ src: versionedSrc, failed: true }); }}
      onZoomChange={onZoomChange}
      onDoubleTap={onDoubleTap}
    />
  );
}

interface MarkdownImageLightboxProps {
  images: MarkdownPreviewImage[];
  index: number;
  onChange: (index: number) => void;
  onClose: () => void;
}

export function MarkdownImageLightbox({ images, index, onChange, onClose }: MarkdownImageLightboxProps) {
  const { t } = useI18n();
  const active = images[index];
  const canNavigate = images.length > 1;
  const swiperRef = useRef<SwiperInstance | null>(null);
  const lightboxDragRef = useRef<HTMLDivElement | null>(null);
  const closeTapTimerRef = useRef<number | null>(null);
  const suppressTapCloseUntilRef = useRef(0);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const downloadTask = useCallback((signal: AbortSignal) => downloadMarkdownImage(active!, signal), [active]);
  const downloadOwner = active?.kind === 'mermaid' ? active.svg : active?.src;
  const download = useDownloadTask(downloadTask, downloadOwner, !!active);
  const downloadPending = download.status === 'pending';
  const downloadError = download.status === 'error' ? { image: active, message: download.error } : null;
  const handleImageDownload = () => { clearTapCloseTimer(); return download.start(); };

  const clearTapCloseTimer = useCallback(() => {
    if (closeTapTimerRef.current === null) return;
    window.clearTimeout(closeTapTimerRef.current);
    closeTapTimerRef.current = null;
  }, []);

  const scheduleTapClose = useCallback(() => {
    if (imageZoomed || Date.now() < suppressTapCloseUntilRef.current) return;
    clearTapCloseTimer();
    // 450ms gives the second tap of a double-tap time to arrive and veto the
    // close (see ZoomableViewport's pointer-level double-tap detection) —
    // at 300ms the close used to win the race and double-tap "didn't work".
    closeTapTimerRef.current = window.setTimeout(() => {
      closeTapTimerRef.current = null;
      onClose();
    }, 450);
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
      onDragEnd: ({ movement: [mx, my], velocity: [, vy], pinching, canceled }) => {
        setDragging(false);
        if (pinching || canceled || imageZoomed || Math.abs(my) < Math.abs(mx) * 1.15) {
          setDragOffsetY(0);
          return;
        }
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
  const activeTitle = active.title || active.alt || (active.kind === 'mermaid' ? t('rightSidebar.mermaidDiagram') : t('rightSidebar.image'));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={onClose} />
      <div
        className="fixed inset-0 z-modal-panel flex flex-col bg-background-subtle/95 preview-safe-area text-foreground"
        data-markdown-image-lightbox
        data-sidebar-gesture-ignore
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/20 bg-surface/80 px-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{activeTitle}</div>
            <div className="text-[10px] text-muted-foreground">{index + 1} / {images.length}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {downloadPending && <button type="button" onClick={download.cancel} className="min-h-9 rounded-full bg-surface-2 px-3 text-xs">{t('common.cancel')}</button>}
            {canNavigate && (
              <>
                <button
                  type="button"
                  onClick={goPrevious}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label={t('rightSidebar.previousImage')}
                  title={t('common.previous')}
                >
                  <RiArrowLeft size={17} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label={t('rightSidebar.nextImage')}
                  title={t('common.next')}
                >
                  <RiArrowRight size={17} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void handleImageDownload()}
              disabled={downloadPending}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 disabled:opacity-50 disabled:active:scale-100"
              aria-label={t('rightSidebar.downloadFile')}
              title={t('rightSidebar.downloadFile')}
              aria-busy={downloadPending}
            >
              {downloadPending ? <RiLoader size={17} className="animate-spin" /> : <RiDownload size={17} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
              aria-label={t('rightSidebar.closeImagePreview')}
              title={t('common.close')}
            >
              <RiCloseLine size={18} />
            </button>
          </div>
        </div>
        {download.status !== 'error' && <DownloadFeedback status={download.status} error={download.error} />}
        {downloadError?.image === active && (
          <div role="alert" className="flex shrink-0 items-center justify-between gap-3 bg-surface px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 break-words">{t('rightSidebar.downloadFailed')}: {downloadError.message}</span>
            <button type="button" className="shrink-0 rounded bg-surface-2 px-3 py-1 text-foreground hover:bg-surface-elevated" onClick={() => void handleImageDownload()} disabled={downloadPending}>
              {t('common.retry')}
            </button>
          </div>
        )}
        <div
          ref={lightboxDragRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          data-markdown-image-lightbox-stage
          data-sidebar-gesture-ignore
          onClick={(event) => {
            if (Date.now() < suppressTapCloseUntilRef.current) return;
            // The zoom viewport fills the stage, including the empty space
            // beside a fitted image. Keep image taps available for double-tap
            // zoom, but let empty-space clicks close even while zoomed.
            if (event.target instanceof Element && event.target.closest('img, [role="img"]')) {
              scheduleTapClose();
              return;
            }
            clearTapCloseTimer();
            onClose();
          }}
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
              // Swiper handles movement on document: let touch/pointer events
              // bubble there. data-sidebar-gesture-ignore isolates this viewer
              // from the sidebar's navigation gestures.
              onSwiper={(instance) => {
                swiperRef.current = instance;
                instance.allowTouchMove = canNavigate && !imageZoomed;
              }}
              onSlideChange={(instance) => {
                if (instance.activeIndex !== index) onChange(instance.activeIndex);
              }}
              onSliderMove={() => {
                clearTapCloseTimer();
                suppressTapCloseUntilRef.current = Date.now() + 450;
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
              {images.map((image, imageIndex) => (
                <SwiperSlide key={`${image.kind}-${imageIndex}-${image.alt}`} className="h-full">
                  <div className="h-full w-full px-3 py-4 sm:px-6 sm:py-6">
                    {image.kind === 'image' ? (
                      <LightboxZoomableImage
                        src={image.src}
                        alt={image.alt || image.title || t('rightSidebar.markdownImage')}
                        onZoomChange={setImageZoomed}
                        onDoubleTap={clearTapCloseTimer}
                      />
                    ) : (
                      <ZoomableMermaidDiagram
                        svg={image.svg}
                        title={image.title || image.alt || t('rightSidebar.mermaidDiagram')}
                        onZoomChange={setImageZoomed}
                        onDoubleTap={clearTapCloseTimer}
                      />
                    )}
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

export function MarkdownRenderer({
  variant = 'document',
  referenceLines = true,
  content,
  filePath,
  rootPath,
  lineRange,
  onLineRangeClick,
  onLineRangeDrag,
  scrollTop,
  outlineOpen,
  outlineCloseSignal,
  onOutlineOpen,
  onOutlineClose,
  lightboxOpen,
  lightboxCloseSignal,
  onLightboxOpen,
  onLightboxClose,
  onLocalLinkOpen,
}: MarkdownRendererProps) {
  const { t } = useI18n();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [mermaidLightboxImage, setMermaidLightboxImage] = useState<MarkdownPreviewImage | null>(null);
  const [activeHeadingLine, setActiveHeadingLine] = useState<number>(1);
  const [outlineDesktopPos, setOutlineDesktopPos] = useState<{ top: number; right: number } | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const outlineToggleRef = useRef<HTMLButtonElement | null>(null);
  const { blocks, images, parseError } = useMemo(() => {
    try {
      return { ...buildMarkdownPreviewRenderResult(
        content.split('\n'),
        filePath,
        rootPath,
        (index) => {
          setMermaidLightboxImage(null);
          setLightboxIndex(index);
          onLightboxOpen?.();
        },
        {
          footnotes: t('rightSidebar.footnotes'),
          backToFootnote: (index) => t('rightSidebar.backToFootnote', { index }),
        },
      ), parseError: null };
    } catch (error) {
      return { blocks: [], images: [], parseError: error instanceof Error ? error.message : String(error) };
    }
  }, [content, filePath, rootPath, onLightboxOpen, t]);

  useEffect(() => {
    if (parseError) logFilePreviewLoadingEvent('markdown_error', { filePath, rootPath, error: parseError, fallback: 'plain_text' });
  }, [parseError, filePath, rootPath]);
  const lightboxImages = useMemo(
    () => mermaidLightboxImage ? [...images, mermaidLightboxImage] : images,
    [images, mermaidLightboxImage],
  );
  const handleOpenMermaidLightbox = useCallback((svg: string) => {
    const image: MarkdownPreviewImage = {
      kind: 'mermaid',
      svg,
      alt: 'Mermaid diagram',
      title: 'Mermaid diagram',
    };
    setMermaidLightboxImage(image);
    setLightboxIndex(images.length);
    onLightboxOpen?.();
  }, [images.length, onLightboxOpen]);

  useEffect(() => {
    setLightboxIndex(null);
    setMermaidLightboxImage(null);
  }, [content, filePath]);

  useEffect(() => {
    setLightboxIndex(null);
    setMermaidLightboxImage(null);
  }, [lightboxCloseSignal]);

  useEffect(() => {
    if (lightboxOpen === false) {
      setLightboxIndex(null);
      setMermaidLightboxImage(null);
    }
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
  const railDragRef = useRef<{ pointerId: number; anchorLine: number; moved: boolean } | null>(null);
  const trackRailDrag = useDragLifetime(() => { railDragRef.current = null; });
  const railDragSuppressClickRef = useRef(false);

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
    if (isInteractiveTextTarget(event.target)) return;
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
    if (isInteractiveTextTarget(target) || hasNativeTextSelection()) return;
    const range = resolveMarkdownRefRange(target, startLine, endLine);
    onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, range.start, range.end);
  }, [onLineRangeClick]);

  const handleTablePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (tableTapRef.current?.pointerId === event.pointerId) tableTapRef.current = null;
  }, []);

  // Drag-to-select on the per-block selection rails. The anchor line comes
  // from whatever fine-grained target (data-md-ref-*) sits under the pointer;
  // blocks without one interpolate between their first/last source line by
  // vertical position, so dragging stays continuous across block boundaries.
  const resolveLineAtPoint = useCallback((x: number, y: number): number | null => {
    const root = previewRootRef.current;
    if (!root || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(x, y);
    if (!(hit instanceof HTMLElement) || !root.contains(hit)) return null;
    const refTarget = hit.closest<HTMLElement>('[data-md-ref-start]');
    if (refTarget) {
      const line = Number(refTarget.dataset.mdRefStart);
      if (Number.isFinite(line) && line > 0) return line;
    }
    const blockNode = hit.closest<HTMLElement>('[data-markdown-preview-block-start]');
    if (!blockNode) return null;
    const startLine = Number(blockNode.dataset.markdownPreviewBlockStart);
    const block = blocks.find((item) => item.startLine === startLine);
    if (!block) return Number.isFinite(startLine) && startLine > 0 ? startLine : null;
    if (block.endLine <= block.startLine) return block.startLine;
    const rect = blockNode.getBoundingClientRect();
    const ratio = rect.height > 0 ? Math.min(1, Math.max(0, (y - rect.top) / rect.height)) : 0;
    return Math.round(block.startLine + ratio * (block.endLine - block.startLine));
  }, [blocks]);

  const handleRailPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!onLineRangeDrag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Nudge the probe point past the rail column and grid gap so the anchor
    // resolves to the fine-grained line next to the rail rather than the rail
    // itself (widest rail config: 0.875rem column + 0.5rem gap = 22px).
    const anchorLine = resolveLineAtPoint(event.clientX + 24, event.clientY);
    if (anchorLine == null) return;
    trackRailDrag(event);
    railDragRef.current = { pointerId: event.pointerId, anchorLine, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom and older browsers may not support pointer capture; dragging
      // still works as long as the pointer stays over the rail.
    }
  }, [onLineRangeDrag, resolveLineAtPoint, trackRailDrag]);

  const handleRailPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !onLineRangeDrag) return;
    const currentLine = resolveLineAtPoint(event.clientX + 16, event.clientY);
    if (currentLine == null) return;
    if (!drag.moved && currentLine === drag.anchorLine) return;
    drag.moved = true;
    railDragSuppressClickRef.current = true;
    onLineRangeDrag(
      event as unknown as MouseEvent<HTMLElement>,
      Math.min(drag.anchorLine, currentLine),
      Math.max(drag.anchorLine, currentLine),
      'move',
    );
  }, [onLineRangeDrag, resolveLineAtPoint]);

  const handleRailPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    railDragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId || !onLineRangeDrag) return;
    if (!drag.moved) return; // plain click — the block click handler toggles the reference
    const currentLine = resolveLineAtPoint(event.clientX + 16, event.clientY) ?? drag.anchorLine;
    onLineRangeDrag(
      event as unknown as MouseEvent<HTMLElement>,
      Math.min(drag.anchorLine, currentLine),
      Math.max(drag.anchorLine, currentLine),
      'end',
    );
  }, [onLineRangeDrag, resolveLineAtPoint]);

  const handleRailPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  }, []);

  const railDragHandlers = {
    onPointerDown: handleRailPointerDown,
    onPointerMove: handleRailPointerMove,
    onPointerUp: handleRailPointerUp,
    onPointerCancel: handleRailPointerCancel,
  };

  // A drag that selected a range ends with a click event bubbling to the
  // block/rail click handlers; swallow that one click so the freshly dragged
  // range isn't toggled away.
  const consumeRailDragClick = (): boolean => {
    if (!railDragSuppressClickRef.current) return false;
    railDragSuppressClickRef.current = false;
    return true;
  };

  if (parseError) {
    return <div className="min-w-0 max-w-full px-4 py-4 text-sm leading-6 text-foreground" data-markdown-preview-fallback>
      <p role="alert" className="mb-3 text-destructive">{t('rightSidebar.markdownParseFailed')}</p>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">{content}</pre>
    </div>;
  }

  if (blocks.length === 0) {
    return <div className="min-w-0 max-w-full px-4 py-4 text-sm leading-6 text-foreground"><p className="text-muted-foreground">{t('rightSidebar.emptyFile')}</p></div>;
  }

  return (
    <>
      <div
        ref={previewRootRef}
        className="termdock-markdown relative min-w-0 max-w-full"
        data-markdown-variant={variant}
        onClickCapture={(event) => {
          const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
          if (!anchor || !onLocalLinkOpen) return;
          const href = anchor.getAttribute('href');
          if (!href) return;
          const target = resolveMarkdownLocalLinkTarget(href, filePath, rootPath);
          if (!target) return;
          event.preventDefault();
          onLocalLinkOpen(target);
        }}
      >
        {referenceLines && activeHeadingPath.length > 0 && (
          <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-1 shadow-sm sm:px-3" data-markdown-heading-sticky>
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
        {outlineOpen && typeof document !== 'undefined' && createPortal(
          <>
            <div className="fixed inset-0 z-menu-backdrop bg-[rgb(var(--background-rgb)_/_0.18)] sm:hidden" onClick={onOutlineClose} />
            <div
              className="hidden fixed z-menu-panel min-h-0 flex-col w-80 max-w-[min(20rem,calc(100vw-var(--safe-left-inset,0px)-var(--safe-right-inset,0px)-1rem))] rounded-lg border border-border/20 bg-surface p-2 shadow-xl sm:flex"
              style={outlineDesktopPos ? { top: `max(var(--safe-top-inset, 0px), ${outlineDesktopPos.top}px)`, right: `max(var(--safe-right-inset, 0px), ${outlineDesktopPos.right}px)`, maxHeight: `calc(100dvh - max(var(--safe-top-inset, 0px), ${outlineDesktopPos.top}px) - var(--safe-bottom-inset, 0px) - 8px)` } : { top: -9999, right: -9999 }}
              data-markdown-heading-outline-desktop
            >
              <div className="min-h-0 max-h-72 overflow-auto pr-1">
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
              className="fixed inset-x-0 bottom-0 z-drawer-panel flex min-h-0 max-h-[min(74dvh,34rem,calc(100dvh-var(--safe-top-inset,0px)))] flex-col rounded-t-xl border border-border/20 bg-surface p-2 pl-[max(0.5rem,var(--safe-left-inset,env(safe-area-inset-left,0px)))] pr-[max(0.5rem,var(--safe-right-inset,env(safe-area-inset-right,0px)))] pb-[calc(0.5rem+var(--safe-bottom-inset,env(safe-area-inset-bottom,0px)))] shadow-[0_-18px_48px_var(--app-shadow-strong)] sm:hidden"
              data-markdown-heading-outline-mobile
            >
              <div className="mb-1 flex shrink-0 items-center justify-between gap-2 px-1.5 py-1 sm:hidden">
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
              <div className="min-h-0 overflow-auto overscroll-contain pr-1">
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
          </>,
          document.body,
        )}
        <div className={`min-w-0 max-w-full overflow-x-hidden break-words text-foreground ${variant !== 'document' ? 'space-y-3' : 'space-y-1.5 px-1.5 py-3 text-[13px] leading-5 sm:space-y-2 sm:px-2 sm:py-4 sm:text-sm sm:leading-6'}`}>
        <MarkdownMermaidOpenContext.Provider value={handleOpenMermaidLightbox}>
        {blocks.map((block) => {
          const intersects = Boolean(lineRange && block.startLine <= lineRange.end && block.endLine >= lineRange.start);
          const wholeSelected = Boolean(lineRange && lineRange.start <= block.startLine && lineRange.end >= block.endLine);
          // Fine-grained blocks highlight the exact referenced lines inside,
          // so the block-wide wash and full-height rail only appear when the
          // whole block is referenced. Blocks without inner targets light up
          // as a whole on any overlap.
          const blockSelected = block.kind === 'table' ? false : (block.fineGrained ? wholeSelected : intersects);
          const tableWholeSelected = Boolean(block.kind === 'table' && lineRange?.start === block.startLine && lineRange.end === block.endLine);
          // Segment of the selection rail matching the referenced lines, so a
          // partial selection lights only its own slice of the rail.
          let railSegment: ReactNode = null;
          if (block.kind !== 'table' && block.fineGrained && intersects && !wholeSelected && lineRange) {
            const lineCount = block.endLine - block.startLine + 1;
            const segmentStart = Math.max(lineRange.start, block.startLine);
            const segmentEnd = Math.min(lineRange.end, block.endLine);
            const segmentTop = (segmentStart - block.startLine) / lineCount;
            const segmentHeight = (segmentEnd - segmentStart + 1) / lineCount;
            railSegment = (
              <span
                aria-hidden="true"
                data-md-rail-segment
                className="absolute left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary transition sm:w-1"
                style={{
                  top: `calc(0.25rem + (100% - 0.5rem) * ${segmentTop})`,
                  height: `calc((100% - 0.5rem) * ${segmentHeight})`,
                }}
              />
            );
          }
          const renderedContent = typeof block.content === 'function' ? block.content(lineRange) : block.content;
          if (!referenceLines) return <div key={block.key} data-markdown-preview-block-start={block.startLine} className="min-w-0 cursor-text select-text py-0.5">{renderedContent}</div>;
          const lineLabel = block.startLine === block.endLine ? String(block.startLine) : `${block.startLine}-${block.endLine}`;
          const blockContent = (
            <>
              <span
                className={getReferenceSelectionRailShellClass(blockSelected)}
                aria-hidden="true"
                {...railDragHandlers}
              >
                <span className={getReferenceSelectionRailBarClass(blockSelected)} />
                {railSegment}
              </span>
              <div className="min-w-0" data-sidebar-selectable>{renderedContent}</div>
            </>
          );
          if (block.interactive === false) {
            return (
              <div
                key={block.key}
                data-markdown-preview-block-start={block.startLine}
                className={`group grid w-full grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${blockSelected ? 'bg-primary/10' : ''}`}
                title={`Line ${lineLabel}`}
                aria-label={`Line ${lineLabel}`}
              >
                {block.kind === 'table' ? (
                  <button
                    type="button"
                    className={getReferenceSelectionRailShellClass(tableWholeSelected, 'self')}
                    onClick={(event) => {
                      event.preventDefault();
                      if (consumeRailDragClick()) return;
                      onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
                    }}
                    title={`Reference table lines ${lineLabel}`}
                    aria-label={`Reference table lines ${lineLabel}`}
                    {...railDragHandlers}
                  >
                    <span className={getReferenceSelectionRailBarClass(tableWholeSelected, 'self')} />
                  </button>
                ) : (
                  <span
                    className={getReferenceSelectionRailShellClass(blockSelected, 'none')}
                    aria-hidden="true"
                    {...railDragHandlers}
                  >
                    <span className={getReferenceSelectionRailBarClass(blockSelected, 'none')} />
                    {railSegment}
                  </span>
                )}
                <div
                  className="min-w-0 cursor-text select-text"
                  data-sidebar-selectable
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
                  {renderedContent}
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
                if (isInteractiveTextTarget(target) || hasNativeTextSelection()) return;
                if (consumeRailDragClick()) return;
                const range = resolveMarkdownRefRange(target, block.startLine, block.endLine);
                onLineRangeClick(event, range.start, range.end);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
              }}
              className={`group grid w-full cursor-pointer grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition active:scale-[0.998] sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${blockSelected ? 'bg-primary/10' : 'hover:bg-[var(--surface-2)]'}`}
              title={`Reference line ${lineLabel}`}
              aria-label={`Reference line ${lineLabel}`}
            >
              {blockContent}
            </div>
          );
        })}
        </MarkdownMermaidOpenContext.Provider>
        </div>
      </div>
      {lightboxOpen !== false && lightboxIndex !== null && lightboxImages[lightboxIndex] && (
        <MarkdownImageLightbox
          images={lightboxImages}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => {
            setLightboxIndex(null);
            setMermaidLightboxImage(null);
            onLightboxClose?.();
          }}
        />
      )}
    </>
  );
}

function getReferenceSelectionRailShellClass(selected: boolean, hover: 'group' | 'self' | 'none' = 'group'): string {
  const hoverClass = hover === 'group'
    ? 'group-hover:bg-[var(--surface-elevated)]'
    : hover === 'self' ? 'hover:bg-[var(--surface-elevated)]' : '';
  // touch-none: drags starting on a rail are line-range selections, so the
  // browser must not hijack the gesture for scrolling. relative: anchors the
  // partial-selection rail segment (data-md-rail-segment). Selected state is
  // a primary tint so it reads as "referenced", not as yet another gray.
  return `relative flex min-h-5 w-full touch-none select-none items-stretch justify-center rounded transition sm:min-h-6 ${selected ? 'bg-primary/20' : `bg-[var(--surface-2)] ${hoverClass}`}`;
}

function getReferenceSelectionRailBarClass(selected: boolean, hover: 'group' | 'self' | 'none' = 'group'): string {
  const hoverClass = hover === 'group'
    ? 'group-hover:bg-[var(--muted-foreground)]'
    : hover === 'self' ? 'hover:bg-[var(--muted-foreground)]' : '';
  return `my-1 w-0.5 rounded-full transition sm:w-1 ${selected ? 'bg-primary' : `bg-[var(--border-strong)] ${hoverClass}`}`;
}

function isInteractiveTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a, button, input, textarea, select, label, [contenteditable="true"]'));
}

// Resolve the source line range referenced by a click inside a Markdown
// preview block: the nearest element stamped with data-md-ref-start/end (a
// paragraph line, list item, quote line, code line, table row) wins, so
// references land on exactly what was tapped instead of the whole block.
function resolveMarkdownRefRange(
  target: EventTarget | null,
  fallbackStart: number,
  fallbackEnd: number,
): { start: number; end: number } {
  const refTarget = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-md-ref-start]') : null;
  const start = Number(refTarget?.dataset.mdRefStart);
  const end = Number(refTarget?.dataset.mdRefEnd ?? refTarget?.dataset.mdRefStart);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > 0) {
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }
  return { start: fallbackStart, end: fallbackEnd };
}

const IMAGE_MIN_SCALE = 1;
const IMAGE_MAX_SCALE = 8;

function clampImageScale(scale: number, maxScale = IMAGE_MAX_SCALE): number {
  return Math.min(maxScale, Math.max(IMAGE_MIN_SCALE, scale));
}

interface ZoomableImageProps {
  src: string;
  alt: string;
  /** Content is a vector image (SVG) — allows upscaling to fit the stage. */
  vector?: boolean;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onError: () => void;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}

interface ZoomableViewportProps {
  resetKey: string;
  maxScale?: number;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
  children: (state: {
    transformStyle: CSSProperties;
    vectorTransformStyle: CSSProperties;
    scale: number;
    zoomed: boolean;
    animateTransform: boolean;
  }) => ReactNode;
}

// Pinch-to-zoom viewer. Supports touch pinch (mobile), trackpad pinch,
// ctrl/⌘ + wheel (desktop), two-axis trackpad panning while zoomed, and
// double-tap / double-click to toggle zoom. The container carries
// `data-sidebar-gesture-ignore` only while zoomed, so pans of enlarged content
// are never hijacked — while an unzoomed horizontal swipe still flows to the
// sidebar's gesture arbiter (e.g. swiper back-navigation).
function ZoomableViewport({ resetKey, maxScale = IMAGE_MAX_SCALE, onZoomChange, onDoubleTap, children }: ZoomableViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [animateTransform, setAnimateTransform] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const activePointersRef = useRef<Set<number>>(new Set());
  const trackImagePointer = useDragLifetime((_reason, pointerId) => {
    if (!activePointersRef.current.delete(pointerId)) return;
    dragRef.current = null;
    lastTapRef.current = null;
    sequenceWasMultiRef.current = true;
  }, true);
  const sequenceWasMultiRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const manualDoubleTapAtRef = useRef(0);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Reset when the active content changes (a new file/diagram was selected).
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [resetKey]);

  // Clamp the pan offset so the (scaled) content can't be dragged completely
  // out of the viewport. Uses the content element's real layout size — with
  // fit-to-stage sizing the content no longer necessarily matches the
  // viewport, and oversized content allows proportionally more pan.
  const clampOffset = useCallback((scale: number, x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return { x, y };
    const content = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null;
    const contentWidth = content?.clientWidth || el.clientWidth;
    const contentHeight = content?.clientHeight || el.clientHeight;
    const maxX = Math.max(0, (contentWidth * scale - el.clientWidth) / 2);
    const maxY = Math.max(0, (contentHeight * scale - el.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, []);

  const applyZoom = useCallback((nextScale: number, originX?: number, originY?: number) => {
    setTransform((prev) => {
      const scale = clampImageScale(nextScale, maxScale);
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
  }, [clampOffset, maxScale]);

  const toggleZoom = useCallback((originX?: number, originY?: number) => {
    setAnimateTransform(true);
    if (transformRef.current.scale > 1) {
      setTransform({ scale: 1, x: 0, y: 0 });
    } else {
      applyZoom(2.5, originX, originY);
    }
    window.setTimeout(() => setAnimateTransform(false), 220);
  }, [applyZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // NOTE: no stopPropagation on pointerdown/move except for the ACTIVE
    // single-finger pan. The pinch listener (use-gesture, below) attaches in
    // the bubble phase on this same element, and a capture-phase
    // stopPropagation starves it — that used to kill pinch-to-zoom entirely
    // whenever the touch landed on the image itself.
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      trackImagePointer(event, el);
      const isFirstPointer = activePointersRef.current.size === 0;
      activePointersRef.current.add(event.pointerId);

      // Manual double-tap detection instead of relying on dblclick: a second
      // tap within 350ms / 24px toggles zoom and vetoes the lightbox's
      // tap-to-close (whose timer would otherwise win the race on touch).
      if (isFirstPointer) {
        const now = Date.now();
        const last = lastTapRef.current;
        if (last && now - last.time < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 24) {
          lastTapRef.current = null;
          manualDoubleTapAtRef.current = now;
          onDoubleTap?.();
          toggleZoom(event.clientX, event.clientY);
          return;
        }
      }

      // A second finger ends any single-finger pan — the pinch gesture owns
      // the sequence from here.
      if (activePointersRef.current.size > 1) {
        sequenceWasMultiRef.current = true;
        dragRef.current = null;
        return;
      }

      if (transformRef.current.scale <= 1) return;
      event.preventDefault();
      // Pending pan: only engages once the finger moves past the tap
      // threshold — otherwise the pointer-up counts as a tap (and can form a
      // double-tap to zoom back out).
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: transformRef.current.x,
        originY: transformRef.current.y,
        moved: false,
      };
      try {
        el.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture can fail for synthetic or already-captured pointers;
        // window-level move/up listeners still keep panning functional.
      }
      setAnimateTransform(false);
    };

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
      }
      // Only the ACTIVE pan swallows the event — pinch pointers must keep
      // flowing to the gesture listeners.
      event.stopPropagation();
      event.preventDefault();
      setTransform((prev) => ({
        ...prev,
        ...clampOffset(prev.scale, drag.originX + dx, drag.originY + dy),
      }));
    };

    const handlePointerEnd = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      const wasPanPointer = drag?.pointerId === event.pointerId && drag.moved;
      if (drag?.pointerId === event.pointerId) {
        if (drag.moved) event.stopPropagation();
        dragRef.current = null;
        try {
          el.releasePointerCapture?.(event.pointerId);
        } catch {
          // Best effort only; a missing capture should not break pan cleanup.
        }
      }
      if (!activePointersRef.current.delete(event.pointerId)) return;
      if (activePointersRef.current.size === 0) {
        // A completed single-pointer, non-pan sequence is a tap candidate for
        // double-tap detection. Pinch and pan sequences are not.
        if (!sequenceWasMultiRef.current && !wasPanPointer) {
          lastTapRef.current = { time: Date.now(), x: event.clientX, y: event.clientY };
        }
        sequenceWasMultiRef.current = false;
      }
    };

    el.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', handlePointerEnd, { capture: true });
    window.addEventListener('pointercancel', handlePointerEnd, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerup', handlePointerEnd, { capture: true });
      window.removeEventListener('pointercancel', handlePointerEnd, { capture: true });
    };
  }, [clampOffset, onDoubleTap, toggleZoom, trackImagePointer]);

  useGesture(
    {
      onPinch: ({ offset: [scale], origin: [ox, oy] }) => {
        setAnimateTransform(false);
        applyZoom(scale, ox, oy);
      },
      onWheel: ({ event, delta: [dx, dy], ctrlKey }) => {
        // Trackpad pinch surfaces as a wheel event with ctrlKey on most
        // browsers. Once zoomed, an unmodified two-finger gesture should move
        // the image like a native canvas in both axes. Keeping each incoming
        // wheel delta intact also preserves the trackpad's OS-level momentum.
        if (ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          setAnimateTransform(false);
          applyZoom(transformRef.current.scale * (1 - dy * 0.01), event.clientX, event.clientY);
          return;
        }
        if (transformRef.current.scale <= 1) return;
        event.preventDefault();
        event.stopPropagation();
        setAnimateTransform(false);
        setTransform((prev) => ({
          ...prev,
          ...clampOffset(prev.scale, prev.x - dx, prev.y - dy),
        }));
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
      pinch: {
        scaleBounds: { min: IMAGE_MIN_SCALE, max: maxScale },
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
      data-sidebar-gesture-ignore={zoomed ? '' : undefined}
      className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
      data-image-zoom-viewport
      style={{ cursor: zoomed ? 'grab' : 'zoom-in' }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        // The pointer-level double-tap detection already toggled zoom for
        // this sequence — don't let the trailing dblclick toggle it back.
        if (Date.now() - manualDoubleTapAtRef.current < 500) return;
        onDoubleTap?.();
        toggleZoom(event.clientX, event.clientY);
      }}
    >
      {children({
        scale: transform.scale,
        zoomed,
        animateTransform,
        transformStyle: {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center center',
          transition: animateTransform ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
          willChange: 'transform',
        },
        // Scaling an SVG's composited layer makes WebKit/Chromium reuse the
        // rasterization created at scale=1. Vector viewers instead use this
        // translation-only style and grow the SVG's layout box, which forces
        // a fresh vector paint at every zoom level.
        vectorTransformStyle: {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          transformOrigin: 'center center',
          transition: animateTransform ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
        },
      })}
    </div>
  );
}

// Keep the fit-sized surface as the pan boundary, but grow the image's layout
// box when zooming. Scaling a composited thumbnail can stay blurry in WebKit.
export function ZoomableImage({ src, alt, vector, onLoad, onError, onZoomChange, onDoubleTap }: ZoomableImageProps) {
  const mediaSrc = useEncryptedMediaSource(src, onError);
  const [fitSize, setFitSize] = useState<{ width: number; height: number; originalScale: number } | null>(null);
  // blob: object URLs carry no extension, so callers with a known MIME type
  // pass `vector` explicitly; otherwise fall back to the URL's .svg suffix.
  const isVector = vector ?? isSvgImageSrc(src);

  useEffect(() => {
    setFitSize(null);
  }, [src]);

  return (
    <ZoomableViewport
      resetKey={src}
      // A very long image may need more than 8× its fitted size to reach its
      // original resolution. Keep that resolution reachable by pinching.
      maxScale={Math.max(IMAGE_MAX_SCALE, fitSize?.originalScale ?? 1)}
      onZoomChange={onZoomChange}
      onDoubleTap={onDoubleTap}
    >
      {({ vectorTransformStyle, scale, animateTransform }) => (
        <div
          data-image-zoom-surface
          data-vector-zoom-surface={isVector ? '' : undefined}
          className="relative shrink-0 touch-none select-none"
          style={fitSize
            ? { ...vectorTransformStyle, width: fitSize.width, height: fitSize.height }
            : { width: '100%', height: '100%' }}
        >
          <img
            src={mediaSrc}
            alt={alt}
            draggable={false}
            className="touch-none select-none rounded border border-border/15 bg-surface object-contain shadow-sm"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: fitSize ? fitSize.width * scale : undefined,
              height: fitSize ? fitSize.height * scale : undefined,
              maxWidth: fitSize ? 'none' : '100%',
              maxHeight: fitSize ? 'none' : '100%',
              // Use layout dimensions for raster images too: the browser
              // repaints from the decoded original at the current zoom.
              transform: 'translate(-50%, -50%)',
              transition: animateTransform ? 'width 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), height 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
            }}
            onLoad={(event) => {
              const img = event.currentTarget;
              const container = img.closest<HTMLElement>('[data-image-zoom-viewport]');
              if (container && img.naturalWidth > 0 && img.naturalHeight > 0) {
                const availableWidth = Math.max(1, container.clientWidth - 2);
                const availableHeight = Math.max(1, container.clientHeight - 2);
                const fitScale = Math.min(availableWidth / img.naturalWidth, availableHeight / img.naturalHeight);
                const nextScale = isVector ? fitScale : Math.min(fitScale, 1);
                setFitSize({
                  width: img.naturalWidth * nextScale,
                  height: img.naturalHeight * nextScale,
                  originalScale: 1 / nextScale,
                });
              }
              onLoad(event);
            }}
            onError={onError}
          />
        </div>
      )}
    </ZoomableViewport>
  );
}

function ZoomableMermaidContent({
  svg,
  title,
  scale,
  vectorTransformStyle,
}: {
  svg: string;
  title: string;
  scale: number;
  vectorTransformStyle: CSSProperties;
}) {
  const diagramRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = diagramRef.current;
    const svgNode = root?.querySelector<SVGSVGElement>('svg');
    if (!root || !svgNode) return;

    const fitSvg = () => {
      const viewBox = svgNode.getAttribute('viewBox');
      const values = viewBox?.trim().split(/[\s,]+/).map(Number) ?? [];
      let width = values[2];
      let height = values[3];
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        width = Number(svgNode.getAttribute('width'));
        height = Number(svgNode.getAttribute('height'));
      }
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

      const availableWidth = Math.max(1, root.clientWidth - 24);
      const availableHeight = Math.max(1, root.clientHeight - 24);
      const fitScale = Math.min(availableWidth / width, availableHeight / height, 1);
      svgNode.style.width = `${Math.max(1, Math.floor(width * fitScale * scale))}px`;
      svgNode.style.height = `${Math.max(1, Math.floor(height * fitScale * scale))}px`;
      svgNode.style.maxWidth = 'none';
      svgNode.style.maxHeight = 'none';
      svgNode.style.transform = String(vectorTransformStyle.transform ?? '');
      svgNode.style.transformOrigin = 'center center';
      svgNode.style.transition = String(vectorTransformStyle.transition ?? 'none');
    };

    fitSvg();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitSvg);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [scale, svg, vectorTransformStyle]);

  return (
    <div
      ref={diagramRef}
      role="img"
      aria-label={title}
      className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden rounded border border-border/15 bg-white p-3 text-slate-900 shadow-sm [&_svg]:block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function ZoomableMermaidDiagram({ svg, title, onZoomChange, onDoubleTap }: {
  svg: string;
  title: string;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}) {
  return (
    <ZoomableViewport resetKey={svg} onZoomChange={onZoomChange} onDoubleTap={onDoubleTap}>
      {({ vectorTransformStyle, scale }) => (
        <ZoomableMermaidContent
          svg={svg}
          title={title}
          scale={scale}
          vectorTransformStyle={vectorTransformStyle}
        />
      )}
    </ZoomableViewport>
  );
}

export function logFilePreviewLoadingEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: event === 'still_active' ? 'warn' : 'info',
    message: `FILE_PREVIEW_LOADING ${event}`,
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
