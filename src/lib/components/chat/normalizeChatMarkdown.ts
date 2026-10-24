// Recover clear paragraph/list boundaries from replies sent with literal escape
// sequences (for example, CLI text quoted by a shell). This is deliberately not
// a general unescape: a lone \\n can be part of a regex, command or path.
const escapedBoundary = /(?<!\\)(?:(?:\\r\\n|\\n){2,}|(?:\\r\\n|\\n)(?=[ \t]*(?:[-+*][ \t]|\d+[.)][ \t]|>[ \t]|#{1,6}[ \t])))/g;

// Technical content is opaque even when it contains an apparent boundary.
// Code delimiter runs are handled separately so fenced and inline code can
// contain arbitrary quotes, links and escape sequences.
const protectedContent = /(`+|~{3,})|(?:^|(?<=\n)|(?<=\\n))(?: {4}|\t)[^\n]*|<pre\b[^>]*>[\s\S]*?<\/pre\s*>|<code\b[^>]*>[\s\S]*?<\/code\s*>|<[^>\n]+>|\]\([^\n]*?\)|(?:https?:\/\/|www\.)[^\s<>]+|(?:[A-Za-z]:\\|\\\\)[^\s<>"']+|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/(?:\\.|[^/\\\n])+\/[dgimsuvy]*|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/gi;

function normalizeProse(text: string): string {
  return text.replace(escapedBoundary, boundary => boundary.replace(/\\r\\n|\\n/g, '\n'));
}

/** Display-only repair; stored messages and non-chat Markdown stay verbatim. */
export function normalizeChatMarkdown(content: string): string {
  if (!content.includes('\\n')) return content;
  const pattern = new RegExp(protectedContent.source, protectedContent.flags);
  const parts: string[] = [];
  let cursor = 0;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    parts.push(normalizeProse(content.slice(cursor, match.index)));
    let end = pattern.lastIndex;
    if (match[1]) {
      const delimiter = match[1];
      // An unfinished code span/fence is also left intact. Do not reinterpret
      // its contents while a reply is incomplete.
      let close = content.indexOf(delimiter, end);
      while (close !== -1 && (content[close - 1] === delimiter[0] || content[close + delimiter.length] === delimiter[0])) {
        close = content.indexOf(delimiter, close + delimiter.length);
      }
      end = close === -1 ? content.length : close + delimiter.length;
    }
    parts.push(content.slice(match.index, end));
    cursor = end;
    pattern.lastIndex = end;
  }
  parts.push(normalizeProse(content.slice(cursor)));
  return parts.join('');
}
