// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFilePreviewSearchHighlights, collectFilePreviewSearchRanges, ownsFilePreviewSearchShortcut, paintFilePreviewSearchHighlights, FILE_PREVIEW_SEARCH_HIGHLIGHT, resolveFilePreviewSearchShortcut } from './filePreviewSearch';

afterEach(() => {
  clearFilePreviewSearchHighlights();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('file preview search', () => {
  it('maps desktop find shortcuts to file-search actions', () => {
    expect(resolveFilePreviewSearchShortcut({ key: 'f', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('open');
    expect(resolveFilePreviewSearchShortcut({ key: 'F', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('open');
    expect(resolveFilePreviewSearchShortcut({ key: 'g', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('next');
    expect(resolveFilePreviewSearchShortcut({ key: 'g', metaKey: false, ctrlKey: true, shiftKey: true })).toBe('previous');
    expect(resolveFilePreviewSearchShortcut({ key: 'F3', metaKey: false, ctrlKey: false, shiftKey: true })).toBe('previous');
    expect(resolveFilePreviewSearchShortcut({ key: 'Escape', metaKey: false, ctrlKey: false, shiftKey: false })).toBe('close');
  });

  it('rejects hidden, inactive, detached, outside and consumed shortcut owners', () => {
    const root = document.createElement('div'); const input = document.createElement('input');
    root.append(input); document.body.append(root);
    const event = { target: input, defaultPrevented: false };
    expect(ownsFilePreviewSearchShortcut(root, true, event)).toBe(true);
    expect(ownsFilePreviewSearchShortcut(root, false, event)).toBe(false);
    expect(ownsFilePreviewSearchShortcut(root, true, { ...event, defaultPrevented: true })).toBe(false);
    expect(ownsFilePreviewSearchShortcut(root, true, { ...event, target: document.body })).toBe(false);
    for (const attr of ['hidden', 'inert', 'aria-hidden']) {
      root.setAttribute(attr, attr === 'aria-hidden' ? 'true' : '');
      expect(ownsFilePreviewSearchShortcut(root, true, event)).toBe(false);
      root.removeAttribute(attr);
    }
    root.remove(); expect(ownsFilePreviewSearchShortcut(root, true, event)).toBe(false);
  });

  it('keeps the current owner highlights when another retained preview cleans up', () => {
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) {} });
    const previous = {}; const current = {};
    paintFilePreviewSearchHighlights([], 0, previous);
    paintFilePreviewSearchHighlights([], 0, current);
    const painted = highlights.get(FILE_PREVIEW_SEARCH_HIGHLIGHT);
    clearFilePreviewSearchHighlights(previous);
    expect(highlights.get(FILE_PREVIEW_SEARCH_HIGHLIGHT)).toBe(painted);
    clearFilePreviewSearchHighlights(current);
    expect(highlights.has(FILE_PREVIEW_SEARCH_HIGHLIGHT)).toBe(false);
  });

  it('finds case-insensitive matches in source lines without crossing line boundaries', () => {
    document.body.innerHTML = `
      <div id="preview">
        <div data-file-preview-line="1"><span>Hello</span> world</div>
        <div data-file-preview-line="2">WORLD hello</div>
      </div>
    `;
    const root = document.querySelector<HTMLElement>('#preview');
    expect(root).toBeTruthy();
    const ranges = collectFilePreviewSearchRanges(root!, 'hello');
    expect(ranges.map((range) => range.toString())).toEqual(['Hello', 'hello']);
    expect(collectFilePreviewSearchRanges(root!, 'worldWORLD')).toHaveLength(0);
  });

  it('matches across inline Markdown nodes within the same preview block', () => {
    document.body.innerHTML = `
      <div id="preview">
        <p data-markdown-preview-block-start="1">Search <strong>inside</strong> Markdown</p>
        <p data-markdown-preview-block-start="2">another block</p>
      </div>
    `;
    const root = document.querySelector<HTMLElement>('#preview');
    expect(root).toBeTruthy();
    const ranges = collectFilePreviewSearchRanges(root!, 'search inside markdown');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('Search inside Markdown');
  });
});
