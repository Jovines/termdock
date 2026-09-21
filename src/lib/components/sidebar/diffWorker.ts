import './diffWorkerGlobalShim';
import { parseDiff, tokenize, type FileData, type HunkData, type HunkTokens } from 'react-diff-view';
import refractor from 'refractor';
import { markSmartEdits, type SmartInlineDiffMode, type InlineWhitespacePolicy } from './inlineDiff';
import { shouldComputeInlineDiff, shouldSyntaxHighlightDiff } from './diffComputationPolicy';


interface ParseRequest {
  id: number;
  diffContent: string;
  inlineMode: 'none' | SmartInlineDiffMode;
  oldSource?: string;
  language?: string;
  whitespace?: InlineWhitespacePolicy;
}

interface ParseSuccess {
  id: number;
  ok: true;
  files: FileData[];
  tokens: Array<[string, HunkTokens]>;
  parseMs: number;
  tokenizeMs: number;
}

interface ParseFailure {
  id: number;
  ok: false;
  error: string;
}

function fileTokenKey(file: FileData): string {
  return `${file.oldRevision}-${file.newRevision}-${file.newPath}`;
}

/** Missing context must not carry an unterminated comment/string into later hunks. */
function highlightPartialSource(
  hunks: HunkData[],
  language: string,
  inlineMode: SmartInlineDiffMode,
  whitespace: InlineWhitespacePolicy,
): HunkTokens {
  const groups: HunkData[][] = [];
  for (const hunk of hunks) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (previous && previous.oldStart + previous.oldLines === hunk.oldStart
      && previous.newStart + previous.newLines === hunk.newStart) {
      group.push(hunk);
    } else {
      groups.push([hunk]);
    }
  }
  const result: HunkTokens = { old: [], new: [] };
  for (const group of groups) {
    const tokens = tokenize(group, {
      enhancers: [markSmartEdits(group, inlineMode, whitespace)],
      highlight: true, refractor, language,
    });
    // tokenize pads omitted lines. Copy only actual hunk ranges so later
    // groups cannot overwrite earlier tokens with that padding.
    for (const hunk of group) {
      for (const side of ['old', 'new'] as const) {
        const start = hunk[`${side}Start`] - 1;
        const end = start + hunk[`${side}Lines`];
        for (let line = start; line < end; line += 1) result[side][line] = tokens[side][line];
      }
    }
  }
  return result;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, diffContent, inlineMode, oldSource, language, whitespace = 'default' } = event.data;
  const parseStarted = performance.now();
  try {
    const files = parseDiff(diffContent);
    const parseMs = Math.round(performance.now() - parseStarted);
    const tokenizeStarted = performance.now();
    const tokens: Array<[string, HunkTokens]> = [];
    if (inlineMode !== 'none' && shouldComputeInlineDiff(diffContent)) {
      const syntaxHighlight = Boolean(language && shouldSyntaxHighlightDiff(diffContent, oldSource));
      for (const file of files) {
        if (file.hunks.length === 0) continue;
        try {
          const hunkData = file.hunks as HunkData[];
          const enhancers = [markSmartEdits(hunkData, inlineMode, whitespace)];
          let hunkTokens: HunkTokens;
          if (language && syntaxHighlight) {
            try {
              hunkTokens = oldSource
                ? tokenize(hunkData, { enhancers, oldSource, highlight: true, refractor, language })
                : highlightPartialSource(hunkData, language, inlineMode, whitespace);
            } catch {
              // A syntax grammar failure must not erase the inline edits.
              hunkTokens = tokenize(hunkData, { enhancers, oldSource });
            }
          } else {
            hunkTokens = tokenize(hunkData, { enhancers, oldSource });
          }
          tokens.push([fileTokenKey(file), hunkTokens]);
        } catch {
          // Keep one bad file from breaking the whole diff.
        }
      }
    }
    const message: ParseSuccess = {
      id,
      ok: true,
      files,
      tokens,
      parseMs,
      tokenizeMs: Math.round(performance.now() - tokenizeStarted),
    };
    self.postMessage(message);
  } catch (error) {
    const message: ParseFailure = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(message);
  }
};
