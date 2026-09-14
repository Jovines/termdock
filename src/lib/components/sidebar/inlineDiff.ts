import { pickRanges, type HunkData, type RangeTokenNode, type TokenizeEnhancer } from 'react-diff-view';

type ChangeData = HunkData['changes'][number];

export type SmartInlineDiffMode = 'words' | 'chars';

export interface MovedLineCandidate {
  oldLineNumber: number;
  newLineNumber: number;
  score: number;
}

export interface InlineDiffRange {
  start: number;
  length: number;
}

interface Token {
  start: number;
  value: string;
  significant: boolean;
}

interface JetBrainsChunk {
  start: number;
  end: number;
  value: string;
}

interface MatchPair {
  left: number;
  right: number;
}

interface BlockLine {
  start: number;
  end: number;
  lineNumber: number;
}

interface BlockText {
  text: string;
  lines: BlockLine[];
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

function meaningfulTokens(value: string): string[] {
  return significantTokens(value).filter((token) => /[\p{L}\p{N}_$]/u.test(token));
}

function multisetDice(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  let intersection = 0;
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    counts.set(value, count - 1);
  }
  return (2 * intersection) / (left.length + right.length);
}

function characterBigrams(value: string): string[] {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 2) return normalized ? [normalized] : [];
  const bigrams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.push(normalized.slice(index, index + 2));
  }
  return bigrams;
}

type LineSemanticKind = 'blank' | 'comment' | 'code';

function getLineSemanticKind(value: string): LineSemanticKind {
  const trimmed = value.trim();
  if (!trimmed) return 'blank';
  return /^(?:\/\/|\/\*|\*|<!--|-->)/u.test(trimmed) ? 'comment' : 'code';
}

function lineKindsAreCompatible(left: string, right: string): boolean {
  if (left.includes('\n') || right.includes('\n')) return true;
  const leftKind = getLineSemanticKind(left);
  const rightKind = getLineSemanticKind(right);
  return leftKind === rightKind || leftKind === 'blank' || rightKind === 'blank';
}

