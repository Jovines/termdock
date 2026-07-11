import { pickRanges, type HunkData, type RangeTokenNode, type TokenizeEnhancer } from 'react-diff-view';

type ChangeData = HunkData['changes'][number];

export type SmartInlineDiffMode = 'words' | 'chars';

export interface MovedLineCandidate {
  oldLineNumber: number;
  newLineNumber: number;
  score: number;
}

export interface PairedChangedLine {
  oldLineNumber: number;
  newLineNumber: number;
  score: number;
}

interface Token {
  start: number;
  value: string;
  significant: boolean;
}

function isDelete(change: ChangeData): boolean {
  return change.type === 'delete';
}

function isInsert(change: ChangeData): boolean {
  return change.type === 'insert';
}

function isNormal(change: ChangeData): boolean {
  return change.type === 'normal';
}

function getLineNumber(change: ChangeData): number {
  return 'lineNumber' in change && typeof change.lineNumber === 'number' ? change.lineNumber : -1;
}

function findChangeBlocks(changes: ChangeData[]): ChangeData[][] {
  const blocks: ChangeData[][] = [];
  let current: ChangeData[] = [];
  for (const change of changes) {
    if (isNormal(change)) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(change);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

export function tokenizeInlineDiffLine(value: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /([A-Za-z_$][A-Za-z0-9_$]*|[0-9]+(?:\.[0-9]+)?|[\u4e00-\u9fff]+|\s+|.)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[0];
    tokens.push({
      start: match.index,
      value: token,
      significant: token.trim().length > 0,
    });
  }
  return tokens;
}

function normalizeToken(value: string): string {
  return value.trim();
}

function significantTokens(value: string): string[] {
  return tokenizeInlineDiffLine(value)
    .filter((token) => token.significant)
    .map((token) => normalizeToken(token.value))
    .filter(Boolean);
}

export function getInlineDiffSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of leftTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let intersection = 0;
  for (const token of rightTokens) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

function pairLines(deletes: ChangeData[], inserts: ChangeData[]): Array<[ChangeData, ChangeData]> {
  const available = new Set(inserts);
  const pairs: Array<[ChangeData, ChangeData]> = [];
  for (const deletion of deletes) {
    let best: ChangeData | null = null;
    let bestScore = 0;
    for (const insertion of available) {
      const score = getInlineDiffSimilarity(deletion.content, insertion.content);
      if (score > bestScore) {
        best = insertion;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.22) {
      available.delete(best);
      pairs.push([deletion, best]);
    }
  }
  return pairs;
}

export function pairChangedLinesForDisplay(
  deletes: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  inserts: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  threshold = 0.18,
): PairedChangedLine[] {
  const available = new Set(inserts);
  const pairs: PairedChangedLine[] = [];
  for (const deletion of deletes) {
    let best: (Pick<ChangeData, 'content'> & { lineNumber: number }) | null = null;
    let bestScore = 0;
    for (const insertion of available) {
      if (insertion.lineNumber !== deletion.lineNumber) continue;
      const score = getInlineDiffSimilarity(deletion.content, insertion.content);
      if (score >= threshold) {
        best = insertion;
        bestScore = score;
        break;
      }
    }
    for (const insertion of available) {
      if (best && insertion.lineNumber === deletion.lineNumber) continue;
      const score = getInlineDiffSimilarity(deletion.content, insertion.content);
      const lineDistancePenalty = Math.min(0.12, Math.abs(insertion.lineNumber - deletion.lineNumber) * 0.02);
      const adjustedScore = score - lineDistancePenalty;
      if (adjustedScore > bestScore) {
        best = insertion;
        bestScore = adjustedScore;
      }
    }
    if (best && bestScore >= threshold) {
      available.delete(best);
      pairs.push({ oldLineNumber: deletion.lineNumber, newLineNumber: best.lineNumber, score: getInlineDiffSimilarity(deletion.content, best.content) });
    }
  }
  return pairs;
}

export function findMovedLineCandidates(
  deletes: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  inserts: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  threshold = 0.92,
): MovedLineCandidate[] {
  const candidates: MovedLineCandidate[] = [];
  const available = new Set(inserts);
  for (const deletion of deletes) {
    let best: (Pick<ChangeData, 'content'> & { lineNumber: number }) | null = null;
    let bestScore = 0;
    for (const insertion of available) {
      const score = getInlineDiffSimilarity(deletion.content, insertion.content);
      if (score > bestScore) {
        best = insertion;
        bestScore = score;
      }
    }
    if (best && bestScore >= threshold) {
      available.delete(best);
      candidates.push({
        oldLineNumber: deletion.lineNumber,
        newLineNumber: best.lineNumber,
        score: bestScore,
      });
    }
  }
  if (candidates.length < 2) return [];
  const oldMin = Math.min(...candidates.map((candidate) => candidate.oldLineNumber));
  const oldMax = Math.max(...candidates.map((candidate) => candidate.oldLineNumber));
  const newMin = Math.min(...candidates.map((candidate) => candidate.newLineNumber));
  const newMax = Math.max(...candidates.map((candidate) => candidate.newLineNumber));
  const separated = newMin > oldMax + 1 || oldMin > newMax + 1;
  return separated ? candidates : [];
}

function lcsMatrix(left: string[], right: string[]): number[][] {
  const matrix = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = left[i] === right[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

export function getChangedInlineTokenIndexes(left: Token[], right: Token[]): [Set<number>, Set<number>] {
  const leftValues = left.map((token) => normalizeToken(token.value));
  const rightValues = right.map((token) => normalizeToken(token.value));
  const matrix = lcsMatrix(leftValues, rightValues);
  const leftCommon = new Set<number>();
  const rightCommon = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < leftValues.length && j < rightValues.length) {
    if (leftValues[i] === rightValues[j]) {
      leftCommon.add(i);
      rightCommon.add(j);
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return [
    new Set(leftValues.map((_, index) => index).filter((index) => !leftCommon.has(index))),
    new Set(rightValues.map((_, index) => index).filter((index) => !rightCommon.has(index))),
  ];
}

function mergeRanges(tokens: Token[], indexes: Set<number>, lineNumber: number): RangeTokenNode[] {
  const ranges: RangeTokenNode[] = [];
  let current: RangeTokenNode | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!indexes.has(index)) continue;
    const token = tokens[index];
    if (!token.significant) continue;
    const start = token.start;
    const end = token.start + token.value.length;
    if (current && start <= current.start + current.length) {
      current.length = Math.max(current.length, end - current.start);
    } else {
      current = { type: 'edit', lineNumber, start, length: token.value.length };
      ranges.push(current);
    }
  }
  return ranges;
}

function mergeCharacterRanges(indexes: Set<number>, lineNumber: number): RangeTokenNode[] {
  const ranges: RangeTokenNode[] = [];
  let current: RangeTokenNode | null = null;
  for (const index of [...indexes].sort((a, b) => a - b)) {
    if (current && index <= current.start + current.length) {
      current.length = Math.max(current.length, index + 1 - current.start);
    } else {
      current = { type: 'edit', lineNumber, start: index, length: 1 };
      ranges.push(current);
    }
  }
  return ranges;
}

function diffPairByChars(leftChange: ChangeData, rightChange: ChangeData): [RangeTokenNode[], RangeTokenNode[]] {
  const leftChars = Array.from(leftChange.content).map((value, index) => ({ start: index, value, significant: value.trim().length > 0 }));
  const rightChars = Array.from(rightChange.content).map((value, index) => ({ start: index, value, significant: value.trim().length > 0 }));
  const [leftChanged, rightChanged] = getChangedInlineTokenIndexes(leftChars, rightChars);
  const leftRanges = mergeCharacterRanges(leftChanged, getLineNumber(leftChange));
  const rightRanges = mergeCharacterRanges(rightChanged, getLineNumber(rightChange));
  const leftChangedRatio = leftChanged.size / Math.max(1, leftChars.length);
  const rightChangedRatio = rightChanged.size / Math.max(1, rightChars.length);
  if (leftChangedRatio > 0.9 && rightChangedRatio > 0.9) return [[], []];
  return [leftRanges, rightRanges];
}

function diffPairByWords(leftChange: ChangeData, rightChange: ChangeData): [RangeTokenNode[], RangeTokenNode[]] {
  const leftTokens = tokenizeInlineDiffLine(leftChange.content).filter((token) => token.significant);
  const rightTokens = tokenizeInlineDiffLine(rightChange.content).filter((token) => token.significant);
  if (leftTokens.length === 0 || rightTokens.length === 0) return [[], []];
  const [leftChanged, rightChanged] = getChangedInlineTokenIndexes(leftTokens, rightTokens);
  const leftRanges = mergeRanges(leftTokens, leftChanged, getLineNumber(leftChange));
  const rightRanges = mergeRanges(rightTokens, rightChanged, getLineNumber(rightChange));
  const leftChangedRatio = leftChanged.size / Math.max(1, leftTokens.length);
  const rightChangedRatio = rightChanged.size / Math.max(1, rightTokens.length);
  if (leftChangedRatio > 0.82 && rightChangedRatio > 0.82) return [[], []];
  return [leftRanges, rightRanges];
}

export function markSmartEdits(hunks: HunkData[], mode: SmartInlineDiffMode): TokenizeEnhancer {
  const oldRanges: RangeTokenNode[] = [];
  const newRanges: RangeTokenNode[] = [];
  for (const hunk of hunks) {
    for (const block of findChangeBlocks(hunk.changes)) {
      const deletes = block.filter(isDelete);
      const inserts = block.filter(isInsert);
      for (const [deletion, insertion] of pairLines(deletes, inserts)) {
        const [oldEdits, newEdits] = mode === 'chars'
          ? diffPairByChars(deletion, insertion)
          : diffPairByWords(deletion, insertion);
        oldRanges.push(...oldEdits);
        newRanges.push(...newEdits);
      }
    }
  }
  return pickRanges(oldRanges, newRanges);
}
