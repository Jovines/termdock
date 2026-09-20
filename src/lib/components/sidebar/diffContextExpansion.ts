import type { HunkData } from 'react-diff-view';

export interface ContextExpansion { before: number; after: number }
export const CONTEXT_EXPANSION_LINES = 20;

export function sourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function start(hunk: HunkData): number {
  return hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0);
}

export function contextGap(hunks: HunkData[], index: number, direction: 'before' | 'after', lineCount: number): number {
  const hunk = hunks[index];
  return Math.max(0, direction === 'before'
    ? start(hunk) - (index === 0 ? 1 : start(hunks[index - 1]) + hunks[index - 1].oldLines)
    : (index === hunks.length - 1 ? lineCount + 1 : start(hunks[index + 1])) - (start(hunk) + hunk.oldLines));
}

// Expand only the presentation copy: patch actions and audit identities retain
// their original hunks, even when two expanded context ranges meet.
export function expandContext(hunk: HunkData, lines: string[], expansion?: ContextExpansion): HunkData {
  if (!expansion || (!expansion.before && !expansion.after)) return hunk;
  const oldStart = start(hunk);
  const newStart = hunk.newStart + (hunk.newLines === 0 ? 1 : 0);
  const normal = (oldLineNumber: number, newLineNumber: number): HunkData['changes'][number] => ({
    type: 'normal', isNormal: true, oldLineNumber, newLineNumber, content: lines[oldLineNumber - 1],
  });
  const before = Array.from({ length: expansion.before }, (_, i) => normal(oldStart - expansion.before + i, newStart - expansion.before + i));
  const after = Array.from({ length: expansion.after }, (_, i) => normal(oldStart + hunk.oldLines + i, newStart + hunk.newLines + i));
  return {
    ...hunk,
    oldStart: oldStart - expansion.before,
    newStart: newStart - expansion.before,
    oldLines: hunk.oldLines + expansion.before + expansion.after,
    newLines: hunk.newLines + expansion.before + expansion.after,
    changes: [...before, ...hunk.changes, ...after],
  };
}
