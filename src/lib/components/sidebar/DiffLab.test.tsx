// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseDiff } from 'react-diff-view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFF_FIXTURES, DiffLab } from './DiffLab';

vi.mock('./diffWorkerClient', async () => {
  const refractorModule = await import('refractor');
  const refractor = refractorModule.default ?? refractorModule;
  const { parseDiff, tokenize } = await import('react-diff-view');
  const { markSmartEdits } = await import('./inlineDiff');
  return {
    parseDiffInWorker: async (
      diffContent: string,
      inlineMode: 'none' | 'words' | 'chars',
      oldSource?: string,
      language?: string,
    ) => {
      const files = parseDiff(diffContent);
      const tokens = new Map();
      if (inlineMode !== 'none') {
        for (const file of files) {
          const hunks = file.hunks;
          const enhancers = [markSmartEdits(hunks, inlineMode)];
          const hunkTokens = language
            ? tokenize(hunks, { enhancers, oldSource, highlight: true, refractor, language })
            : tokenize(hunks, { enhancers, oldSource });
          tokens.set(`${file.oldRevision}-${file.newRevision}-${file.newPath}`, hunkTokens);
        }
      }
      return { files, tokens, parseMs: 0, tokenizeMs: 0 };
    },
  };
});

function renderLab(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  return render(<DiffLab />);
}

