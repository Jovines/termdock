import { getChangeKey, type HunkData } from 'react-diff-view';

/**
 * Pure helpers behind the diff reference texts (hunk / section / whole diff /
 * hand-picked line range). Kept free of React and of DiffViewer state so the
 * exact agent-facing text can be unit tested on its own.
 */

export interface DiffReferenceHunkMeta {
  filePath: string;
  hunkIndex: number;
  hunk: HunkData;
}

export interface DiffReferenceMeta {
  filePath?: string | null;
  hunks?: DiffReferenceHunkMeta[];
}

export type DiffReferenceChange = HunkData['changes'][number];

/** A contiguous run of *rendered* diff rows inside one hunk. */
export interface DiffRowRange {
  hunkId: string;
  startRow: number;
  endRow: number;
}

export interface DiffHunkRowModel {
  /** One entry per rendered line row; split rows hold their old + new change. */
  rows: DiffReferenceChange[][];
  /** change key -> index of the row that renders it. */
  rowIndexByChangeKey: Map<string, number>;
}

export function formatLineNumberList(lineNumbers: number[]): string {
  if (lineNumbers.length === 0) return 'none';
  const ranges: string[] = [];
  let rangeStart = lineNumbers[0];
  let previous = lineNumbers[0];
  for (const lineNumber of lineNumbers.slice(1)) {
    if (lineNumber === previous + 1) {
      previous = lineNumber;
      continue;
    }
    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = lineNumber;
    previous = lineNumber;
  }
  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return ranges.join(', ');
}

export function collectChangedLineNumbers(changes: readonly DiffReferenceChange[]): { oldLines: number[]; newLines: number[] } {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  for (const change of changes) {
    if (change.type === 'delete') oldLines.push(change.lineNumber);
    if (change.type === 'insert') newLines.push(change.lineNumber);
  }
  return { oldLines, newLines };
}

export function getChangedLineNumbers(hunk: HunkData): { oldLines: number[]; newLines: number[] } {
  return collectChangedLineNumbers(hunk.changes);
}

export function formatHunkReferenceLine(hunkMeta: DiffReferenceHunkMeta): string {
  const changedLines = getChangedLineNumbers(hunkMeta.hunk);
  return `# ${hunkMeta.filePath}: hunk ${hunkMeta.hunkIndex + 1}, old lines ${formatLineNumberList(changedLines.oldLines)} -> new lines ${formatLineNumberList(changedLines.newLines)}`;
}

export function formatDiffReferenceChange(change: DiffReferenceChange): string {
  if (change.type === 'insert') return change.content.startsWith('+') ? change.content : `+${change.content}`;
  if (change.type === 'delete') return change.content.startsWith('-') ? change.content : `-${change.content}`;
  return change.content.startsWith(' ') ? change.content : ` ${change.content}`;
}

export function formatDiffReference(diffText: string, meta?: DiffReferenceMeta): string {
  const trimmedDiff = diffText.trimEnd();
  if (!meta) return `\`\`\`diff\n${trimmedDiff}\n\`\`\`\n`;
  const header = [
    ...(meta.hunks ?? []).map(formatHunkReferenceLine),
  ].filter((line): line is string => Boolean(line));
  return `\`\`\`diff\n${header.length > 0 ? `${header.join('\n')}\n` : ''}${trimmedDiff}\n\`\`\`\n`;
}

/**
 * Mirrors react-diff-view's own row grouping: split rows pair a deletion with
 * the insertion right after it (`SplitHunk.groupElements`), unified rows are
 * one change each. Selection is tracked by row index so both halves of a split
 * replacement row count as the same selectable unit.
 *
 * Split view needs the *display-aligned* hunk (`alignAdjacentChangesForSplitView`),
 * unified view the original one — the change objects are shared either way.
 */
export function buildDiffHunkRowModel(hunk: HunkData, viewType: 'unified' | 'split'): DiffHunkRowModel {
  const rows: DiffReferenceChange[][] = [];
  const rowIndexByChangeKey = new Map<string, number>();
  const changes = hunk.changes;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const row: DiffReferenceChange[] = [change];
    if (viewType === 'split' && change.type === 'delete') {
      const next = changes[index + 1];
      if (next && next.type === 'insert') {
        row.push(next);
        index += 1;
      }
    }
    const rowIndex = rows.push(row) - 1;
    for (const rowChange of row) rowIndexByChangeKey.set(getChangeKey(rowChange), rowIndex);
  }

  return { rows, rowIndexByChangeKey };
}