function structuralSkeleton(value: string): string {
  return value
    .trim()
    .replace(/(['"`])(?:\\.|[^\\])*?\1/gu, (_match, quote: string) => `${quote}${quote}`)
    .replace(/\b\d+(?:\.\d+)?\b/gu, '0')
    .replace(/\s+/gu, ' ');
}

export function getInlineDiffSimilarity(left: string, right: string): number {
  const trimmedLeft = left.trim();
  const trimmedRight = right.trim();
  if (left === right) {
    if (!trimmedLeft) return 0.1;
    return /[\p{L}\p{N}_$]/u.test(trimmedLeft) ? 1 : 0.3;
  }
  if (trimmedLeft === trimmedRight) {
    if (!trimmedLeft) return 0.1;
    // Braces and separators are plentiful in code and make poor anchors on
    // their own. Keep them available as a weak tie-breaker, not a line match.
    return /[\p{L}\p{N}_$]/u.test(trimmedLeft) ? 0.99 : 0.3;
  }
  if (!lineKindsAreCompatible(left, right)) return 0;
  const leftTokens = meaningfulTokens(trimmedLeft);
  const rightTokens = meaningfulTokens(trimmedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const orderedMatches = lcsPairs(leftTokens, rightTokens).length;
  const ordered = (2 * orderedMatches) / (leftTokens.length + rightTokens.length);
  const bag = multisetDice(leftTokens, rightTokens);
  const characters = multisetDice(characterBigrams(trimmedLeft), characterBigrams(trimmedRight));
  const lexicalScore = ordered * 0.5 + bag * 0.2 + characters * 0.3;
  const leftSkeleton = structuralSkeleton(trimmedLeft);
  const rightSkeleton = structuralSkeleton(trimmedRight);
  const sameSubstantiveSkeleton = leftSkeleton === rightSkeleton
    && /[\p{L}\p{N}_$]/u.test(leftSkeleton);
  return sameSubstantiveSkeleton ? Math.max(0.72, lexicalScore) : lexicalScore;
}

interface ChangedLineBlock {
  deletes: ChangeData[];
  inserts: ChangeData[];
  anchored: boolean;
}

// Adapted from JetBrains LineFragmentSplitter (Copyright 2000-2021
// JetBrains s.r.o. and contributors, Apache-2.0). Source at:
// https://github.com/JetBrains/intellij-community/blob/3e1b6c548e1d267865221e3bd70053242f8afb06/platform/util/diff/src/com/intellij/diff/comparison/LineFragmentSplitter.kt
// Split on matched newlines / matched first words, not arbitrary line
// similarity. Unmatched spans remain two-sided replacement blocks.
export function splitChangedLineBlock(block: ChangeData[]): ChangedLineBlock[] {
  const deletes = block.filter(isDelete);
  const inserts = block.filter(isInsert);
  if (!deletes.length || !inserts.length) return [{ deletes, inserts, anchored: false }];
  const oldText = deletes.map((line) => line.content).join('\n');
  const newText = inserts.map((line) => line.content).join('\n');
  const oldWords = getJetBrainsWordChunks(oldText, true);
  const newWords = getJetBrainsWordChunks(newText, true);
  const pairs = optimizeWordChunkPairs(oldWords, newWords, oldText, newText);
  const lineEnds = (words: JetBrainsChunk[], count: number) => {
    let line = 0;
    return [...words.map((word) => { if (word.value === '\n') line += 1; return line; }), count];
  };
  const oldEnds = lineEnds(oldWords, deletes.length);
  const newEnds = lineEnds(newWords, inserts.length);
  const blocks: ChangedLineBlock[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let hasEqualWords = false;
  let pending: (ChangedLineBlock & { hasWords: boolean; whitespaceOnly: boolean }) | undefined;
  const addBlock = (oldEnd: number, newEnd: number) => {
    if (oldCursor > oldEnd || newCursor > newEnd || (oldCursor === oldEnd && newCursor === newEnd)) return;
    const oldLines = deletes.slice(oldCursor, oldEnd);
    const newLines = inserts.slice(newCursor, newEnd);
    const before = oldLines.map((line) => line.content).join('\n');
    const after = newLines.map((line) => line.content).join('\n');
    const current = {
      deletes: oldLines, inserts: newLines, anchored: hasEqualWords,
      hasWords: getJetBrainsWordChunks(before + '\n' + after).length > 0,
      whitespaceOnly: before.replace(/\s/gu, '') === after.replace(/\s/gu, ''),
    };
    if (pending && ((!pending.anchored && !current.anchored)
      || (pending.whitespaceOnly && current.whitespaceOnly) || !pending.hasWords || !current.hasWords)) {
      pending.deletes.push(...current.deletes);
      pending.inserts.push(...current.inserts);
      pending.anchored ||= current.anchored;
      pending.hasWords ||= current.hasWords;
      pending.whitespaceOnly &&= current.whitespaceOnly;
    } else {
      if (pending) blocks.push(pending);
      pending = current;
    }
    oldCursor = oldEnd;
    newCursor = newEnd;
  };
  for (const pair of pairs) {
    const oldNewline = oldWords[pair.left].value === '\n';
    const newNewline = newWords[pair.right].value === '\n';
    if (oldNewline && newNewline) {
      addBlock(oldEnds[pair.left], newEnds[pair.right]);
      hasEqualWords = false;
    } else {
      const oldFirst = pair.left === 0 || oldWords[pair.left - 1].value === '\n';
      const newFirst = pair.right === 0 || newWords[pair.right - 1].value === '\n';
      if (oldFirst && newFirst) {
        addBlock(oldEnds[pair.left - 1] ?? 0, newEnds[pair.right - 1] ?? 0);
        hasEqualWords = false;
      }
      hasEqualWords = true;
    }
  }
  addBlock(deletes.length, inserts.length);
  if (pending) blocks.push(pending);
  return blocks;
}

// IntelliJ's default BY_WORD policy squashes adjoining word fragments back
// into one display region (ComparisonManagerImpl.processBlocks). Only truly
// unchanged lines delimit regions, as in the preceding ByLine stage. Git may
// include those lines in a replacement when indentation or ordering changed.
export function getChangedLineDisplayBlocks(block: ChangeData[]): ChangedLineBlock[] {
  const deletes = block.filter(isDelete);
  const inserts = block.filter(isInsert);
  const pairs = lcsPairs(deletes.map((line) => line.content.trim()), inserts.map((line) => line.content.trim()));
  const result: ChangedLineBlock[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const pair of pairs) {
    if (oldCursor < pair.left || newCursor < pair.right) {
      result.push({ deletes: deletes.slice(oldCursor, pair.left), inserts: inserts.slice(newCursor, pair.right), anchored: false });
    }
    result.push({ deletes: [deletes[pair.left]], inserts: [inserts[pair.right]], anchored: true });
    oldCursor = pair.left + 1;
    newCursor = pair.right + 1;
  }
  if (oldCursor < deletes.length || newCursor < inserts.length) {
    result.push({ deletes: deletes.slice(oldCursor), inserts: inserts.slice(newCursor), anchored: false });
  }
  return result;
}

export function findMovedLineCandidates(
  deletes: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  inserts: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  threshold = 0.7,
): MovedLineCandidate[] {
  const edges: Array<MovedLineCandidate & { oldIndex: number; newIndex: number }> = [];
  if (deletes.length * inserts.length > 50_000) {
    const insertedByContent = new Map<string, number[]>();
    for (const [newIndex, insertion] of inserts.entries()) {
      const key = insertion.content.trim();
      if (!/[\p{L}\p{N}_$]/u.test(key)) continue;
      const indexes = insertedByContent.get(key);
      if (indexes) indexes.push(newIndex);
      else insertedByContent.set(key, [newIndex]);
    }
    const deletedCounts = new Map(deletes.map((deletion) => [deletion.content.trim(), 0]));
    for (const deletion of deletes) {
      const key = deletion.content.trim();
      deletedCounts.set(key, (deletedCounts.get(key) ?? 0) + 1);
    }
    for (const [oldIndex, deletion] of deletes.entries()) {
      const key = deletion.content.trim();
      const newIndexes = insertedByContent.get(key);
      if (deletedCounts.get(key) !== 1 || newIndexes?.length !== 1) continue;
      const newIndex = newIndexes[0];
      edges.push({
        oldLineNumber: deletion.lineNumber,
        newLineNumber: inserts[newIndex].lineNumber,
        score: 1,
        oldIndex,
        newIndex,
      });
    }
  } else {
    for (const [oldIndex, deletion] of deletes.entries()) {
      for (const [newIndex, insertion] of inserts.entries()) {
        const score = getInlineDiffSimilarity(deletion.content, insertion.content);
        if (score < threshold) continue;
        edges.push({
          oldLineNumber: deletion.lineNumber,
          newLineNumber: insertion.lineNumber,
          score,
          oldIndex,
          newIndex,
        });
      }
    }
  }
  edges.sort((a, b) => b.score - a.score || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  const matches = edges.filter((edge) => {
    if (usedOld.has(edge.oldIndex) || usedNew.has(edge.newIndex)) return false;
    usedOld.add(edge.oldIndex);
    usedNew.add(edge.newIndex);
    return true;
  }).sort((a, b) => a.oldIndex - b.oldIndex);

  const runs: typeof matches[] = [];
  for (const match of matches) {
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && match.oldIndex === previous.oldIndex + 1 && match.newIndex === previous.newIndex + 1) {
      current.push(match);
    } else {
      runs.push([match]);
    }
  }
  const moved = runs.flatMap((run) => {
    if (run.length < 2) return [];
    const average = run.reduce((sum, candidate) => sum + candidate.score, 0) / run.length;
    if (average < 0.82 || !run.some((candidate) => candidate.score >= 0.95)) return [];
    const oldMin = run[0].oldLineNumber;
    const oldMax = run[run.length - 1].oldLineNumber;
    const newMin = run[0].newLineNumber;
    const newMax = run[run.length - 1].newLineNumber;
    if (!(newMin > oldMax + 1 || oldMin > newMax + 1)) return [];
    return run;
  });
  return moved.map(({ oldLineNumber, newLineNumber, score }) => ({ oldLineNumber, newLineNumber, score }));
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

function longestIncreasingRightIndexes(candidates: MatchPair[]): MatchPair[] {
  if (candidates.length === 0) return [];
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]].right < candidates[index].right) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const result: MatchPair[] = [];
  let cursor = tails[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    result.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  return result.reverse();
}

function patienceAnchors(left: string[], right: string[]): MatchPair[] {
  const leftPositions = new Map<string, number[]>();
  const rightPositions = new Map<string, number[]>();
  const indexValue = (positions: Map<string, number[]>, value: string, index: number) => {
    const entries = positions.get(value);
    if (entries) entries.push(index);
    else positions.set(value, [index]);
  };
  left.forEach((value, index) => indexValue(leftPositions, value, index));
  right.forEach((value, index) => indexValue(rightPositions, value, index));
  const candidates: MatchPair[] = [];
  for (const [value, positions] of leftPositions) {
    const other = rightPositions.get(value);
    if (positions.length === 1 && other?.length === 1) {
      candidates.push({ left: positions[0], right: other[0] });
    }
  }
  candidates.sort((a, b) => a.left - b.left);
  return longestIncreasingRightIndexes(candidates);
}

function stableEdgePairs(left: string[], right: string[]): MatchPair[] {
  const prefix: MatchPair[] = [];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    prefix.push({ left: start, right: start });
    start += 1;
  }
  const suffix: MatchPair[] = [];
  let leftEnd = left.length - 1;
  let rightEnd = right.length - 1;
  while (leftEnd >= start && rightEnd >= start && left[leftEnd] === right[rightEnd]) {
    suffix.push({ left: leftEnd, right: rightEnd });
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return [...prefix, ...suffix.reverse()];
}

function lcsPairs(left: string[], right: string[]): MatchPair[] {
  if (left.length === 0 || right.length === 0) return [];
  // Large blocks use patience-style unique anchors rather than allocating an
  // O(n*m) matrix. Unlike a prefix/suffix-only fallback, this retains stable
  // identifiers in the middle of generated files and long reformatted blocks.
  if (left.length * right.length > 1_200_000) {
    const anchors = patienceAnchors(left, right);
    return anchors.length > 0 ? anchors : stableEdgePairs(left, right);
  }

  const matrix = lcsMatrix(left, right);
  const pairs: MatchPair[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      pairs.push({ left: leftIndex, right: rightIndex });
      leftIndex += 1;
      rightIndex += 1;
    } else if (matrix[leftIndex + 1][rightIndex] >= matrix[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return pairs;
}

function commonTokenPairs(left: Token[], right: Token[]): Array<[number, number]> {
  const leftValues = left.map((token) => normalizeToken(token.value));
  const rightValues = right.map((token) => normalizeToken(token.value));
  return lcsPairs(leftValues, rightValues).map((pair) => [pair.left, pair.right]);
}

export function getChangedInlineTokenIndexes(left: Token[], right: Token[]): [Set<number>, Set<number>] {
  const leftCommon = new Set<number>();
  const rightCommon = new Set<number>();
  for (const [leftIndex, rightIndex] of commonTokenPairs(left, right)) {
    leftCommon.add(leftIndex);
    rightCommon.add(rightIndex);
  }
  return [
    new Set(left.map((_, index) => index).filter((index) => !leftCommon.has(index))),
    new Set(right.map((_, index) => index).filter((index) => !rightCommon.has(index))),
  ];
}

function pushRange(ranges: InlineDiffRange[], start: number, end: number): void {
  if (end <= start) return;
  const previous = ranges[ranges.length - 1];
  if (previous && start <= previous.start + previous.length) {
    previous.length = Math.max(previous.length, end - previous.start);
  } else {
    ranges.push({ start, length: end - start });
  }
}

// Port of the relevant IntelliJ ByWordRt stages (Apache-2.0):
// getInlineChunks -> word diff -> punctuation adjustment -> DefaultCorrector.
// The outer line blocks already come from Git's hunk, so the resulting offsets
// are projected back onto those lines instead of creating IntelliJ documents.
function isJetBrainsWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '\f';
}

function isJetBrainsPunctuation(value: string): boolean {
  const code = value.charCodeAt(0);
  if (code === 95) return false;
  return (code >= 33 && code <= 47)
    || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96)
    || (code >= 123 && code <= 126);
}

function isContinuousScript(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint < 128 || /\p{Decimal_Number}/u.test(value)) return false;
  if (codePoint > 0xffff) return true;
  return /\p{Ideographic}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Thai}|\p{Script=Javanese}/u.test(value)
    || !/\p{Alphabetic}/u.test(value);
}

function getJetBrainsWordChunks(text: string, includeNewlines = false): JetBrainsChunk[] {
  const chunks: JetBrainsChunk[] = [];
  let wordStart = -1;
  for (let offset = 0; offset < text.length;) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    const charLength = value.length;
    const alpha = !isJetBrainsWhitespace(value) && !isJetBrainsPunctuation(value);
    const wordPart = alpha && !isContinuousScript(value);
    if (wordPart) {
      if (wordStart === -1) wordStart = offset;
    } else {
      if (wordStart !== -1) {
        chunks.push({ start: wordStart, end: offset, value: text.slice(wordStart, offset) });
        wordStart = -1;
      }
      if (alpha || (includeNewlines && value === '\n')) chunks.push({ start: offset, end: offset + charLength, value });
    }
    offset += charLength;
  }
  if (wordStart !== -1) {
    chunks.push({ start: wordStart, end: text.length, value: text.slice(wordStart) });
  }
  return chunks;
}

// Adapted from JetBrains ChunkOptimizer.WordChunkOptimizer (Apache-2.0,
// Copyright 2000-2021 JetBrains s.r.o. and contributors). Merge adjacent
// matching runs and shift ambiguous matches to whitespace boundaries.
function optimizeWordChunkPairs(left: JetBrainsChunk[], right: JetBrainsChunk[], leftText: string, rightText: string): MatchPair[] {
  type Run = { start1: number; end1: number; start2: number; end2: number };
  const rawRuns: Run[] = [];
  for (const pair of lcsPairs(left.map((word) => word.value), right.map((word) => word.value))) {
    const last = rawRuns[rawRuns.length - 1];
    if (last && last.end1 === pair.left && last.end2 === pair.right) {
      last.end1 += 1;
      last.end2 += 1;
    } else {
      rawRuns.push({ start1: pair.left, end1: pair.left + 1, start2: pair.right, end2: pair.right + 1 });
    }
  }
  const separated = (words: JetBrainsChunk[], text: string, boundary: number) => {
    const a = words[boundary - 1];
    const b = words[boundary];
    return !a || !b || a.value === '\n' || b.value === '\n' || /[ \t\n]/u.test(text.slice(a.end, b.start));
  };
  const runs: Run[] = [];
  for (const run of rawRuns) {
    runs.push(run);
    while (runs.length >= 2) {
      const a = runs[runs.length - 2];
      const b = runs[runs.length - 1];
      if (a.end1 !== b.start1 && a.end2 !== b.start2) break;
      const count1 = a.end1 - a.start1;
      const count2 = b.end1 - b.start1;
      let forward = 0;
      while (forward < count2 && left[a.end1 + forward]?.value === right[a.end2 + forward]?.value) forward += 1;
      let backward = 0;
      while (backward < count1 && left[b.start1 - backward - 1]?.value === right[b.start2 - backward - 1]?.value) backward += 1;
      if (forward === count2) {
        runs.splice(-2, 2, { start1: a.start1, start2: a.start2, end1: a.end1 + count2, end2: a.end2 + count2 });
        continue;
      }
      if (backward === count1) {
        runs.splice(-2, 2, { start1: b.start1 - count1, start2: b.start2 - count1, end1: b.end1, end2: b.end2 });
        continue;
      }
      const touchLeft = a.end1 === b.start1;
      const words = touchLeft ? left : right;
      const text = touchLeft ? leftText : rightText;
      const start = touchLeft ? b.start1 : b.start2;
      if (separated(words, text, start)) break;
      let shift = 0;
      for (let step = 1; step <= forward; step += 1) {
        if (separated(words, text, start + step)) { shift = step; break; }
      }
      if (!shift) {
        for (let step = 1; step <= backward; step += 1) {
          if (separated(words, text, start - step)) { shift = -step; break; }
        }
      }
      a.end1 += shift;
      a.end2 += shift;
      b.start1 += shift;
      b.start2 += shift;
      break;
    }
  }
  return runs.flatMap((run) => Array.from({ length: run.end1 - run.start1 }, (_, index) => ({ left: run.start1 + index, right: run.start2 + index })));
}

function getJetBrainsCharChunks(text: string): JetBrainsChunk[] {
  const chunks: JetBrainsChunk[] = [];
  for (let offset = 0; offset < text.length;) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    const end = offset + value.length;
    if (!isJetBrainsWhitespace(value)) chunks.push({ start: offset, end, value });
    offset = end;
  }
  return chunks;
}

