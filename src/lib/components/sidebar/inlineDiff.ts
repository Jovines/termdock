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

function leadingPropertyName(value: string): string | null {
  const match = value.match(/^\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)|['"]([^'"]+)['"])\s*:/u);
  return match?.[1] ?? match?.[2] ?? null;
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

export function pairChangedLinesForDisplay(
  deletes: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  inserts: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  threshold = 0.42,
): PairedChangedLine[] {
  if (deletes.length === 0 || inserts.length === 0) return [];
  if (deletes.length * inserts.length > 40_000) {
    const oldKeys = deletes.map((change) => {
      const trimmed = change.content.trim();
      return /[\p{L}\p{N}_$]/u.test(trimmed) ? trimmed : '';
    });
    const newKeys = inserts.map((change) => {
      const trimmed = change.content.trim();
      return /[\p{L}\p{N}_$]/u.test(trimmed) ? trimmed : '';
    });
    return patienceAnchors(oldKeys, newKeys)
      .filter((pair) => oldKeys[pair.left] !== '')
      .map((pair) => ({
        oldLineNumber: deletes[pair.left].lineNumber,
        newLineNumber: inserts[pair.right].lineNumber,
        score: getInlineDiffSimilarity(deletes[pair.left].content, inserts[pair.right].content),
      }));
  }
  const deletedProperties = deletes.map((change) => leadingPropertyName(change.content));
  const insertedProperties = inserts.map((change) => leadingPropertyName(change.content));
  const countProperties = (properties: Array<string | null>) => {
    const counts = new Map<string, number>();
    for (const property of properties) {
      if (property) counts.set(property, (counts.get(property) ?? 0) + 1);
    }
    return counts;
  };
  const deletedPropertyCounts = countProperties(deletedProperties);
  const insertedPropertyCounts = countProperties(insertedProperties);
  const similarities = deletes.map((deletion, oldIndex) => (
    inserts.map((insertion, newIndex) => {
      const similarity = getInlineDiffSimilarity(deletion.content, insertion.content);
      // A unique object/config property name is a strong display identity even
      // when its complete value expression changes. Keep this boost local to
      // row alignment: the generic similarity is also used by moved-line and
      // multi-line inline-refinement logic, where this assumption is unsafe.
      const property = deletedProperties[oldIndex];
      return property
        && property === insertedProperties[newIndex]
        && deletedPropertyCounts.get(property) === 1
        && insertedPropertyCounts.get(property) === 1
        ? Math.max(0.55, similarity)
        : similarity;
    })
  ));
  const scores = similarities.map((row, oldIndex) => (
    row.map((similarity, newIndex) => {
      const oldPosition = deletes.length <= 1 ? 0 : oldIndex / (deletes.length - 1);
      const newPosition = inserts.length <= 1 ? 0 : newIndex / (inserts.length - 1);
      const proximityTieBreaker = (1 - Math.abs(oldPosition - newPosition)) * 0.0001;
      return similarity >= threshold ? similarity + proximityTieBreaker : similarity;
    })
  ));
  const matrix = Array.from(
    { length: deletes.length + 1 },
    () => Array<number>(inserts.length + 1).fill(0),
  );
  for (let oldIndex = deletes.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = inserts.length - 1; newIndex >= 0; newIndex -= 1) {
      const weightedScore = scores[oldIndex][newIndex];
      const paired = weightedScore >= threshold
        ? (weightedScore - threshold + 0.01) + matrix[oldIndex + 1][newIndex + 1]
        : Number.NEGATIVE_INFINITY;
      matrix[oldIndex][newIndex] = Math.max(
        paired,
        matrix[oldIndex + 1][newIndex],
        matrix[oldIndex][newIndex + 1],
      );
    }
  }

  const pairs: PairedChangedLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < deletes.length && newIndex < inserts.length) {
    const weightedScore = scores[oldIndex][newIndex];
    const pairValue = weightedScore - threshold + 0.01;
    const isPair = weightedScore >= threshold
      && Math.abs(
        pairValue + matrix[oldIndex + 1][newIndex + 1] - matrix[oldIndex][newIndex],
      ) < 0.000001;
    if (isPair) {
      pairs.push({
        oldLineNumber: deletes[oldIndex].lineNumber,
        newLineNumber: inserts[newIndex].lineNumber,
        score: similarities[oldIndex][newIndex],
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }
  return pairs;
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

function getJetBrainsWordChunks(text: string): JetBrainsChunk[] {
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
      if (alpha) chunks.push({ start: offset, end: offset + charLength, value });
    }
    offset += charLength;
  }
  if (wordStart !== -1) {
    chunks.push({ start: wordStart, end: text.length, value: text.slice(wordStart) });
  }
  return chunks;
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
  const chunkPairs = lcsPairs(
    leftChunks.map((chunk) => chunk.value),
    rightChunks.map((chunk) => chunk.value),
  );
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
  force: boolean,
): void {
  if (deletes.length === 0 || inserts.length === 0) return;
  const oldBlock = buildBlockText(deletes);
  const newBlock = buildBlockText(inserts);
  if (!force) {
    const oldKinds = deletes.map((change) => getLineSemanticKind(change.content));
    const newKinds = inserts.map((change) => getLineSemanticKind(change.content));
    if (oldKinds.join(',') !== newKinds.join(',')) return;
  }
  // Unpaired regions are refined only when their aggregate content is still
  // recognisably the same code (most commonly one line reformatted to many).
  // This prevents common punctuation in unrelated replacement lines from
  // creating authoritative-looking inline highlights.
  if (!force && getInlineDiffSimilarity(oldBlock.text, newBlock.text) < 0.5) return;
  const [oldEdits, newEdits] = getJetBrainsStyleDiffRanges(oldBlock.text, newBlock.text, mode);
  ranges.oldRanges.push(...projectBlockRanges(oldEdits, oldBlock));
  ranges.newRanges.push(...projectBlockRanges(newEdits, newBlock));
}

function appendMappedChangeBlock(block: ChangeData[], mode: SmartInlineDiffMode, ranges: SmartInlineRanges): void {
  const deletes = block.filter(isDelete);
  const inserts = block.filter(isInsert);
  if (deletes.length === 0 || inserts.length === 0) return;
  const pairs = pairChangedLinesForDisplay(
    deletes.map((change) => ({ content: change.content, lineNumber: getLineNumber(change) })),
    inserts.map((change) => ({ content: change.content, lineNumber: getLineNumber(change) })),
  );
  const oldIndexByLine = new Map(deletes.map((change, index) => [getLineNumber(change), index]));
  const newIndexByLine = new Map(inserts.map((change, index) => [getLineNumber(change), index]));
  let oldCursor = 0;
  let newCursor = 0;
  for (const pair of pairs) {
    const oldIndex = oldIndexByLine.get(pair.oldLineNumber);
    const newIndex = newIndexByLine.get(pair.newLineNumber);
    if (oldIndex === undefined || newIndex === undefined) continue;
    appendRefinedBlock(deletes.slice(oldCursor, oldIndex), inserts.slice(newCursor, newIndex), mode, ranges, false);
    appendRefinedBlock([deletes[oldIndex]], [inserts[newIndex]], mode, ranges, true);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  appendRefinedBlock(deletes.slice(oldCursor), inserts.slice(newCursor), mode, ranges, false);
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
