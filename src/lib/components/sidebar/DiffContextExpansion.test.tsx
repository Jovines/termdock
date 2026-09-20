// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseDiff } from 'react-diff-view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffViewer } from './DiffViewer';
import { contextGap, expandContext, sourceLines } from './diffContextExpansion';

vi.mock('./diffWorkerClient', () => ({
  parseDiffInWorker: async (diff: string) => ({ files: parseDiff(diff), tokens: new Map(), parseMs: 0, tokenizeMs: 0 }),
}));

const source = Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const patch = `diff --git a/example.txt b/example.txt
--- a/example.txt
+++ b/example.txt
@@ -30,3 +30,4 @@
 line 30
-line 31
+replacement 31
+extra line
 line 32
@@ -60,3 +61,3 @@
 line 60
-line 61
+replacement 61
 line 62
`;

afterEach(cleanup);

describe('diff context expansion', () => {
  it('keeps line coordinates after insertions and stops where adjacent context meets', () => {
    const hunks = parseDiff(patch)[0].hunks;
    const lines = sourceLines(source);
    const first = expandContext(hunks[0], lines, { before: 20, after: 20 });
    const second = expandContext(hunks[1], lines, { before: 7, after: 0 });
    expect(first.changes[0]).toMatchObject({ content: 'line 10', oldLineNumber: 10, newLineNumber: 10 });
    expect(first.changes.at(-1)).toMatchObject({ content: 'line 52', oldLineNumber: 52, newLineNumber: 53 });
    expect(second.changes[0]).toMatchObject({ content: 'line 53', oldLineNumber: 53, newLineNumber: 54 });
    expect(contextGap([first, second], 0, 'after', lines.length)).toBe(0);
    expect(contextGap([first, second], 1, 'before', lines.length)).toBe(0);
    expect(hunks[0].oldStart).toBe(30);
    expect(sourceLines('a\n')).toEqual(['a']);
    expect(sourceLines('a\n\n')).toEqual(['a', '']);
  });

  it.each(['unified', 'split'] as const)('expands both boundaries repeatedly in %s without duplicating adjacent context', async (viewType) => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })) });
    const onInsert = vi.fn();
    const { container, rerender } = render(<DiffViewer filePath="example.txt" diffOverride={patch} oldSourceOverride={source} viewType={viewType} inlineMode="none" onInsertDiffReference={onInsert} embedded />);
    await waitFor(() => expect(container.querySelectorAll('[data-diff-hunk-anchor]')).toHaveLength(2));
    expect(container.textContent).not.toContain('line 10');
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 20 lines above' })[0]);
    expect(container.textContent).toContain('line 10');
    fireEvent.click(container.querySelector('.diff-code[data-change-key="N10"]')!);
    fireEvent.click(screen.getByTitle('Insert the selected diff lines'));
    expect(onInsert.mock.calls[0][1]).toContain('line 10');
    fireEvent.click(screen.getByRole('button', { name: 'Expand 9 lines above' }));
    expect(container.textContent).toContain('line 1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 20 lines below' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand 7 lines above' }));
    expect(container.textContent).toContain('line 53');
    expect(screen.queryByRole('button', { name: /above/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand 20 lines below' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand 8 lines below' }));
    expect(container.textContent).toContain('line 90');
    expect(screen.queryByRole('button', { name: /Expand/ })).toBeNull();
    const rows = container.querySelectorAll('.diff-code-normal');
    expect([...rows].filter((row) => row.textContent === 'line 53')).toHaveLength(viewType === 'split' ? 2 : 1);
    rerender(<DiffViewer filePath="example.txt" diffOverride={patch.replaceAll('replacement', 'updated')} oldSourceOverride={source} viewType={viewType} inlineMode="none" onInsertDiffReference={onInsert} embedded />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Expand 20 lines above' })).toHaveLength(2));
    expect(container.textContent).not.toContain('line 10');
  });
});