function getPunctuationChunks(text: string, start: number, end: number): JetBrainsChunk[] {
  const chunks: JetBrainsChunk[] = [];
  for (let offset = start; offset < end; offset += 1) {
    const value = text[offset];
    if (isJetBrainsPunctuation(value)) chunks.push({ start: offset, end: offset + 1, value });
  }
  return chunks;
}

function addChunkMatches(
  matches: MatchPair[],
  leftChunks: JetBrainsChunk[],
  rightChunks: JetBrainsChunk[],
): void {
  for (const pair of lcsPairs(
    leftChunks.map((chunk) => chunk.value),
    rightChunks.map((chunk) => chunk.value),
  )) {
    const leftChunk = leftChunks[pair.left];
    const rightChunk = rightChunks[pair.right];
    for (let offset = 0; offset < leftChunk.end - leftChunk.start; offset += 1) {
      matches.push({ left: leftChunk.start + offset, right: rightChunk.start + offset });
    }
  }
}

function addPunctuationAdjustmentMatches(
  matches: MatchPair[],
  left: string,
  right: string,
  wordPairs: MatchPair[],
  leftWords: JetBrainsChunk[],
  rightWords: JetBrainsChunk[],
): void {
  let leftCursor = 0;
  let rightCursor = 0;
  for (const pair of [...wordPairs, { left: leftWords.length, right: rightWords.length }]) {
    const leftEnd = pair.left < leftWords.length ? leftWords[pair.left].start : left.length;
    const rightEnd = pair.right < rightWords.length ? rightWords[pair.right].start : right.length;
    addChunkMatches(
      matches,
      getPunctuationChunks(left, leftCursor, leftEnd),
      getPunctuationChunks(right, rightCursor, rightEnd),
    );
    if (pair.left < leftWords.length && pair.right < rightWords.length) {
      leftCursor = leftWords[pair.left].end;
      rightCursor = rightWords[pair.right].end;
    }
  }
}

