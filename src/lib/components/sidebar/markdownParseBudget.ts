// A cooperative deadline only works when each individual parser operation is
// bounded. Keep regex inputs small and check between tokens/blocks; never use
// nested, ambiguous repetitions to recognise link destinations.
export const MARKDOWN_PARSE_TIMEOUT_MS = 100;
const MAX_DOCUMENT_CHARS = 500_000;
const MAX_LINES = 10_000;
const MAX_INLINE_CHARS = 16_384;
const MAX_DEPTH = 32;
const MAX_OPERATIONS = 100_000;

export class MarkdownParseError extends Error {
  constructor(public readonly reason: 'timeout' | 'size' | 'depth' | 'complexity') {
    super(`Markdown preview parsing stopped: ${reason}`);
    this.name = 'MarkdownParseError';
  }
}

export class MarkdownParseBudget {
  private readonly startedAt = performance.now();
  private operations = 0;
  private depth = 0;

  check(): void {
    if (++this.operations > MAX_OPERATIONS) throw new MarkdownParseError('complexity');
    if (performance.now() - this.startedAt >= MARKDOWN_PARSE_TIMEOUT_MS) throw new MarkdownParseError('timeout');
  }

  validateLines(lines: string[]): void {
    if (lines.length > MAX_LINES) throw new MarkdownParseError('size');
    let chars = 0;
    for (const line of lines) {
      this.check();
      chars += line.length + 1;
      if (chars > MAX_DOCUMENT_CHARS || line.length > MAX_INLINE_CHARS) throw new MarkdownParseError('size');
    }
  }

  validateInline(text: string): void {
    this.check();
    if (text.length > MAX_INLINE_CHARS) throw new MarkdownParseError('size');
  }

  nested<T>(build: () => T): T {
    this.check();
    if (this.depth >= MAX_DEPTH) throw new MarkdownParseError('depth');
    this.depth += 1;
    try {
      return build();
    } finally {
      this.depth -= 1;
    }
  }
}
