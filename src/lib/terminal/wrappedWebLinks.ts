import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

const MAX_ROWS = 8;
const MAX_LENGTH = 4096;
const URL_START = /https?:\/\/[^\s"'!*(){}|\\^<>`，。；！？、“”‘’]*/giu;
const CONTINUATION = /^( *)([^\s"'!*(){}|\\^<>`，。；！？、“”‘’]+)/u;
type Position = { x: number; y: number };

function readRow(terminal: Terminal, index: number) {
  const line = terminal.buffer.active.getLine(index);
  if (!line) return;
  let text = '';
  const starts: Position[] = [], ends: Position[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || !cell.getWidth()) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) {
      starts.push({ x: x + 1, y: index + 1 });
      ends.push({ x: x + cell.getWidth(), y: index + 1 });
    }
  }
  return { line, text: text.trimEnd(), starts, ends };
}

/** Supplement xterm's soft-wrap links with explicitly wrapped, styled TUI URLs. */
export function createWrappedWebLinkProvider(
  terminal: Terminal,
  activate: (event: MouseEvent, uri: string) => void = (_event, uri) => {
    window.open(uri, '_blank', 'noopener');
  },
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const first = Math.max(0, y - MAX_ROWS);
      const last = Math.min(terminal.buffer.active.length - 1, y + MAX_ROWS - 1);
      const rows = Array.from({ length: last - first + 1 }, (_, i) => readRow(terminal, first + i));
      const links: ILink[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        // Use a local regex because extension scans must not change iteration.
        for (const match of row.text.matchAll(new RegExp(URL_START))) {
          let text = match[0];
          const positions = row.ends.slice(match.index!, match.index! + text.length);
          let endIndex = match.index! + text.length;
          let current = row;
          let endRow = i;
          while (endIndex === current.text.length && endRow + 1 < rows.length
            && endRow - i < MAX_ROWS - 1 && text.length < MAX_LENGTH) {
            const next = rows[endRow + 1];
            const continuation = next?.text.match(CONTINUATION);
            if (!next || !continuation || /^https?:\/\//iu.test(continuation[2])) break;
            const indent = continuation[1].length, token = continuation[2];
            // Spaces on a true soft wrap belong to the output, not TUI padding.
            if (next.line.isWrapped && indent > 0) break;
            if (!next.line.isWrapped) {
              // Hard line breaks are ambiguous. Require matching non-default
              // link color and insufficient room for the next wrapped segment.
              const leftX = positions.at(-1)!.x - 1;
              const rightX = next.starts[indent]?.x;
              if (rightX === undefined) break;
              const left = current.line.getCell(leftX), right = next.line.getCell(rightX - 1);
              const tokenWidth = next.ends[indent + token.length - 1].x - rightX + 1;
              const gap = current.line.length - leftX - 1;
              if (!left || !right || left.isFgDefault() || right.isFgDefault()
                || left.getFgColorMode() !== right.getFgColorMode() || left.getFgColor() !== right.getFgColor()
                || gap >= Math.max(8, indent + tokenWidth)) break;
              // A short standalone word followed by prose is not a URL suffix.
              if (!/[/.?#%&=_~\-\d]/u.test(token) && token.length < 16
                && !/^[)\]}]/u.test(next.text.slice(indent + token.length))) break;
            }
            text += token;
            positions.push(...next.ends.slice(indent, indent + token.length));
            endIndex = indent + token.length;
            current = next;
            endRow++;
          }
          if (endRow === i || y < first + i + 1 || y > first + endRow + 1 || text.length > MAX_LENGTH) continue;
          // Prose punctuation is stripped only after all rows are joined: a
          // period or question mark at a wrap boundary can belong to the URL.
          text = text.replace(/[,:.!?]+$/u, '');
          while (text.endsWith(']') && (text.match(/\]/g)?.length ?? 0) > (text.match(/\[/g)?.length ?? 0)) text = text.slice(0, -1);
          if (!/^https?:\/\/[^/?#]+/iu.test(text)) continue;
          try {
            const url = new URL(text);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
          } catch { continue; }
          links.push({ text, range: { start: row.starts[match.index!], end: positions[text.length - 1] }, activate });
        }
      }
      callback(links.length ? links : undefined);
    },
  };
}
