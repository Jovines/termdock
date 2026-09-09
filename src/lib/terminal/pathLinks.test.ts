import { describe, expect, it, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { createTerminalPathLinkProvider, findTerminalPathMatches, resolveTerminalPath } from './pathLinks';

describe('terminal path links', () => {
  it('finds absolute, home, and relative directory paths in terminal prose', () => {
    const line = 'cwd=/home/qiao/project/src/, then ./docs/ or packages/client/src';
    expect(findTerminalPathMatches(line).map((match) => match.text)).toEqual([
      '/home/qiao/project/src/',
      './docs/',
      'packages/client/src',
    ]);
  });

  it('leaves web URLs to WebLinksAddon and ignores prose with isolated slashes', () => {
    const line = 'visit https://example.com/docs/ or choose yes/no';
    expect(findTerminalPathMatches(line)).toEqual([]);
  });

  it('keeps shell-escaped spaces and excludes trailing prose punctuation', () => {
    const line = 'directory: ./My\\ Folder/assets/, next';
    expect(findTerminalPathMatches(line)).toEqual([{
      text: './My\\ Folder/assets/',
      startIndex: 11,
      endIndex: 31,
    }]);
  });

  it('resolves relative, parent, absolute, and home paths from the session cwd', () => {
    expect(resolveTerminalPath('src/lib/', '/home/qiao/project')).toBe('/home/qiao/project/src/lib');
    expect(resolveTerminalPath('../shared/', '/home/qiao/project')).toBe('/home/qiao/shared');
    expect(resolveTerminalPath('/tmp/demo/', '/home/qiao/project')).toBe('/tmp/demo');
    expect(resolveTerminalPath('~/Downloads/', '/home/qiao/project')).toBe('/home/qiao/Downloads');
    expect(resolveTerminalPath('./My\\ Folder/', '/home/qiao/project')).toBe('/home/qiao/project/My Folder');
  });

  it('keeps a link range intact when a directory path wraps across buffer lines', () => {
    const makeLine = (text: string, isWrapped: boolean) => ({
      isWrapped,
      length: text.length,
      getCell: (column: number) => ({
        getWidth: () => 1,
        getChars: () => text[column] ?? '',
      }),
    });
    const lines = [
      makeLine('open /home/qiao/vscode/', false),
      makeLine('web-terminal/src/ now', true),
    ];
    const terminal = {
      buffer: { active: { length: lines.length, getLine: (index: number) => lines[index] } },
    } as unknown as Terminal;
    const activated = vi.fn();
    const provider = createTerminalPathLinkProvider(terminal, activated);

    provider.provideLinks(2, (links) => {
      expect(links).toHaveLength(1);
      expect(links?.[0]?.text).toBe('/home/qiao/vscode/web-terminal/src/');
      expect(links?.[0]?.range).toEqual({
        start: { x: 6, y: 1 },
        end: { x: 17, y: 2 },
      });
      links?.[0]?.activate({} as MouseEvent, links[0].text);
    });
    expect(activated).toHaveBeenCalledWith('/home/qiao/vscode/web-terminal/src/');
  });
});


describe('real terminal path layout', () => {
  async function linksFor(output: string, cols: number, row: number) {
    const terminal = new HeadlessTerminal({ cols, rows: 10, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    const activate = vi.fn();
    let result: import('@xterm/xterm').ILink[] | undefined;
    createTerminalPathLinkProvider(terminal as unknown as Terminal, activate)
      .provideLinks(row, (links) => { result = links; });
    terminal.dispose();
    return { links: result, activate };
  }

  it('excludes Chinese labels and punctuation while retaining Chinese filenames', async () => {
    const { links } = await linksFor('审查报告：/tmp/报告.html，完成', 80, 1);
    expect(links?.map(link => link.text)).toEqual(['/tmp/报告.html']);
    expect(links?.[0].range).toEqual({ start: { x: 11, y: 1 }, end: { x: 24, y: 1 } });
  });

  it('joins automatic wrapping from either row', async () => {
    for (const row of [1, 2]) {
      const { links } = await linksFor('报告：/tmp/Douyin_1788930589/report.md', 16, row);
      expect(links?.map(link => link.text)).toEqual(['/tmp/Douyin_1788930589/report.md']);
    }
  });

  it('joins a colored TUI path after CRLF and indentation from either row', async () => {
    for (const row of [1, 2]) {
      const { links, activate } = await linksFor('审查报告： /tmp/report.html | \x1b[36m/tmp/\r\n  Douyin_1788930589/report.md\x1b[0m', 36, row);
      expect(links?.map(link => link.text)).toEqual(['/tmp/report.html', '/tmp/Douyin_1788930589/report.md']);
      expect(links?.[1].range).toEqual({ start: { x: 31, y: 1 }, end: { x: 29, y: 2 } });
      links?.[1].activate({} as MouseEvent, links[1].text);
      expect(activate).toHaveBeenCalledWith('/tmp/Douyin_1788930589/report.md');
    }
  });

  it.each([
    '                          /tmp/\r\n  project/report.md',
    '\x1b[36m/tmp/\r\n  project/report.md',
    '                          \x1b[36m/tmp/\r\n  \x1b[31mproject/report.md',
    '                          \x1b[36m/tmp/\r\n  /other/report.md',
  ])('does not merge unrelated hard lines: %s', async (output) => {
    const { links } = await linksFor(output, 36, 1);
    expect(links?.map(link => link.text)).toEqual(['/tmp/']);
  });
});
