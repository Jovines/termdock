import { describe, expect, it } from 'vitest';
import {
  findMovedLineCandidates,
  getChangedInlineTokenIndexes,
  getInlineDiffSimilarity,
  pairChangedLinesForDisplay,
  tokenizeInlineDiffLine,
} from './inlineDiff';

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
});
