import { describe, expect, it } from 'vitest';
import { parseDiff } from 'react-diff-view';
import {
  computeSmartInlineRanges,
  findMovedLineCandidates,
  getChangedInlineTokenIndexes,
  getInlineDiffSimilarity,
  getJetBrainsStyleDiffRanges,
  getPreciseWordDiffRanges,
  pairChangedLinesForDisplay,
  retainComparableInlineRanges,
  tokenizeInlineDiffLine,
} from './inlineDiff';

function parseSingleHunk(body: string) {
  const [file] = parseDiff(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1,3 +1,3 @@
${body}`);
  return file.hunks[0];
}

describe('inline diff token heuristics', () => {
  it('tokenizes identifiers, punctuation, whitespace, and CJK text separately', () => {
    const tokens = tokenizeInlineDiffLine('foo(bar, "热")');
    expect(tokens.map((token) => token.value)).toEqual(['foo', '(', 'bar', ',', ' ', '"', '热', '"', ')']);
  });

  it('scores similar code lines higher than unrelated replacements', () => {
    const before = 'tracker.reportClick(searchHintBeen, url)';
    const after = 'tracker.reportClick(searchHintBeen, url, source = "hint_icon")';
    const unrelated = 'return JSONObject().apply { put("segments", JSONArray()) }';

    expect(getInlineDiffSimilarity(before, after)).toBeGreaterThan(0.65);
    expect(getInlineDiffSimilarity(before, unrelated)).toBeLessThan(0.35);
  });

  it('marks only changed tokens for an appended argument', () => {
    const before = tokenizeInlineDiffLine('tracker.reportClick(searchHintBeen, url)').filter((token) => token.significant);
    const after = tokenizeInlineDiffLine('tracker.reportClick(searchHintBeen, url, source = "hint_icon")').filter((token) => token.significant);
    const [beforeChanged, afterChanged] = getChangedInlineTokenIndexes(before, after);

    expect([...beforeChanged]).toEqual([]);
    const changedValues = [...afterChanged].map((index) => after[index].value);
    expect(changedValues).toEqual([',', 'source', '=', '"', 'hint_icon', '"']);
  });

  it('can identify character-level replacements inside one token', () => {
    const before = tokenizeInlineDiffLine('mode = "basic"').filter((token) => token.significant);
    const after = tokenizeInlineDiffLine('mode = "advanced"').filter((token) => token.significant);
    const [beforeChanged, afterChanged] = getChangedInlineTokenIndexes(before, after);

    expect([...beforeChanged].map((index) => before[index].value)).toContain('basic');
    expect([...afterChanged].map((index) => after[index].value)).toContain('advanced');
  });

  it('uses IntelliJ word chunks rather than partial identifier affixes', () => {
    const before = '  config.timeoutMs = 1000;';
    const after = '  config.timeoutSec = 1500;';
    const [beforeRanges, afterRanges] = getPreciseWordDiffRanges(before, after);

    expect(beforeRanges.map((range) => before.slice(range.start, range.start + range.length))).toEqual(['timeoutMs', '1000']);
    expect(afterRanges.map((range) => after.slice(range.start, range.start + range.length))).toEqual(['timeoutSec', '1500']);
  });

  it('creates one precise chunk for an appended argument', () => {
    const before = 'tracker.reportClick(searchHintBeen, url)';
    const after = 'tracker.reportClick(searchHintBeen, url, source = "hint_icon")';
    const [beforeRanges, afterRanges] = getPreciseWordDiffRanges(before, after);

    expect(beforeRanges).toEqual([]);
    expect(afterRanges.map((range) => after.slice(range.start, range.start + range.length))).toEqual([
      ', source = "hint_icon"',
    ]);
  });

  it('keeps replacement highlights contiguous instead of fragmenting punctuation', () => {
    const before = 'const mode = "basic";';
    const after = 'const mode = "advanced";';
    const [beforeRanges, afterRanges] = getPreciseWordDiffRanges(before, after);

    expect(beforeRanges.map((range) => before.slice(range.start, range.start + range.length))).toEqual(['basic']);
    expect(afterRanges.map((range) => after.slice(range.start, range.start + range.length))).toEqual(['advanced']);
  });

  it('keeps strong highlighting for a partial inline difference', () => {
    const value = 'const mode = "advanced";';
    const start = value.indexOf('advanced');

    expect(retainComparableInlineRanges(value, [{ start, length: 'advanced'.length }])).toEqual([
      { start, length: 'advanced'.length },
    ]);
  });

  it('drops strong highlighting when the whole visible line is new or removed', () => {
    const value = '  entirelyNewCall();';

    expect(retainComparableInlineRanges(value, [{ start: 0, length: value.length }])).toEqual([]);
    expect(retainComparableInlineRanges(value, [{ start: 2, length: value.length - 2 }])).toEqual([]);
  });

  it('drops strong highlighting for indentation-only changes', () => {
    const value = '    executeTask(input);';

    expect(retainComparableInlineRanges(value, [{ start: 0, length: 2 }])).toEqual([]);
  });

  it('does not manufacture inline edits for unrelated replacement lines', () => {
    const hunk = parseSingleHunk(`-const retries = calculateRetryBudget(request);
+notifyObservers(session.status);`);

    expect(computeSmartInlineRanges([hunk], 'words')).toEqual({ oldRanges: [], newRanges: [] });
  });

  it('uses a shared code skeleton to pair localized Unicode content changes', () => {
    expect(getInlineDiffSimilarity(
      "  status: '正在连接 👩‍💻 café',",
      "  status: '连接成功 👩🏽‍💻 café',",
    )).toBeGreaterThanOrEqual(0.7);
  });

  it('rejects comment-to-code pairing even when their words overlap', () => {
    expect(getInlineDiffSimilarity(
      '  // retry request after backoff',
      "  logger.info('retry request after backoff');",
    )).toBe(0);
  });

  it('refines only the changed value on confidently paired lines', () => {
    const hunk = parseSingleHunk(`-config.timeoutMs = 1000;
+config.timeoutMs = 1500;`);
    const ranges = computeSmartInlineRanges([hunk], 'words');

    expect(ranges.oldRanges).toEqual([{ type: 'edit', lineNumber: 1, start: 19, length: 4 }]);
    expect(ranges.newRanges).toEqual([{ type: 'edit', lineNumber: 1, start: 19, length: 4 }]);
  });

  it('keeps a wrapped code block stable and highlights only the if wrapper and indentation', () => {
    const before = [
      '  prepare();',
      '  executeTask(input);',
      '  finish();',
    ].join('\n');
    const after = [
      '  if (shouldRun) {',
      '    prepare();',
      '    executeTask(input);',
      '    finish();',
      '  }',
    ].join('\n');
    const [beforeRanges, afterRanges] = getJetBrainsStyleDiffRanges(before, after, 'words');
    const beforeHighlights = beforeRanges.map((range) => before.slice(range.start, range.start + range.length));
    const afterHighlights = afterRanges.map((range) => after.slice(range.start, range.start + range.length));

    expect(beforeHighlights).toEqual([]);
    expect(afterHighlights).toEqual([
      '  if (shouldRun) {\n  ',
      '  ',
      '  ',
      '\n  }',
    ]);
  });

  it('detects moved unchanged lines as candidates', () => {
    const moved = findMovedLineCandidates(
      [
        { lineNumber: 10, content: "const inlineOptions = ['words', 'chars', 'none'];" },
        { lineNumber: 11, content: "const inlineMode = settings.inlineMode;" },
      ],
      [
        { lineNumber: 30, content: "const inlineOptions = ['words', 'chars', 'none'];" },
        { lineNumber: 31, content: "const inlineMode = settings.inlineMode;" },
      ],
    );

    expect(moved).toEqual([
      { oldLineNumber: 10, newLineNumber: 30, score: 1 },
      { oldLineNumber: 11, newLineNumber: 31, score: 1 },
    ]);
  });

  it('keeps a moved block when one anchored line is also edited', () => {
    const moved = findMovedLineCandidates(
      [
        { lineNumber: 2, content: 'const timeoutMs = config.timeoutMs;' },
        { lineNumber: 3, content: 'return runTask(timeoutMs);' },
      ],
      [
        { lineNumber: 30, content: 'const timeoutMs = config.timeoutMs;' },
        { lineNumber: 31, content: 'return runTask(timeoutMs, signal);' },
      ],
    );

    expect(moved.map(({ oldLineNumber, newLineNumber }) => [oldLineNumber, newLineNumber])).toEqual([
      [2, 30],
      [3, 31],
    ]);
  });

  it('does not classify adjacent insert-then-modify changes as moved lines', () => {
    const moved = findMovedLineCandidates(
      [{ lineNumber: 4, content: '  config.timeoutMs = 1000;' }],
      [
        { lineNumber: 4, content: "  config.algorithm = 'histogram';" },
        { lineNumber: 5, content: '  config.timeoutMs = 1500;' },
      ],
    );

    expect(moved).toEqual([]);
  });

  it('pairs grouped delete and insert lines for split display alignment', () => {
    const pairs = pairChangedLinesForDisplay(
      [
        { lineNumber: 2, content: "import type { ChangeAuditRecord, GitChangedFile } from '../../terminal/api';" },
        { lineNumber: 3, content: "import { DiffViewer, type DiffViewType } from './DiffViewer';" },
      ],
      [
        { lineNumber: 2, content: "import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';" },
        { lineNumber: 3, content: "import { DiffViewer, type DiffInlineMode, type DiffViewType } from './DiffViewer';" },
      ],
    );

    expect(pairs.map(({ oldLineNumber, newLineNumber }) => [oldLineNumber, newLineNumber])).toEqual([[2, 2], [3, 3]]);
  });

  it('keeps adjacent object properties aligned when their value expressions are replaced', () => {
    const pairs = pairChangedLinesForDisplay(
      [
        { lineNumber: 559, content: '        start: start - line.start,' },
        { lineNumber: 560, content: '        length: end - start,' },
      ],
      [
        { lineNumber: 769, content: '        start: range.start,' },
        { lineNumber: 770, content: '        length: range.length,' },
      ],
    );

    expect(pairs.map(({ oldLineNumber, newLineNumber }) => [oldLineNumber, newLineNumber])).toEqual([
      [559, 769],
      [560, 770],
    ]);
    expect(pairs[1]?.score).toBe(0.55);
  });

  it('keeps property-name anchors out of generic and multi-line similarity', () => {
    expect(getInlineDiffSimilarity(
      'status: calculateRetryBudget(request),',
      'status: notifyObservers(session),',
    )).toBeLessThan(0.42);
    expect(getInlineDiffSimilarity(
      'status: calculateRetryBudget(request),\nretry: oldPolicy,',
      'status: notifyObservers(session),\nretry: newTransport,',
    )).toBeLessThan(0.5);
  });

  it('does not use a repeated property name as an ambiguous row anchor', () => {
    const pairs = pairChangedLinesForDisplay(
      [
        { lineNumber: 1, content: 'name: calculateRetryBudget(request),' },
        { lineNumber: 2, content: 'name: serializeWorkspaceSnapshot(root),' },
      ],
      [
        { lineNumber: 10, content: 'name: notifyObservers(session),' },
        { lineNumber: 11, content: 'name: publishTelemetryChannel(socket),' },
      ],
    );

    expect(pairs).toEqual([]);
  });

  it('keeps unique middle anchors when a word diff is too large for the full matrix', () => {
    const left = [...Array.from({ length: 650 }, (_, index) => `oldBefore${index}`), 'stableMiddleAnchor', ...Array.from({ length: 650 }, (_, index) => `oldAfter${index}`)].join(' ');
    const right = [...Array.from({ length: 650 }, (_, index) => `newBefore${index}`), 'stableMiddleAnchor', ...Array.from({ length: 650 }, (_, index) => `newAfter${index}`)].join(' ');
    const [leftRanges, rightRanges] = getJetBrainsStyleDiffRanges(left, right, 'words');

    expect(leftRanges.map((range) => left.slice(range.start, range.start + range.length))).not.toContain('stableMiddleAnchor');
    expect(rightRanges.map((range) => right.slice(range.start, range.start + range.length))).not.toContain('stableMiddleAnchor');
    expect(leftRanges).toHaveLength(2);
    expect(rightRanges).toHaveLength(2);
  });

  it('uses bounded patience alignment for very large changed line blocks', () => {
    const deletes = Array.from({ length: 400 }, (_, index) => ({
      lineNumber: index + 1,
      content: index === 120 ? 'const stableFirst = loadWorkspace();' : index === 310 ? 'return stableResult;' : `oldOnlyLine${index}();`,
    }));
    const inserts = Array.from({ length: 400 }, (_, index) => ({
      lineNumber: index + 501,
      content: index === 80 ? 'const stableFirst = loadWorkspace();' : index === 330 ? 'return stableResult;' : `newOnlyLine${index}();`,
    }));

    expect(pairChangedLinesForDisplay(deletes, inserts)).toEqual([
      { oldLineNumber: 121, newLineNumber: 581, score: 1 },
      { oldLineNumber: 311, newLineNumber: 831, score: 1 },
    ]);
  });
});