function compactMatches(matches: MatchPair[]): Array<{ start1: number; end1: number; start2: number; end2: number }> {
  const sorted = [...matches].sort((a, b) => a.left - b.left || a.right - b.right);
  const runs: Array<{ start1: number; end1: number; start2: number; end2: number }> = [];
  for (const match of sorted) {
    const previous = runs[runs.length - 1];
    if (previous && match.left === previous.end1 && match.right === previous.end2) {
      previous.end1 += 1;
      previous.end2 += 1;
    } else if (
      !previous
      || (match.left >= previous.end1 && match.right >= previous.end2)
    ) {
      runs.push({
        start1: match.left,
        end1: match.left + 1,
        start2: match.right,
        end2: match.right + 1,
      });
    }
  }
  return runs;
}

function addCorrectedChange(
  left: string,
  right: string,
  start1: number,
  end1: number,
  start2: number,
  end2: number,
  leftRanges: InlineDiffRange[],
  rightRanges: InlineDiffRange[],
): void {
  // IntelliJ DefaultCorrector pulls equal adjustment whitespace out of both
  // ends of a changed range after word and punctuation matching.
  // DefaultCorrector deliberately expands backward first. In a wrapper change
  // (`code` -> `if (...) {\n  code\n}`), this assigns the old indentation to
  // the still-matching inner line rather than to the new wrapper line.
  while (
    start1 < end1
    && start2 < end2
    && left[end1 - 1] === right[end2 - 1]
    && isJetBrainsWhitespace(left[end1 - 1])
  ) {
    end1 -= 1;
    end2 -= 1;
  }
  while (
    start1 < end1
    && start2 < end2
    && left[start1] === right[start2]
    && isJetBrainsWhitespace(left[start1])
  ) {
    start1 += 1;
    start2 += 1;
  }
  pushRange(leftRanges, start1, end1);
  pushRange(rightRanges, start2, end2);
}

