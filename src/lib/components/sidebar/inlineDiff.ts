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

export function pairChangedLinesForDisplay(
  deletes: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  inserts: Array<Pick<ChangeData, 'content'> & { lineNumber: number }>,
  threshold = 0.18,
): PairedChangedLine[] {
  if (deletes.length === 0 || inserts.length === 0) return [];
  const scores = deletes.map((deletion) => (
    inserts.map((insertion) => getInlineDiffSimilarity(deletion.content, insertion.content))
  ));
  const matrix = Array.from(
    { length: deletes.length + 1 },
    () => Array<number>(inserts.length + 1).fill(0),
  );
  for (let oldIndex = deletes.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = inserts.length - 1; newIndex >= 0; newIndex -= 1) {
      const similarity = scores[oldIndex][newIndex];
      const paired = similarity >= threshold
        ? similarity + matrix[oldIndex + 1][newIndex + 1]
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
    const similarity = scores[oldIndex][newIndex];
    const isPair = similarity >= threshold
      && Math.abs(
        similarity + matrix[oldIndex + 1][newIndex + 1] - matrix[oldIndex][newIndex],
      ) < 0.000001;
    if (isPair) {
      pairs.push({
        oldLineNumber: deletes[oldIndex].lineNumber,
        newLineNumber: inserts[newIndex].lineNumber,
        score: similarity,
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

function lcsPairs(left: string[], right: string[]): MatchPair[] {
  if (left.length === 0 || right.length === 0) return [];
  // IntelliJ's DiffIterableUtil has a large-input guard. Keep the worker
  // bounded as well; huge changed blocks fall back to stable prefix/suffix
  // anchors instead of blocking the sidebar with an O(n*m) allocation.
  if (left.length * right.length > 1_200_000) {
    const pairs: MatchPair[] = [];
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
      pairs.push({ left: prefix, right: prefix });
      prefix += 1;
    }
    let leftSuffix = left.length - 1;
    let rightSuffix = right.length - 1;
    const suffix: MatchPair[] = [];
    while (
      leftSuffix >= prefix
      && rightSuffix >= prefix
      && left[leftSuffix] === right[rightSuffix]
    ) {
      suffix.push({ left: leftSuffix, right: rightSuffix });
      leftSuffix -= 1;
      rightSuffix -= 1;
    }
    return [...pairs, ...suffix.reverse()];
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

function projectBlockRanges(ranges: InlineDiffRange[], block: BlockText): RangeTokenNode[] {
  const nodes: RangeTokenNode[] = [];
  for (const range of ranges) {
    const rangeEnd = range.start + range.length;
    for (const line of block.lines) {
      const start = Math.max(range.start, line.start);
      const end = Math.min(rangeEnd, line.end);
      if (end <= start) continue;
      nodes.push({
        type: 'edit',
        lineNumber: line.lineNumber,
        start: start - line.start,
        length: end - start,
      });
    }
  }
  return nodes;
}

export function markSmartEdits(hunks: HunkData[], mode: SmartInlineDiffMode): TokenizeEnhancer {
  const oldRanges: RangeTokenNode[] = [];
  const newRanges: RangeTokenNode[] = [];
  for (const hunk of hunks) {
    for (const block of findChangeBlocks(hunk.changes)) {
      const deletes = block.filter(isDelete);
      const inserts = block.filter(isInsert);
      const oldBlock = buildBlockText(deletes);
      const newBlock = buildBlockText(inserts);
      const [oldEdits, newEdits] = getJetBrainsStyleDiffRanges(oldBlock.text, newBlock.text, mode);
      oldRanges.push(...projectBlockRanges(oldEdits, oldBlock));
      newRanges.push(...projectBlockRanges(newEdits, newBlock));
    }
  }
  return pickRanges(oldRanges, newRanges);
}
