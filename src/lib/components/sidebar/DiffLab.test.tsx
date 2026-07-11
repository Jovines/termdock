// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffLab } from './DiffLab';

function renderLab(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  return render(<DiffLab />);
}

describe('DiffLab regression fixtures', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('hydrates fixture, view, inline mode, and wrap from URL params', () => {
    const { container } = renderLab('?diff-lab=1&fixture=moved&view=split&inline=chars&wrap=off');
    const lab = container.querySelector('[data-diff-lab]');
    const viewer = container.querySelector('[data-diff-viewer]');

    expect(lab?.getAttribute('data-diff-lab-fixture')).toBe('moved');
    expect(lab?.getAttribute('data-diff-lab-view')).toBe('split');
    expect(lab?.getAttribute('data-diff-lab-inline')).toBe('chars');
    expect(lab?.getAttribute('data-diff-lab-wrap')).toBe('off');
    expect(viewer?.getAttribute('data-diff-view-type')).toBe('split');
    expect(viewer?.getAttribute('data-diff-inline-mode')).toBe('chars');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('moved');
  });

  it('keeps inserted lines one-sided and aligns the following modified line in split view', () => {
    const { container } = renderLab('?diff-lab=1&fixture=insertThenModify&view=split&inline=words&wrap=on');
    const rows = Array.from(container.querySelectorAll('.diff.diff-split .diff-line')).map((row) => ({
      className: row.className,
      texts: Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim()),
    }));

    const insertedOnlyRows = rows.filter((row) => row.texts[0] === '' && Boolean(row.texts[1]));
    const timeoutRows = rows.filter((row) => row.texts.some((text) => text?.includes('timeoutMs')));

    expect(insertedOnlyRows.map((row) => row.texts[1])).toEqual([
      'config.enableDiffLab = true;',
      "config.inlineMode = 'words';",
      "config.algorithm = 'histogram';",
    ]);
    expect(timeoutRows).toHaveLength(1);
    expect(timeoutRows[0].className).toContain('diff-line-compare');
    expect(timeoutRows[0].texts).toEqual(['config.timeoutMs = 1000;', 'config.timeoutMs = 1500;']);
  });

  it('collapses import-only hunks by default', () => {
    const { container } = renderLab('?diff-lab=1&fixture=imports&view=unified&inline=words&wrap=on');

    expect(container.querySelector('.diff-hunk')?.classList.contains('diff-hunk-imports')).toBe(true);
    expect(screen.getByText('Import-only changes collapsed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'show' })).toBeTruthy();
    expect(container.querySelectorAll('.diff-line')).toHaveLength(0);
  });

  it('keeps same-line import expansions aligned in split view', () => {
    const { container } = renderLab('?diff-lab=1&fixture=importTypeExpansion&view=split&inline=words&wrap=on');
    const rows = Array.from(container.querySelectorAll('.diff.diff-split .diff-line')).map((row) => ({
      className: row.className,
      texts: Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim()),
    }));
    const changedImportRows = rows.filter((row) => row.className.includes('diff-line-compare'));

    expect(screen.queryByText('Import-only changes collapsed.')).toBeNull();
    expect(changedImportRows.map((row) => row.texts)).toEqual([
      [
        "import type { ChangeAuditRecord, GitChangedFile } from '../../terminal/api';",
        "import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';",
      ],
      [
        "import { DiffViewer, type DiffViewType } from './DiffViewer';",
        "import { DiffViewer, type DiffInlineMode, type DiffViewType } from './DiffViewer';",
      ],
    ]);
  });

  it('uses old source context so Kotlin code after a previous block comment is highlighted as code', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=commentContext&view=split&inline=words&wrap=on');

    await waitFor(() => {
      const nextValueRow = Array.from(container.querySelectorAll('.diff-line'))
        .find((row) => row.textContent?.includes('fun nextValue'));
      expect(nextValueRow).toBeTruthy();
      expect(nextValueRow?.querySelector('.token.keyword')?.textContent).toBe('fun');
      expect(nextValueRow?.querySelector('.token.function')?.textContent).toBe('nextValue');
      expect(nextValueRow?.querySelector('.token.comment')).toBeNull();
    });
  });

  it('syncs state when the URL changes in an already-mounted lab', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=kotlin&view=unified&inline=words&wrap=on');

    window.history.pushState(null, '', '/?diff-lab=1&fixture=imports&view=split&inline=none&wrap=off');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => {
      expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-fixture')).toBe('imports');
    });
    expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-view')).toBe('split');
    expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-inline')).toBe('none');
    expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-wrap')).toBe('off');
  });
});
