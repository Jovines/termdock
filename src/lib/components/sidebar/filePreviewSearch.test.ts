// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { clearFilePreviewSearchHighlights, collectFilePreviewSearchRanges, resolveFilePreviewSearchShortcut } from './filePreviewSearch';

afterEach(() => {
  clearFilePreviewSearchHighlights();
  document.body.replaceChildren();
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
