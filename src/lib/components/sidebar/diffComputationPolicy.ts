const MAX_INLINE_DIFF_BYTES = 1024 * 1024;
const MAX_INLINE_DIFF_LINES = 8_000;
const MAX_INLINE_LINE_LENGTH = 20_000;

interface TextShape {
  bytes: number;
  lines: number;
  maxLineLength: number;
}

function measureTextShape(value: string): TextShape {
  let lines = 1;
  let lineStart = 0;
  let maxLineLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue;
    maxLineLength = Math.max(maxLineLength, index - lineStart);
    lineStart = index + 1;
    lines += 1;
  }
  maxLineLength = Math.max(maxLineLength, value.length - lineStart);
  return { bytes: value.length, lines, maxLineLength };
}

export function shouldComputeInlineDiff(diffContent: string): boolean {
  const shape = measureTextShape(diffContent);
  return shape.bytes <= MAX_INLINE_DIFF_BYTES
    && shape.lines <= MAX_INLINE_DIFF_LINES
    && shape.maxLineLength <= MAX_INLINE_LINE_LENGTH;
}

export function shouldSyntaxHighlightDiff(diffContent: string, oldSource?: string): boolean {
  if (!shouldComputeInlineDiff(diffContent)) return false;
  if (!oldSource) return true;
  const sourceShape = measureTextShape(oldSource);
  return sourceShape.bytes <= MAX_INLINE_DIFF_BYTES
    && sourceShape.lines <= 20_000
    && sourceShape.maxLineLength <= MAX_INLINE_LINE_LENGTH;
}