export function getPreciseWordDiffRanges(left: string, right: string): [InlineDiffRange[], InlineDiffRange[]] {
  return getJetBrainsStyleDiffRanges(left, right, 'words');
}

export function getJetBrainsStyleDiffRanges(
  left: string,
  right: string,
  mode: SmartInlineDiffMode,
): [InlineDiffRange[], InlineDiffRange[]] {
  const leftChunks = mode === 'words' ? getJetBrainsWordChunks(left) : getJetBrainsCharChunks(left);
  const rightChunks = mode === 'words' ? getJetBrainsWordChunks(right) : getJetBrainsCharChunks(right);
  const chunkPairs = mode === 'words'
    ? optimizeWordChunkPairs(leftChunks, rightChunks, left, right)
    : lcsPairs(leftChunks.map((chunk) => chunk.value), rightChunks.map((chunk) => chunk.value));
  const matches: MatchPair[] = [];
  for (const pair of chunkPairs) {
    const leftChunk = leftChunks[pair.left];
    const rightChunk = rightChunks[pair.right];
    for (let offset = 0; offset < leftChunk.end - leftChunk.start; offset += 1) {
      matches.push({ left: leftChunk.start + offset, right: rightChunk.start + offset });
    }
  }
  if (mode === 'words') {
    addPunctuationAdjustmentMatches(matches, left, right, chunkPairs, leftChunks, rightChunks);
  }

  const leftRanges: InlineDiffRange[] = [];
  const rightRanges: InlineDiffRange[] = [];
  let leftCursor = 0;
  let rightCursor = 0;
  for (const run of compactMatches(matches)) {
    addCorrectedChange(
      left,
      right,
      leftCursor,
      run.start1,
      rightCursor,
      run.start2,
      leftRanges,
      rightRanges,
    );
    leftCursor = run.end1;
    rightCursor = run.end2;
  }
  addCorrectedChange(
    left,
    right,
    leftCursor,
    left.length,
    rightCursor,
    right.length,
    leftRanges,
    rightRanges,
  );
  return [leftRanges, rightRanges];
}

