export const FILE_PREVIEW_SEARCH_HIGHLIGHT = 'termdock-file-search-match';
export const FILE_PREVIEW_SEARCH_CURRENT_HIGHLIGHT = 'termdock-file-search-current';

export type FilePreviewSearchShortcut = 'open' | 'next' | 'previous' | 'close';

export function resolveFilePreviewSearchShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): FilePreviewSearchShortcut | null {
  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLocaleLowerCase();
  if (modifier && key === 'f') return 'open';
  if ((modifier && key === 'g') || event.key === 'F3') return event.shiftKey ? 'previous' : 'next';
  if (event.key === 'Escape') return 'close';
  return null;
}

interface SearchTextSegment {
  node: Text;
  start: number;
  end: number;
  group: Element;
}

function getSearchGroup(node: Text): Element | null {
  return node.parentElement?.closest('[data-markdown-preview-block-start], [data-file-preview-line]') ?? null;
}

/**
 * Finds visible preview matches while preserving ranges across inline Markdown
 * nodes (for example, text split by emphasis or links). Separate source lines
 * and Markdown blocks get a newline boundary so matches never join unrelated
 * parts of the document.
 */
export function collectFilePreviewSearchRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const segments: SearchTextSegment[] = [];
  let searchableText = '';
  let previousGroup: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data) continue;
    const group = getSearchGroup(node);
    if (!group) continue;
    if (previousGroup && previousGroup !== group) searchableText += '\n';
    const start = searchableText.length;
    searchableText += node.data;
    segments.push({ node, start, end: searchableText.length, group });
    previousGroup = group;
  }

  const haystack = searchableText.toLocaleLowerCase();
  const ranges: Range[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const matchStart = haystack.indexOf(needle, from);
    if (matchStart < 0) break;
    const matchEnd = matchStart + needle.length;
    const first = segments.find((segment) => segment.start <= matchStart && segment.end > matchStart);
    const last = segments.find((segment) => segment.start < matchEnd && segment.end >= matchEnd);
    if (first && last && first.group === last.group) {
      const range = document.createRange();
      range.setStart(first.node, matchStart - first.start);
      range.setEnd(last.node, matchEnd - last.start);
      ranges.push(range);
    }
    from = matchStart + Math.max(needle.length, 1);
  }
  return ranges;
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights : null;
}

export function clearFilePreviewSearchHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(FILE_PREVIEW_SEARCH_HIGHLIGHT);
  registry?.delete(FILE_PREVIEW_SEARCH_CURRENT_HIGHLIGHT);
}

export function paintFilePreviewSearchHighlights(ranges: Range[], currentIndex: number): void {
  const registry = highlightRegistry();
  if (!registry || typeof Highlight === 'undefined') return;
  registry.set(FILE_PREVIEW_SEARCH_HIGHLIGHT, new Highlight(...ranges));
  const current = ranges[currentIndex];
  if (current) registry.set(FILE_PREVIEW_SEARCH_CURRENT_HIGHLIGHT, new Highlight(current));
  else registry.delete(FILE_PREVIEW_SEARCH_CURRENT_HIGHLIGHT);
}

export function scrollFilePreviewSearchRangeIntoView(range: Range | undefined): void {
  const element = range?.startContainer.parentElement;
  element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}
