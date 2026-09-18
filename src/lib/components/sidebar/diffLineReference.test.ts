import { describe, expect, it } from 'vitest';
import { getChangeKey, parseDiff, type HunkData } from 'react-diff-view';
import {
  buildDiffHunkRowModel,
  buildDiffLineReferenceKey,
  collectSelectedChanges,
  collectSelectionLineNumbers,
  formatDiffSelectionHeader,
  formatDiffSelectionLabel,
  formatLineSelectionReference,
  isRowInDiffRange,
  resolveDiffRowRange,
} from './diffLineReference';

// One delete replaced by two inserts — the shape the plan's example uses.
const PARSER_DIFF = `diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -118,5 +118,6 @@ export const parse = (input: string) => {
   const tokens = tokenize(input);
   const limits = getLimits(config);
-  const ast = legacyParse(tokens);
+  const ast = parseTokens(tokens);
+  const checked = validate(ast);
   return ast;
 }
`;

// Two deletes + two inserts: git order (d,d,i,i) differs from the split view's
// display order (d,i,d,i), so this is the fixture that pins "git-natural order".
const BLOCK_DIFF = `diff --git a/src/limits.ts b/src/limits.ts
--- a/src/limits.ts
+++ b/src/limits.ts
@@ -118,6 +118,6 @@ export const read = (input: string) => {
   const tokens = tokenize(input);
   const limits = getLimits(config);
-  const ast = legacyParse(tokens);
-  const draft = legacyDraft(tokens);
+  const ast = parseTokens(tokens);
+  const checked = validate(ast);
   return ast;
 }
`;

function parseHunk(diff: string): HunkData {
  const [file] = parseDiff(diff);
  return file.hunks[0];
}

const HUNK_ID = 'src/parser.ts\u00000';

describe('diff line reference row model', () => {
  const hunk = parseHunk(PARSER_DIFF);

  it('models unified rows one-to-one with the hunk changes', () => {
    const model = buildDiffHunkRowModel(hunk, 'unified');

    expect(hunk.changes.map((change) => getChangeKey(change)))
      .toEqual(['N118', 'N119', 'D120', 'I120', 'I121', 'N121', 'N122']);
    expect(model.rows.map((row) => row.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(model.rowIndexByChangeKey.get('D120')).toBe(2);
    expect(model.rowIndexByChangeKey.get('I121')).toBe(4);
  });

  it('pairs a deletion with the insertion right after it in split view', () => {
    const model = buildDiffHunkRowModel(hunk, 'split');

    // The extra insert has nothing to pair with, so it keeps its own row.
    expect(model.rows.map((row) => row.map((change) => getChangeKey(change)))).toEqual([
      ['N118'], ['N119'], ['D120', 'I120'], ['I121'], ['N121'], ['N122'],
    ]);
    expect(model.rowIndexByChangeKey.get('D120')).toBe(2);
    expect(model.rowIndexByChangeKey.get('I120')).toBe(2);
    expect(model.rowIndexByChangeKey.get('I121')).toBe(3);
  });

  it('renders the split-aligned changes in the order react-diff-view paints them', () => {
    const hunk = parseHunk(BLOCK_DIFF);
    expect(hunk.changes.map((change) => getChangeKey(change)))
      .toEqual(['N118', 'N119', 'D120', 'D121', 'I120', 'I121', 'N122', 'N123']);

    // alignAdjacentChangesForSplitView output: d120, i120, d121, i121.
    const [n1, n2, d1, d2, i1, i2, n3, n4] = hunk.changes;
    const model = buildDiffHunkRowModel({ ...hunk, changes: [n1, n2, d1, i1, d2, i2, n3, n4] }, 'split');

    expect(model.rows.map((row) => row.map((change) => getChangeKey(change)))).toEqual([
      ['N118'], ['N119'], ['D120', 'I120'], ['D121', 'I121'], ['N122'], ['N123'],
    ]);
  });
});

describe('resolveDiffRowRange', () => {
  it('starts a single-row selection when nothing is selected', () => {
    expect(resolveDiffRowRange(null, HUNK_ID, 4)).toEqual({ hunkId: HUNK_ID, startRow: 4, endRow: 4 });
  });

  it('clears the selection when the exact same row is tapped again', () => {
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 4, endRow: 4 }, HUNK_ID, 4)).toBeNull();
  });

  it('extends a single row to cover both rows, in either tap order', () => {
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 2, endRow: 2 }, HUNK_ID, 5)).toEqual({
      hunkId: HUNK_ID, startRow: 2, endRow: 5,
    });
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 5, endRow: 5 }, HUNK_ID, 2)).toEqual({
      hunkId: HUNK_ID, startRow: 2, endRow: 5,
    });
  });

  it('restarts from the tapped row once a range is already selected', () => {
    // Includes rows already inside the range: only a single-row selection extends.
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 2, endRow: 5 }, HUNK_ID, 4)).toEqual({
      hunkId: HUNK_ID, startRow: 4, endRow: 4,
    });
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 2, endRow: 5 }, HUNK_ID, 2)).toEqual({
      hunkId: HUNK_ID, startRow: 2, endRow: 2,
    });
  });

  it('restarts when the tap lands in another hunk, even on the same row index', () => {
    const other = 'src/parser.ts\u00001';
    expect(resolveDiffRowRange({ hunkId: HUNK_ID, startRow: 2, endRow: 5 }, other, 3)).toEqual({
      hunkId: other, startRow: 3, endRow: 3,
    });
  });

  it('reports range membership per hunk', () => {
    const range = { hunkId: HUNK_ID, startRow: 2, endRow: 4 };
    expect(isRowInDiffRange(range, HUNK_ID, 2)).toBe(true);
    expect(isRowInDiffRange(range, HUNK_ID, 4)).toBe(true);
    expect(isRowInDiffRange(range, HUNK_ID, 5)).toBe(false);
    expect(isRowInDiffRange(range, 'other', 3)).toBe(false);
    expect(isRowInDiffRange(null, HUNK_ID, 3)).toBe(false);
  });
});