function buildBlockText(changes: ChangeData[]): BlockText {
  let text = '';
  const lines: BlockLine[] = [];
  for (const [index, change] of changes.entries()) {
    if (index > 0) text += '\n';
    const start = text.length;
    text += change.content;
    lines.push({ start, end: text.length, lineNumber: getLineNumber(change) });
  }
  return { text, lines };
}

export function retainComparableInlineRanges(value: string, ranges: InlineDiffRange[]): InlineDiffRange[] {
  if (ranges.length === 0) return ranges;
  const changed = new Uint8Array(value.length);
  for (const range of ranges) {
    const end = Math.min(value.length, range.start + range.length);
    for (let offset = Math.max(0, range.start); offset < end; offset += 1) changed[offset] = 1;
  }
  // Indentation and line-wrap changes are already communicated by the row
  // tint and the code's new shape. A saturated inline chip on a few spaces
  // makes an unchanged statement look substantively edited, especially when
  // a block is merely wrapped in an `if` or reformatted across lines.
  let changedVisibleCharacters = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    if (changed[offset] && /\S/u.test(value[offset])) changedVisibleCharacters += 1;
  }
  if (changedVisibleCharacters === 0) return [];
  // A strong inline highlight is useful only when the same line still contains
  // visible, unchanged content to compare against. Entirely new/removed lines
  // already have the softer insert/delete row tint, so painting all of their
  // text again adds emphasis without conveying any extra information.
  for (let offset = 0; offset < value.length; offset += 1) {
    if (!changed[offset] && /\S/u.test(value[offset])) return ranges;
  }
  return [];
}

