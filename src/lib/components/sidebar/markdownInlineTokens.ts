import { MarkdownParseBudget } from './markdownParseBudget';

// Sticky matching lets us check the deadline after every failed candidate,
// rather than letting an unanchored regex search a whole malformed line.
// Link destinations use disjoint alternatives, with exactly one character in
// the plain alternative. A missing ')' therefore cannot repartition a URL
// exponentially. Intraword underscores cannot open or close emphasis.
const TOKEN_PATTERN = /(\\\([^)]*\\\)|\$[^$\n]+\$|<br\s*\/?>|<\s*img\b[^>]*>|<\s*video\b[^>]*>[\s\S]*?<\/video\s*>|<(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)\b[\s\S]*?<\/(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)>|!?\[[^\]]*\]\((?:<[^>]+>|(?:[^\s()]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)|!?\[[^\]]+\]\[[^\]]*\]|!?\[[^\]]+\]|\[\^[^\]]+\]|~~[^~]+~~|\*\*[^*]+\*\*|(?<![\p{L}\p{N}_])__[^_]+__(?![\p{L}\p{N}_])|\*[^*\s][^*]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_])|<https?:\/\/[^>\s]+>|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|https?:\/\/[^\s<]+|www\.[^\s<]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)/iyu;

function codeSpanEnd(text: string, start: number, budget: MarkdownParseBudget): number | null {
  let openingEnd = start;
  while (text[openingEnd] === '`') openingEnd += 1;
  const width = openingEnd - start;
  let cursor = openingEnd;
  while (cursor < text.length) {
    budget.check();
    const next = text.indexOf('`', cursor);
    if (next < 0) return null;
    cursor = next;
    while (text[cursor] === '`') cursor += 1;
    if (cursor - next === width) return cursor;
  }
  return null;
}

export function* scanMarkdownInlineTokens(text: string, budget: MarkdownParseBudget): Generator<{ index: number; token: string }> {
  budget.validateInline(text);
  // Each recursive inline parse needs its own lastIndex.
  const pattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  let cursor = 0;
  while (cursor < text.length) {
    budget.check();
    if (text[cursor] === '`') {
      const end = codeSpanEnd(text, cursor, budget);
      if (end !== null) {
        yield { index: cursor, token: text.slice(cursor, end) };
        cursor = end;
      } else {
        // A delimiter run is indivisible; don't retry all its suffixes.
        while (text[cursor] === '`') cursor += 1;
      }
      continue;
    }
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    budget.check();
    if (match) {
      yield { index: cursor, token: match[0] };
      cursor = pattern.lastIndex;
    } else {
      cursor += (text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
    }
  }
}
