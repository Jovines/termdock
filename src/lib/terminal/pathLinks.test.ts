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

  it('includes valid line/column suffixes in the clickable range but keeps the path clean', () => {
    expect(findTerminalPathMatches('/tmp/demo.kt:113:7: explanation')).toEqual([{
      text: '/tmp/demo.kt', startIndex: 0, endIndex: 18, line: 113,
    }]);
    for (const suffix of [':0', ':-1', ':1abc', ':9007199254740992']) {
      expect(findTerminalPathMatches(`/tmp/demo.kt${suffix}`)[0]).toEqual({
        text: '/tmp/demo.kt', startIndex: 0, endIndex: 12,
      });
    }
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

  it.each(['', '        '])('joins the screenshot path with painted trailing padding %j', async (padding) => {
    const prefix = '/Users/bytedance/.agents/logs/cf2a0e6e/';
    const suffix = 'ambient-always-display/logcat.log';
    for (const row of [1, 2]) {
      const { links, activate } = await linksFor(
        `- 完整日志： \x1b[36m${prefix}${padding}\r\n  ${suffix}\x1b[0m`, 60, row,
      );
      expect(links?.map(link => link.text)).toEqual([prefix + suffix]);
      expect(links?.[0].range).toEqual({ start: { x: 14, y: 1 }, end: { x: 35, y: 2 } });
      links?.[0].activate({} as MouseEvent, links[0].text);
      expect(activate).toHaveBeenCalledWith(prefix + suffix);
    }
  });

  it('joins a three-row relative path ending in a filename and line number', async () => {
    const parts = [
      'business_modules/Search/Search/search_impl/src/main/',
      'java/com/ss/android/ugc/aweme/helper/',
      'AmbientBackgroundHelper.kt',
    ];
    for (const row of [1, 2, 3]) {
      const { links, activate } = await linksFor(
        `  1. \x1b[36m${parts[0]}\r\n     ${parts[1]}\r\n     ${parts[2]}:662\x1b[0m 隐藏判断点：`, 60, row,
      );
      expect(links?.map(link => link.text)).toEqual([parts.join('')]);
      expect(links?.[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 35, y: 3 } });
      links?.[0].activate({} as MouseEvent, links[0].text);
      expect(activate).toHaveBeenCalledWith(parts.join(''), 662);
    }
  });

  it.each([':113:', ':113:7:', '：'])('joins unindented four-row paths with suffix %s', async (suffix) => {
    const parts = [
      'business_modules/Search/',
      'Search/search_impl/src/main/java/com/ss/android/ugc/aweme/',
      'helper/ambient/propertyholder/general/',
      'SearchButtonPropertyHolderBuilder.kt',
    ];
    for (const indent of ['', '  ']) {
      for (const row of [1, 2, 3, 4]) {
        const { links, activate } = await linksFor(
          `这个文件里其实已经有现成逻辑 \x1b[36m${parts.join(`\r\n${indent}`)}${suffix}\x1b[0m\r\nheaderContentType==1`, 60, row,
        );
        expect(links?.map(link => link.text)).toEqual([parts.join('')]);
        expect(links?.[0].range).toEqual({
          start: { x: 30, y: 1 },
          end: { x: indent.length + parts[3].length + (suffix === '：' ? 0 : suffix.length - 1), y: 4 },
        });
        links?.[0].activate({} as MouseEvent, links[0].text);
        if (suffix === '：') expect(activate).toHaveBeenCalledWith(parts.join(''));
        else expect(activate).toHaveBeenCalledWith(parts.join(''), 113);
      }
    }
  });

  it('does not use following prose to decide whether a short filename wrapped', async () => {
    const { links } = await linksFor(
      '\x1b[36m/tmp/\r\n  a.kt\x1b[0m followed by a long explanatory sentence', 60, 1,
    );
    expect(links?.map(link => link.text)).toEqual(['/tmp/']);
  });

  it.each([
    '                          /tmp/\r\n  project/report.md',
    '                          \x1b[36m/tmp/\r\nordinary prose',
    '                          \x1b[36m/tmp/\r\n\x1b[31mreport.kt:113:',
    '                          \x1b[36m/tmp/\r\n/other/report.kt',
    '\x1b[36m/tmp/\r\nreport.kt:113:',
    '                          \x1b[36m/tmp/\r\n  ordinary prose',
    '                          \x1b[36m/tmp/\r\n  \x1b[31mreport.kt:662',
    '\x1b[36m/tmp/\r\n  project/report.md',
    '                          \x1b[36m/tmp/\r\n  \x1b[31mproject/report.md',
    '                          \x1b[36m/tmp/\r\n  /other/report.md',
  ])('does not merge unrelated hard lines: %s', async (output) => {
    const { links } = await linksFor(output, 36, 1);
    expect(links?.map(link => link.text)).toEqual(['/tmp/']);
  });
});
