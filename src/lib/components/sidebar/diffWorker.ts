import { parseDiff, tokenize, type FileData, type HunkData, type HunkTokens } from 'react-diff-view';
import { markSmartEdits, type SmartInlineDiffMode } from './inlineDiff';

interface ParseRequest {
  id: number;
  diffContent: string;
  inlineMode: 'none' | SmartInlineDiffMode;
  oldSource?: string;
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

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, diffContent, inlineMode, oldSource } = event.data;
  const parseStarted = performance.now();
  try {
    const files = parseDiff(diffContent);
    const parseMs = Math.round(performance.now() - parseStarted);
    const tokenizeStarted = performance.now();
    const tokens: Array<[string, HunkTokens]> = [];
    if (inlineMode !== 'none') {
      for (const file of files) {
        if (file.hunks.length === 0) continue;
        try {
          const hunkData = file.hunks as HunkData[];
          tokens.push([
            fileTokenKey(file),
            tokenize(hunkData, {
              enhancers: [markSmartEdits(hunkData, inlineMode)],
              oldSource,
            }),
          ]);
        } catch {
          // Keep one bad hunk from breaking the whole diff.
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