/**
 * File-preview parity: tapping the exact same range again clears it, tapping
 * another row while a single row is selected extends to cover both, anything
 * else restarts at the tapped row. Ranges never span hunks.
 */
export function resolveDiffRowRange(current: DiffRowRange | null, hunkId: string, rowIndex: number): DiffRowRange | null {
  if (!current || current.hunkId !== hunkId) return { hunkId, startRow: rowIndex, endRow: rowIndex };
  if (current.startRow === rowIndex && current.endRow === rowIndex) return null;
  if (current.startRow === current.endRow) {
    return {
      hunkId,
      startRow: Math.min(current.startRow, rowIndex),
      endRow: Math.max(current.endRow, rowIndex),
    };
  }
  return { hunkId, startRow: rowIndex, endRow: rowIndex };
}

export function isRowInDiffRange(range: DiffRowRange | null, hunkId: string, rowIndex: number): boolean {
  return Boolean(range && range.hunkId === hunkId && rowIndex >= range.startRow && rowIndex <= range.endRow);
}

/**
 * Selected rows in git-natural order: filtering the original `hunk.changes`
 * keeps deletions ahead of their insertions even when the split view renders
 * them side by side.
 */
export function collectSelectedChanges(
  hunk: HunkData,
  rowModel: DiffHunkRowModel,
  range: DiffRowRange,
): DiffReferenceChange[] {
  const selectedKeys = new Set<string>();
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex += 1) {
    for (const change of rowModel.rows[rowIndex] ?? []) selectedKeys.add(getChangeKey(change));
  }
  if (selectedKeys.size === 0) return [];
  return hunk.changes.filter((change) => selectedKeys.has(getChangeKey(change)));
}

/**
 * Context-only picks have no insert/delete line numbers of their own; fall back
 * to the normal changes' line numbers so the header never reads "none -> none".
 */
export function collectSelectionLineNumbers(changes: readonly DiffReferenceChange[]): { oldLines: number[]; newLines: number[] } {
  const { oldLines, newLines } = collectChangedLineNumbers(changes);
  if (oldLines.length > 0 || newLines.length > 0) return { oldLines, newLines };
  for (const change of changes) {
    if (change.type !== 'normal') continue;
    oldLines.push(change.oldLineNumber);
    newLines.push(change.newLineNumber);
  }
  return { oldLines, newLines };
}

export function formatDiffSelectionHeader(
  filePath: string,
  hunkIndex: number,
  changes: readonly DiffReferenceChange[],
): string {
  const { oldLines, newLines } = collectSelectionLineNumbers(changes);
  return `# ${filePath}: hunk ${hunkIndex + 1}, old lines ${formatLineNumberList(oldLines)} -> new lines ${formatLineNumberList(newLines)}`;
}

/** Same shape as the hunk/section references, but only the selected lines. */
export function formatLineSelectionReference(
  filePath: string,
  hunkIndex: number,
  hunkHeader: string,
  diffHeader: string,
  selectedChanges: readonly DiffReferenceChange[],
): string {
  return formatDiffReference([
    formatDiffSelectionHeader(filePath, hunkIndex, selectedChanges),
    diffHeader,
    hunkHeader,
    ...selectedChanges.map(formatDiffReferenceChange),
  ].join('\n'));
}

export function formatDiffSelectionLabel(changes: readonly DiffReferenceChange[]): string | null {
  if (changes.length === 0) return null;
  const { oldLines, newLines } = collectSelectionLineNumbers(changes);
  const lineNumbers = newLines.length > 0 ? newLines : oldLines;
  if (lineNumbers.length === 0) return null;
  return `L${formatLineNumberList(lineNumbers)}`;
}

export function buildDiffLineReferenceKey(
  displayPath: string,
  hunkIndex: number,
  range: DiffRowRange,
): string {
  return `diff:lines:${displayPath}:${hunkIndex}:${range.startRow}-${range.endRow}`;
}