function projectBlockRanges(ranges: InlineDiffRange[], block: BlockText): RangeTokenNode[] {
  const nodes: RangeTokenNode[] = [];
  for (const line of block.lines) {
    const lineRanges: InlineDiffRange[] = [];
    for (const range of ranges) {
      const rangeEnd = range.start + range.length;
      const start = Math.max(range.start, line.start);
      const end = Math.min(rangeEnd, line.end);
      if (end <= start) continue;
      lineRanges.push({ start: start - line.start, length: end - start });
    }
    const value = block.text.slice(line.start, line.end);
    for (const range of retainComparableInlineRanges(value, lineRanges)) {
      nodes.push({
        type: 'edit',
        lineNumber: line.lineNumber,
        start: range.start,
        length: range.length,
      });
    }
  }
  return nodes;
}

export interface SmartInlineRanges {
  oldRanges: RangeTokenNode[];
  newRanges: RangeTokenNode[];
}

function appendRefinedBlock(
  deletes: ChangeData[],
  inserts: ChangeData[],
  mode: SmartInlineDiffMode,
  ranges: SmartInlineRanges,
): void {
  if (deletes.length === 0 || inserts.length === 0) return;
  const oldBlock = buildBlockText(deletes);
  const newBlock = buildBlockText(inserts);
  // Use the same word boundaries as ByWordRt, including individual CJK
  // characters. A normalized whole-line similarity threshold loses expanded
  // prose even when much of the old text survives. Only suppress refinement
  // when there is no shared substantive word (punctuation alone is not useful).
  {
    const oldWords = new Set(getJetBrainsWordChunks(oldBlock.text)
      .map((chunk) => chunk.value).filter((word) => /[\p{L}\p{N}_$]/u.test(word)));
    if (!getJetBrainsWordChunks(newBlock.text).some((chunk) => oldWords.has(chunk.value))) return;
  }
  const [oldEdits, newEdits] = getJetBrainsStyleDiffRanges(oldBlock.text, newBlock.text, mode);
  ranges.oldRanges.push(...projectBlockRanges(oldEdits, oldBlock));
  ranges.newRanges.push(...projectBlockRanges(newEdits, newBlock));
}

function appendMappedChangeBlock(block: ChangeData[], mode: SmartInlineDiffMode, ranges: SmartInlineRanges): void {
  for (const { deletes, inserts } of splitChangedLineBlock(block)) {
    appendRefinedBlock(deletes, inserts, mode, ranges);
  }
}

export function computeSmartInlineRanges(hunks: HunkData[], mode: SmartInlineDiffMode): SmartInlineRanges {
  const oldRanges: RangeTokenNode[] = [];
  const newRanges: RangeTokenNode[] = [];
  const ranges = { oldRanges, newRanges };
  for (const hunk of hunks) {
    for (const block of findChangeBlocks(hunk.changes)) {
      appendMappedChangeBlock(block, mode, ranges);
    }
  }
  return ranges;
}

export function markSmartEdits(hunks: HunkData[], mode: SmartInlineDiffMode): TokenizeEnhancer {
  const { oldRanges, newRanges } = computeSmartInlineRanges(hunks, mode);
  return pickRanges(oldRanges, newRanges);
}