const OPTION_MATRIX = Object.keys(DIFF_FIXTURES).flatMap((fixture) => (
  (['unified', 'split'] as const).flatMap((view) => (
    (['none', 'words', 'chars'] as const).flatMap((inline) => (
      (['on', 'off'] as const).map((wrap) => ({ fixture, view, inline, wrap }))
    ))
  ))
));

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

  it('hydrates fixture, view, inline mode, and wrap from URL params', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=moved&view=split&inline=chars&wrap=off');
    const lab = container.querySelector('[data-diff-lab]');

    expect(lab?.getAttribute('data-diff-lab-fixture')).toBe('moved');
    expect(lab?.getAttribute('data-diff-lab-view')).toBe('split');
    expect(lab?.getAttribute('data-diff-lab-inline')).toBe('chars');
    expect(lab?.getAttribute('data-diff-lab-wrap')).toBe('off');
    await waitFor(() => expect(container.querySelector('[data-diff-viewer]')?.getAttribute('data-diff-view-type')).toBe('split'));
    expect(container.querySelector('[data-diff-viewer]')?.getAttribute('data-diff-inline-mode')).toBe('chars');
    expect((screen.getByRole('combobox', { name: 'Fixture' }) as HTMLSelectElement).value).toBe('moved');
  });

  it('reports the actual unified layout and disables split on narrow screens', async () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { container } = renderLab('?diff-lab=1&fixture=unicodeGraphemes&view=split&inline=words&wrap=on');

    await waitFor(() => expect(container.querySelector('[data-diff-viewer]')?.getAttribute('data-diff-view-type')).toBe('unified'));
    expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-view')).toBe('unified');
    expect(container.querySelector('[data-diff-lab]')?.getAttribute('data-diff-lab-requested-view')).toBe('split');
    expect(container.querySelector('header button[aria-pressed="true"]')?.textContent).toBe('Unified');
    expect((container.querySelector('header button[aria-pressed="false"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps every fixture parseable with the expected file-level shape', () => {
    const parsed = Object.fromEntries(Object.entries(DIFF_FIXTURES).map(([key, fixture]) => {
      const files = parseDiff(fixture.diff);
      return [key, files.map((file) => ({ type: file.type, hunks: file.hunks.length }))];
    }));

    expect(Object.keys(parsed)).toEqual(Object.keys(DIFF_FIXTURES));
    expect(parsed.addedFile).toEqual([{ type: 'add', hunks: 1 }]);
    expect(parsed.deletedFile).toEqual([{ type: 'delete', hunks: 1 }]);
    expect(parsed.renameOnly).toEqual([{ type: 'rename', hunks: 0 }]);
    // react-diff-view reports a rename-with-hunks as modify; DiffViewer restores
    // the rename semantic from the differing old/new paths at presentation time.
    expect(parsed.renamedWithEdit).toEqual([{ type: 'modify', hunks: 1 }]);
    expect(parsed.binaryFile).toEqual([{ type: 'modify', hunks: 0 }]);
    expect(Object.entries(parsed).filter(([key]) => !['renameOnly', 'binaryFile'].includes(key))
      .every(([, files]) => files.some((file) => file.hunks > 0))).toBe(true);
  });

  it.each(OPTION_MATRIX)(
    'renders $fixture in $view/$inline/wrap-$wrap',
    async ({ fixture, view, inline, wrap }) => {
      const { container } = renderLab(`?diff-lab=1&fixture=${fixture}&view=${view}&inline=${inline}&wrap=${wrap}`);
      const parsed = parseDiff(DIFF_FIXTURES[fixture].diff);
      await waitFor(() => {
        const viewer = container.querySelector('[data-diff-viewer]');
        expect(viewer?.getAttribute('data-diff-view-type')).toBe(view);
        expect(viewer?.getAttribute('data-diff-inline-mode')).toBe(inline);
        if (parsed.some((file) => file.hunks.length > 0)) {
          expect(container.querySelector('.diff-hunk')).toBeTruthy();
        }
      });
      if (parsed.some((file) => file.hunks.length > 0)) {
        expect(Boolean(container.querySelector('.termdock-diff-wrap'))).toBe(wrap === 'on');
      }
      if (inline === 'none') expect(container.querySelector('.diff-code-edit')).toBeNull();
    },
  );

  it('top-aligns an expanded modification and keeps word edits at their source lines', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=insertThenModify&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelector('.diff-line-compare')).toBeTruthy());
    const changedRows = Array.from(container.querySelectorAll('.diff-line')).filter((row) => !row.classList.contains('diff-line-normal'));
    const texts = changedRows.map((row) => Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim()));
    expect(texts).toEqual([
      ['config.timeoutMs = 1000;', 'config.enableDiffLab = true;'],
      ['', "config.inlineMode = 'words';"],
      ['', "config.algorithm = 'histogram';"],
      ['', 'config.timeoutMs = 1500;'],
    ]);
    expect(Array.from(container.querySelectorAll('.diff-code-edit')).map((edit) => edit.textContent)).toEqual(['1000', '1500']);
  });

  it('keeps a multi-line rewrite compact instead of alternating gaps between weak matches', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=multilineRewrite&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelector('.diff-line-compare')).toBeTruthy());
    const rows = Array.from(container.querySelectorAll('.diff-line'));
    const first = rows.findIndex((row) => row.classList.contains('diff-line-compare'));
    const cells = Array.from(rows[first].querySelectorAll('.diff-code'));
    expect(cells[0].textContent).toContain('const deletes = block.filter');
    expect(cells[1].textContent).toContain('for (const { deletes, inserts }');
    let sawEmptyRight = false;
    for (const row of rows.slice(first)) {
      if (row.classList.contains('diff-line-normal')) break;
      const right = row.querySelectorAll('.diff-code')[1].textContent;
      if (!right) sawEmptyRight = true;
      else expect(sawEmptyRight).toBe(false);
    }
    expect(sawEmptyRight).toBe(true);
  });

  it('keeps low-similarity replacements side by side without fabricated inline highlights', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=unrelatedReplacement&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff.diff-split .diff-line').length).toBeGreaterThan(0));
    const changedRows = Array.from(container.querySelectorAll('.diff-line')).filter((row) => (
      row.textContent?.includes('calculateRetryBudget') || row.textContent?.includes('notifyObservers')
    ));

    expect(changedRows).toHaveLength(1);
    expect(changedRows[0].classList.contains('diff-line-compare')).toBe(true);
    expect(changedRows.every((row) => row.querySelector('.diff-code-edit') === null)).toBe(true);
  });

  it.each(['on', 'off'])('covers embedded stream rendering with three-digit gutters, wrap=%s', async (wrap) => {
    const { container } = renderLab(`?diff-lab=1&fixture=multilineRewrite&view=split&inline=words&wrap=${wrap}&embedded=1`);
    await waitFor(() => expect(container.querySelector('.diff-line-compare')).toBeTruthy());
    expect(container.querySelector('.termdock-diff-card-mobile')).toBeTruthy();
    expect(container.querySelector('.diff-gutter')?.textContent).toBe('714');
    expect(container.textContent).not.toContain('Swipe left/right to see the full diff');
  });

  it.each(['on', 'off'])('aligns expanded Chinese prose with inline edits, wrap=%s', async (wrap) => {
    const { container } = renderLab(`?diff-lab=1&fixture=chineseParagraphExpansion&view=split&inline=words&wrap=${wrap}`);
    await waitFor(() => expect(container.querySelector('.diff-code-edit')).toBeTruthy());
    const rows = Array.from(container.querySelectorAll('.diff-line-compare'));
    expect(rows).toHaveLength(1);
    const cells = Array.from(rows[0].querySelectorAll('.diff-code'));
    expect(cells[0].textContent).toContain('6. 查看字节');
    expect(cells[1].textContent).toContain('6. 查看或读取字节');
    expect(Array.from(rows[0].querySelectorAll('.diff-gutter')).map((cell) => cell.textContent)).toEqual(['52', '52']);
    expect(rows[0].querySelector('.diff-gutter-omit')).toBeNull();
    expect(cells.every((cell) => cell.querySelector('.diff-code-edit'))).toBe(true);
    // Surviving text must stay readable as context, not be painted wholesale.
    for (const cell of cells) {
      expect(Array.from(cell.querySelectorAll('.diff-code-edit')).some((edit) => edit.textContent?.includes('无法取得具体信息后'))).toBe(false);
    }
  });

  it.each([
    ['addedFile', 'insert'],
    ['deletedFile', 'delete'],
  ] as const)('uses only a soft row tint for %s', async (fixture, changeType) => {
    const { container } = renderLab(`?diff-lab=1&fixture=${fixture}&view=unified&inline=words&wrap=on`);
    await waitFor(() => expect(container.querySelectorAll(`.diff-code-${changeType}`).length).toBeGreaterThan(0));

    expect(container.querySelector('.diff-code-edit')).toBeNull();
  });

  it('keeps rename semantics when the renamed file also has edited hunks', async () => {
    renderLab('?diff-lab=1&fixture=renamedWithEdit&view=split&inline=words&wrap=on');

    await waitFor(() => expect(screen.getByText('rename')).toBeTruthy());
    expect(screen.getByText('OldConfig.ts → NewConfig.ts')).toBeTruthy();
  });

  it('does not strongly highlight blank or indentation-only changes', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=blankAndTabs&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelector('.diff-hunk')).toBeTruthy());

    expect(container.querySelector('.diff-code-edit')).toBeNull();
  });

  it('preserves the no-final-newline fact without turning it into a strong edit', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=noFinalNewline&view=unified&inline=words&wrap=on');
    await waitFor(() => expect(screen.getByText('No newline at end of file')).toBeTruthy());

    expect(container.querySelectorAll('.diff-code-edit')).toHaveLength(2);
    expect(screen.getByText('No newline at end of file').classList.contains('diff-code-edit')).toBe(false);
  });

  it('scopes raw patch metadata to the correct file in a multi-file diff', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=multiFilePatch&view=unified&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('[data-diff-file-anchor]')).toHaveLength(2));

    expect(screen.getAllByText('No newline at end of file')).toHaveLength(1);
    expect(container.querySelectorAll('.diff-code-edit')).toHaveLength(2);
    expect(container.textContent).toContain('Second.ts');
  });

  it('keeps Unicode edits inside valid visible text', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=unicodeGraphemes&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff-code-edit').length).toBeGreaterThan(0));
    const edits = Array.from(container.querySelectorAll('.diff-code-edit')).map((node) => node.textContent ?? '');

    expect(edits.join('')).not.toContain('\uFFFD');
    expect(edits.some((text) => text.includes('连接') || text.includes('成功'))).toBe(true);
  });

  it('isolates the mutation on a very long line', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=longLine&view=split&inline=words&wrap=off');
    await waitFor(() => expect(container.querySelectorAll('.diff-code-edit')).toHaveLength(2));
    const edits = Array.from(container.querySelectorAll('.diff-code-edit')).map((node) => node.textContent);

    expect(edits).toEqual(['OLD_VALUE', 'NEW_VALUE']);
  });

  it('anchors duplicate scaffolding and highlights only the real save replacement', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=ambiguousDuplicates&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff-code-edit')).toHaveLength(2));
    const edits = Array.from(container.querySelectorAll('.diff-code-edit')).map((node) => node.textContent);
    const auditRow = Array.from(container.querySelectorAll('.diff-line'))
      .find((row) => row.textContent?.includes('audit(item)'));

    expect(edits).toEqual(['saveLegacy', 'saveModern']);
    expect(auditRow?.classList.contains('diff-line-new-only')).toBe(true);
  });

  it('keeps source order in one replacement when words move between comments and strings', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=commentStringCollision&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelector('.diff-line-compare')).toBeTruthy());
    const rows = Array.from(container.querySelectorAll('.diff-line-compare'));
    expect(rows.map((row) => Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim()))).toEqual([
      ['// retry request after backoff', "logger.info('retry request after backoff');"],
      ["logger.info('request failed');", '// request failed permanently'],
    ]);
  });

  it('keeps real edits strong and pure additions/deletions soft across multiple hunks', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=multiHunkMixed&view=unified&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('[data-diff-hunk-anchor]')).toHaveLength(2));
    const edits = Array.from(container.querySelectorAll('.diff-code-edit')).map((node) => node.textContent);
    const pureRows = Array.from(container.querySelectorAll('.diff-line')).filter((row) => (
      row.textContent?.includes('logConnection') || row.textContent?.includes('reportLegacyMetrics')
    ));

    expect(edits).toEqual(['1000', '1500']);
    expect(pureRows).toHaveLength(2);
    expect(pureRows.every((row) => row.querySelector('.diff-code-edit') === null)).toBe(true);
  });

  it('keeps repeated unchanged lines anchored while compacting the adjacent replacement', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=repeatedScaffolding&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff.diff-split .diff-line').length).toBeGreaterThan(0));
    const rows = Array.from(container.querySelectorAll('.diff-line'));
    const loggerRow = rows.find((row) => row.textContent?.includes('logger.debug'));
    const modernRow = rows.find((row) => row.textContent?.includes('renderModern'));
    const unchangedLegacyRow = rows.find((row) => (
      row.classList.contains('diff-line-compare')
      && row.querySelectorAll('.diff-code')[0]?.textContent === row.querySelectorAll('.diff-code')[1]?.textContent
    ));

    expect(loggerRow?.classList.contains('diff-line-compare')).toBe(true);
    expect(modernRow?.classList.contains('diff-line-new-only')).toBe(true);
    expect(Array.from(container.querySelectorAll('.diff-code-edit')).map((edit) => edit.textContent)).toEqual(['renderLegacy', 'renderModern']);
    expect(unchangedLegacyRow).toBeTruthy();
    expect(unchangedLegacyRow?.querySelector('.diff-code-edit')).toBeNull();
  });

  it('marks a moved-and-edited block even when source and destination are in separate hunks', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=movedAndEdited&view=unified&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff-line-moved').length).toBe(4));

    expect(container.querySelectorAll('.diff-line-moved')).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('.diff-line-moved')).some((row) => row.textContent?.includes('signal'))).toBe(true);
  });

  it('keeps an if wrapper around aligned unchanged lines in source order', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=ifWrapper&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff.diff-split .diff-line').length).toBeGreaterThan(0));
    const rows = Array.from(container.querySelectorAll('.diff.diff-split .diff-line')).map((row) => ({
      className: row.className,
      cells: Array.from(row.querySelectorAll('.diff-code')),
      texts: Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim() ?? ''),
    }));
    const ifIndex = rows.findIndex((row) => row.texts[0] === '' && row.texts[1].startsWith('if (shouldRun'));
    const prepareIndex = rows.findIndex((row) => row.texts[0] === 'prepare(context);');
    const finishIndex = rows.findIndex((row) => row.texts[0] === 'finish(context);');
    const wrapperCloseIndex = rows.findIndex((row) => row.texts[0] === '' && row.texts[1] === '}');
    const stableRows = rows.filter((row) => (
      row.texts[0] === 'prepare(context);'
      || row.texts[0] === 'executeTask(context);'
      || row.texts[0] === 'finish(context);'
    ));

    expect(ifIndex).toBeGreaterThanOrEqual(0);
    expect(ifIndex).toBeLessThan(prepareIndex);
    expect(prepareIndex).toBeLessThan(finishIndex);
    expect(finishIndex).toBeLessThan(wrapperCloseIndex);
    expect(stableRows).toHaveLength(3);
    expect(stableRows.every((row) => row.className.includes('diff-line-compare'))).toBe(true);
    expect(stableRows.every((row) => row.cells[0]?.querySelector('.diff-code-edit') === null)).toBe(true);
    expect(stableRows.every((row) => row.cells[1]?.querySelector('.diff-code-edit') === null)).toBe(true);
  });

  it('aligns a reordered loop with its identical inner loop instead of the nearer outer loop', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=loopNesting&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff.diff-split .diff-line').length).toBeGreaterThan(0));
    const changedRows = Array.from(container.querySelectorAll('.diff.diff-split .diff-line'))
      .map((row) => Array.from(row.querySelectorAll('.diff-code')).map((cell) => cell.textContent?.trim() ?? ''))
      .filter(([left, right]) => (
        left?.includes('for (const range of ranges)')
        || right?.includes('for (const range of ranges)')
        || left?.includes('for (const line of block.lines)')
        || right?.includes('for (const line of block.lines)')
        || right?.includes('lineRanges: InlineDiffRange[]')
        || left?.includes('const rangeEnd')
        || right?.includes('const rangeEnd')
      ));

    expect(changedRows).toEqual([
      ['', 'for (const line of block.lines) {'],
      ['', 'const lineRanges: InlineDiffRange[] = [];'],
      ['for (const range of ranges) {', 'for (const range of ranges) {'],
      ['const rangeEnd = range.start + range.length;', 'const rangeEnd = range.start + range.length;'],
      ['for (const line of block.lines) {', ''],
    ]);
  });

  it('collapses import-only hunks by default', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=imports&view=unified&inline=words&wrap=on');

    await waitFor(() => expect(screen.getByText('Import-only changes collapsed.')).toBeTruthy());
    expect(container.querySelector('.diff-hunk')?.classList.contains('diff-hunk-imports')).toBe(true);
    expect(screen.getByText('Import-only changes collapsed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'show' })).toBeTruthy();
    expect(container.querySelectorAll('.diff-line')).toHaveLength(0);
  });

  it('keeps same-line import expansions aligned in split view', async () => {
    const { container } = renderLab('?diff-lab=1&fixture=importTypeExpansion&view=split&inline=words&wrap=on');
    await waitFor(() => expect(container.querySelectorAll('.diff.diff-split .diff-line').length).toBeGreaterThan(0));
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

// unrelatedReplacement parses to one hunk of N1, D2, I2, N3, N4 — the smallest
// fixture that exercises both the unified rows (D2 and I2 apart) and the split
// row (D2 + I2 paired).
describe('DiffLab line-level insert references', () => {
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

  const pill = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.right-2');
  const selectedRows = (container: HTMLElement) => container.querySelectorAll('.diff-line-ref-selected');
  const insertedText = (container: HTMLElement) => container.querySelector('[data-diff-lab-inserted]')?.textContent ?? '';
  const insertedLabel = (container: HTMLElement) => container.querySelector('[data-diff-lab-inserted-label]')?.textContent ?? '';
  const codeCells = (container: HTMLElement, kind: 'delete' | 'insert') => (
    Array.from(container.querySelectorAll<HTMLElement>(`.diff-code-${kind}`))
  );

  async function renderFixture(view: 'unified' | 'split') {
    const rendered = renderLab(`?diff-lab=1&fixture=unrelatedReplacement&view=${view}&inline=none&wrap=on`);
    await waitFor(() => expect(rendered.container.querySelectorAll('.diff-code-delete').length).toBeGreaterThan(0));
    return rendered;
  }

  it('has no insert affordance until a line is tapped', async () => {
    const { container } = await renderFixture('unified');

    expect(pill(container)).toBeNull();
    expect(selectedRows(container)).toHaveLength(0);
  });

  it('no longer offers a per-section insert button in the diff stream', async () => {
    const { container } = await renderFixture('unified');

    // Line-level selection replaced the standalone "insert this section"
    // button; the section row survives only as a walkthrough scroll anchor.
    expect(screen.queryByTitle('Insert this hunk section')).toBeNull();
    expect(container.querySelectorAll('.diff-hunk-meta-row button').length).toBeGreaterThan(0);
  });

  it('selects a tapped line, then inserts it as a diff reference from the pill', async () => {
    const { container } = await renderFixture('unified');

    fireEvent.click(codeCells(container, 'delete')[0]);
    await waitFor(() => expect(pill(container)).toBeTruthy());
    expect(selectedRows(container)).toHaveLength(1);
    expect(pill(container)?.textContent).toContain('L2');

    fireEvent.click(pill(container) as HTMLButtonElement);
    await waitFor(() => expect(insertedText(container)).not.toBe(''));
    expect(insertedLabel(container)).toBe('UnrelatedReplacement.ts L2');
    // Same shape as the hunk reference, but only the tapped line.
    expect(insertedText(container)).toBe([
      '```diff',
      '# /tmp/termdock-diff-lab/UnrelatedReplacement.ts: hunk 1, old lines 2 -> new lines none',
      'diff --git /tmp/termdock-diff-lab/UnrelatedReplacement.ts /tmp/termdock-diff-lab/UnrelatedReplacement.ts',
      '@@ -1,5 +1,5 @@',
      '-  const retries = calculateRetryBudget(request);',
      '```',
      '',
    ].join('\n'));
  });

  it('clears the selection when the very same line is tapped again', async () => {
    const { container } = await renderFixture('unified');

    fireEvent.click(codeCells(container, 'delete')[0]);
    await waitFor(() => expect(pill(container)).toBeTruthy());

    fireEvent.click(codeCells(container, 'delete')[0]);
    await waitFor(() => expect(pill(container)).toBeNull());
    expect(selectedRows(container)).toHaveLength(0);
  });

  it('extends a tapped line to a range and inserts every selected line', async () => {
    const { container } = await renderFixture('unified');

    // Unified rows: N1 | D2 | I2 | N3 | N4 — two taps select two rows.
    fireEvent.click(codeCells(container, 'delete')[0]);
    await waitFor(() => expect(selectedRows(container)).toHaveLength(1));
    fireEvent.click(codeCells(container, 'insert')[0]);

    await waitFor(() => expect(selectedRows(container)).toHaveLength(2));
    expect(pill(container)?.textContent).toContain('L2');

    fireEvent.click(pill(container) as HTMLButtonElement);
    await waitFor(() => expect(insertedText(container)).not.toBe(''));
    expect(insertedText(container)).toBe([
      '```diff',
      '# /tmp/termdock-diff-lab/UnrelatedReplacement.ts: hunk 1, old lines 2 -> new lines 2',
      'diff --git /tmp/termdock-diff-lab/UnrelatedReplacement.ts /tmp/termdock-diff-lab/UnrelatedReplacement.ts',
      '@@ -1,5 +1,5 @@',
      '-  const retries = calculateRetryBudget(request);',
      '+  notifyObservers(session.status);',
      '```',
      '',
    ].join('\n'));
  });

  it('treats the two halves of a split replacement row as one selectable line', async () => {
    const { container } = await renderFixture('split');

    fireEvent.click(codeCells(container, 'delete')[0]);
    await waitFor(() => expect(pill(container)).toBeTruthy());
    expect(selectedRows(container)).toHaveLength(1);
    expect(pill(container)?.textContent).toContain('L2');

    // The paired insertion is the same rendered row, so this clears instead of
    // extending — the rule that kept "tap a line, tap its partner" from
    // producing a phantom two-line reference.
    fireEvent.click(codeCells(container, 'insert')[0]);
    await waitFor(() => expect(pill(container)).toBeNull());
    expect(selectedRows(container)).toHaveLength(0);
  });

  it('labels a context-only pick from its own line numbers', async () => {
    const { container } = await renderFixture('unified');

    fireEvent.click(container.querySelectorAll<HTMLElement>('.diff-code-normal')[0]);
    await waitFor(() => expect(pill(container)).toBeTruthy());
    expect(pill(container)?.textContent).toContain('L1');

    fireEvent.click(pill(container) as HTMLButtonElement);
    await waitFor(() => expect(insertedText(container)).not.toBe(''));
    // Context rows carry no changed lines, so the header falls back to the
    // context line numbers instead of reading "none -> none".
    expect(insertedText(container)).toBe([
      '```diff',
      '# /tmp/termdock-diff-lab/UnrelatedReplacement.ts: hunk 1, old lines 1 -> new lines 1',
      'diff --git /tmp/termdock-diff-lab/UnrelatedReplacement.ts /tmp/termdock-diff-lab/UnrelatedReplacement.ts',
      '@@ -1,5 +1,5 @@',
      ' export function updateSession(request: Request) {',
      '```',
      '',
    ].join('\n'));
  });
});
