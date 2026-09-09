import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export const TERMINAL_DIRECTORY_OPEN_EVENT = 'termdock-open-terminal-directory';

export interface TerminalPathMatch {
  text: string;
  startIndex: number;
  endIndex: number;
}

// A token may contain shell-escaped spaces, but stops at punctuation that is
// normally used to wrap a path in prose/Markdown. URL-looking tokens are
// deliberately rejected so the existing WebLinksAddon remains authoritative.
const PATH_TOKEN_PATTERN = /(?:\\[ \t]|[^\s`"'<>|()[\]{}=,:;!?：，；！？。、“”‘’])+/gu;
const TRAILING_PROSE_PUNCTUATION = /[,;:!?]+$/u;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;

function looksLikePath(token: string): boolean {
  if (!token || token === '/' || URL_SCHEME_PATTERN.test(token) || token.startsWith('//')) return false;
  if (token.startsWith('/') || token.startsWith('~/') || token.startsWith('./') || token.startsWith('../')) {
    return true;
  }
  // A trailing slash makes even a single relative segment unambiguously a
  // directory. Otherwise require at least two path segments to avoid turning
  // ordinary command names and prose into links.
  return token.endsWith('/') || /^[^/:]+\/[^/:]+\/(?:[^/:]+\/?)+$/u.test(token);
}

export function findTerminalPathMatches(line: string): TerminalPathMatch[] {
  const matches: TerminalPathMatch[] = [];
  PATH_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN_PATTERN.exec(line)) !== null) {
    const original = match[0];
    const text = original.replace(TRAILING_PROSE_PUNCTUATION, '');
    if (!looksLikePath(text)) continue;
    matches.push({
      text,
      startIndex: match.index,
      endIndex: match.index + text.length,
    });
  }
  return matches;
}

function normalizeAbsolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function inferHomeDirectory(cwd: string): string | null {
  const match = cwd.match(/^\/(?:home|Users)\/[^/]+/u);
  return match?.[0] ?? null;
}

export function resolveTerminalPath(text: string, cwd: string | null | undefined): string | null {
  const unescaped = text.replace(/\\([ \t])/gu, '$1').replace(/\/+$/u, '') || '/';
  if (unescaped.startsWith('/')) return normalizeAbsolutePath(unescaped);
  if (unescaped === '~' || unescaped.startsWith('~/')) {
    const home = cwd ? inferHomeDirectory(cwd) : null;
    if (!home) return null;
    return normalizeAbsolutePath(`${home}/${unescaped.slice(2)}`);
  }
  if (!cwd?.startsWith('/')) return null;
  return normalizeAbsolutePath(`${cwd}/${unescaped}`);
}

// TUI renderers can wrap with CRLF and indentation instead of xterm's
// isWrapped flag. Only join a colored directory prefix to a same-colored
// relative path continuation near the right edge; ordinary output stays separate.
function hardWrapIndent(terminal: Terminal, index: number): number | null {
  const previous = terminal.buffer.active.getLine(index - 1);
  const next = terminal.buffer.active.getLine(index);
  if (!previous || !next || next.isWrapped) return null;
  const before = previous.translateToString(true);
  const after = next.translateToString(true);
  const tail = findTerminalPathMatches(before).at(-1);
  const continuation = after.match(/^( +)([^\s]+\/[^\s]+)/u);
  if (!tail || tail.endIndex !== before.length || !tail.text.endsWith('/') || !continuation
    || /^[~./]/u.test(continuation[2])) return null;
  let lastColumn = previous.length - 1;
  while (lastColumn >= 0 && !previous.getCell(lastColumn)?.getChars()) lastColumn -= 1;
  const indent = continuation[1].length;
  if (lastColumn < previous.length - Math.max(8, indent + 2)) return null;
  const left = previous.getCell(lastColumn);
  const right = next.getCell(indent);
  if (!left || !right || left.isFgDefault() || right.isFgDefault()
    || left.getFgColorMode() !== right.getFgColorMode()
    || left.getFgColor() !== right.getFgColor()) return null;
  return indent;
}

function readBufferLine(terminal: Terminal, bufferLineNumber: number): {
  text: string;
  startPositions: Array<{ x: number; y: number }>;
  endPositions: Array<{ x: number; y: number }>;
} | null {
  const buffer = terminal.buffer.active;
  let startLineIndex = bufferLineNumber - 1;
  if (!buffer.getLine(startLineIndex)) return null;
  while (startLineIndex > 0 && (buffer.getLine(startLineIndex)?.isWrapped || hardWrapIndent(terminal, startLineIndex) !== null)) {
    startLineIndex -= 1;
  }

  let endLineIndex = bufferLineNumber - 1;
  while (endLineIndex + 1 < buffer.length && (buffer.getLine(endLineIndex + 1)?.isWrapped || hardWrapIndent(terminal, endLineIndex + 1) !== null)) {
    endLineIndex += 1;
  }

  let text = '';
  const startPositions: Array<{ x: number; y: number }> = [];
  const endPositions: Array<{ x: number; y: number }> = [];
  for (let lineIndex = startLineIndex; lineIndex <= endLineIndex && text.length <= 2048; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) break;
    const indent = lineIndex > startLineIndex ? hardWrapIndent(terminal, lineIndex) ?? 0 : 0;
    let length = line.length;
    if (lineIndex < endLineIndex && hardWrapIndent(terminal, lineIndex + 1) !== null) {
      while (length > 0 && !(line.getCell(length - 1)?.getChars() || '').trim()) length -= 1;
    }
    for (let column = indent; column < length; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let index = 0; index < chars.length; index += 1) {
        startPositions.push({ x: column + 1, y: lineIndex + 1 });
        endPositions.push({ x: column + Math.max(1, cell.getWidth()), y: lineIndex + 1 });
      }
    }
  }

  const trimmedLength = text.trimEnd().length;
  return {
    text: text.slice(0, trimmedLength),
    startPositions: startPositions.slice(0, trimmedLength),
    endPositions: endPositions.slice(0, trimmedLength),
  };
}

export function createTerminalPathLinkProvider(
  terminal: Terminal,
  activate: (text: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = readBufferLine(terminal, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }
      const links: ILink[] = findTerminalPathMatches(line.text).map((match) => ({
        text: match.text,
        range: {
          start: line.startPositions[match.startIndex] ?? { x: match.startIndex + 1, y: bufferLineNumber },
          end: line.endPositions[match.endIndex - 1] ?? { x: match.endIndex, y: bufferLineNumber },
        },
        activate: () => activate(match.text),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