describe('collectSelectedChanges', () => {
  it('returns the original change objects for a unified range', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 2, endRow: 4 });

    expect(selected.map((change) => getChangeKey(change))).toEqual(['D120', 'I120', 'I121']);
    expect(selected[0]).toBe(hunk.changes[2]);
    expect(selected[1]).toBe(hunk.changes[3]);
    expect(selected[2]).toBe(hunk.changes[4]);
  });

  it('emits deletions first even when split rows interleave them', () => {
    const hunk = parseHunk(BLOCK_DIFF);
    const [n1, n2, d1, d2, i1, i2, n3, n4] = hunk.changes;
    const model = buildDiffHunkRowModel({ ...hunk, changes: [n1, n2, d1, i1, d2, i2, n3, n4] }, 'split');

    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 2, endRow: 3 });
    expect(selected.map((change) => getChangeKey(change))).toEqual(['D120', 'D121', 'I120', 'I121']);
    expect(selected).toEqual([d1, d2, i1, i2]);
  });

  it('returns nothing for an out-of-range row', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    expect(collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 9, endRow: 9 })).toEqual([]);
  });
});

describe('formatLineSelectionReference', () => {
  it('renders the selected lines only, in git order, with a hunk header', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 2, endRow: 4 });

    expect(formatLineSelectionReference(
      'src/parser.ts',
      1,
      hunk.content,
      'diff --git a/src/parser.ts b/src/parser.ts',
      selected,
    )).toBe([
      '```diff',
      '# src/parser.ts: hunk 2, old lines 120 -> new lines 120-121',
      'diff --git a/src/parser.ts b/src/parser.ts',
      '@@ -118,5 +118,6 @@ export const parse = (input: string) => {',
      '-  const ast = legacyParse(tokens);',
      '+  const ast = parseTokens(tokens);',
      '+  const checked = validate(ast);',
      '```',
      '',
    ].join('\n'));
  });

  it('drops the context lines that surround the selection', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 3, endRow: 3 });

    expect(formatLineSelectionReference(
      'src/parser.ts',
      0,
      hunk.content,
      'diff --git a/src/parser.ts b/src/parser.ts',
      selected,
    )).toBe([
      '```diff',
      '# src/parser.ts: hunk 1, old lines none -> new lines 120',
      'diff --git a/src/parser.ts b/src/parser.ts',
      '@@ -118,5 +118,6 @@ export const parse = (input: string) => {',
      '+  const ast = parseTokens(tokens);',
      '```',
      '',
    ].join('\n'));
  });
});

describe('selection headers and labels', () => {
  it('collapses a multi-line selection into a range list', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 2, endRow: 4 });

    expect(formatDiffSelectionHeader('src/parser.ts', 1, selected))
      .toBe('# src/parser.ts: hunk 2, old lines 120 -> new lines 120-121');
    expect(formatDiffSelectionLabel(selected)).toBe('L120-121');
  });

  it('labels a delete-only selection with the old line numbers', () => {
    const hunk = parseHunk(BLOCK_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 2, endRow: 3 });

    expect(selected.map((change) => getChangeKey(change))).toEqual(['D120', 'D121']);
    expect(collectSelectionLineNumbers(selected)).toEqual({ oldLines: [120, 121], newLines: [] });
    expect(formatDiffSelectionLabel(selected)).toBe('L120-121');
    expect(formatDiffSelectionHeader('src/limits.ts', 0, selected))
      .toBe('# src/limits.ts: hunk 1, old lines 120-121 -> new lines none');
  });

  it('falls back to context line numbers when only context rows are selected', () => {
    const hunk = parseHunk(PARSER_DIFF);
    const model = buildDiffHunkRowModel(hunk, 'unified');
    const selected = collectSelectedChanges(hunk, model, { hunkId: HUNK_ID, startRow: 0, endRow: 1 });

    expect(selected.map((change) => change.type)).toEqual(['normal', 'normal']);
    expect(collectSelectionLineNumbers(selected)).toEqual({ oldLines: [118, 119], newLines: [118, 119] });
    expect(formatDiffSelectionLabel(selected)).toBe('L118-119');
    expect(formatDiffSelectionHeader('src/parser.ts', 0, selected))
      .toBe('# src/parser.ts: hunk 1, old lines 118-119 -> new lines 118-119');
  });

  it('has no label for an empty selection', () => {
    expect(formatDiffSelectionLabel([])).toBeNull();
  });
});

describe('buildDiffLineReferenceKey', () => {
  it('namespaces the key by path, hunk and row range', () => {
    expect(buildDiffLineReferenceKey('src/parser.ts', 1, { hunkId: HUNK_ID, startRow: 1, endRow: 2 }))
      .toBe('diff:lines:src/parser.ts:1:1-2');
  });
});
