import { afterEach, expect, it, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { ILink, Terminal } from '@xterm/xterm';
import { createWrappedWebLinkProvider } from './wrappedWebLinks';

const terminals: HeadlessTerminal[] = [];
afterEach(() => terminals.splice(0).forEach(terminal => terminal.dispose()));
async function fixture(output: string, cols = 52) {
  const terminal = new HeadlessTerminal({ cols, rows: 20, allowProposedApi: true });
  terminals.push(terminal);
  await new Promise<void>(resolve => terminal.write(output, resolve));
  const activate = vi.fn();
  const provider = createWrappedWebLinkProvider(terminal as unknown as Terminal, activate);
  const links = (row: number) => {
    let result: ILink[] | undefined;
    provider.provideLinks(row, value => { result = value; });
    return result;
  };
  return { terminal, links, activate };
}
const host = 'bytedance.larkoffice.com/docx/';
const id = 'Plp6dxMTQoj2iXxjocccIKf7nJf';
const url = `https://${host}${id}`;

it.each(['', ' '])('joins the screenshot three-row URL with trailing padding %j and opens its full target from every row', async padding => {
  const { links, activate } = await fixture(`• 已转成 飞书文档：尾部固定筛选配置清单 (\x1b[34mhttps://${padding}\r\n  ${host}${padding}\r\n  ${id}\x1b[0m)。`);
  for (const row of [1, 2, 3]) {
    expect(links(row)?.map(link => link.text)).toEqual([url]);
    expect(links(row)?.[0].range.end).toEqual({ x: 2 + id.length, y: 3 });
    links(row)![0].activate({} as MouseEvent, links(row)![0].text);
  }
  expect(activate.mock.calls.map(call => call[1])).toEqual([url, url, url]);
  expect(links(4)).toBeUndefined();
});

it('maps Chinese and combining/wide characters before a wrapped link to buffer cells', async () => {
  const { links } = await fixture(`说明： e\u0301 \x1b[34mhttps://example.test/\r\n  documents/unique-document-id\x1b[0m`, 32);
  expect(links(2)?.[0].range).toEqual({ start: { x: 10, y: 1 }, end: { x: 30, y: 2 } });
  expect(links(2)?.[0].text).toBe('https://example.test/documents/unique-document-id');
});

it('joins soft wrapping at arbitrary positions and preserves query/fragment punctuation', async () => {
  const complete = 'https://example.test/documents/abc?token=a%20b&view=full#section-2';
  const { terminal, links } = await fixture(complete, 20);
  expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
  for (const row of [1, 2, 3, 4]) expect(links(row)?.[0].text).toBe(complete);
});

it('does not remove real whitespace between a soft-wrapped URL and following prose', async () => {
  const complete = 'https://example.test/';
  const { links } = await fixture(`${complete} unrelated explanatory text`, complete.length);
  expect(links(1)).toBeUndefined();
  expect(links(2)).toBeUndefined();
});

it('preserves dots and query separators at hard wrap boundaries, excluding closing prose punctuation', async () => {
  const { links } = await fixture(`              (\x1b[34mhttps://example.\r\n  test/documents/abc?\r\n  token=secret&view=full#part-2\x1b[0m).`, 36);
  expect(links(3)?.[0].text).toBe('https://example.test/documents/abc?token=secret&view=full#part-2');
});

it.each([
  'https://example.test/docs/\r\n  unrelated explanatory text',
  '\x1b[34mhttps://example.test/docs/\x1b[0m\r\n  another-document-id',
  '\x1b[34mhttps://example.test/docs/\r\n  \x1b[31manother-document-id',
  '\x1b[34mhttps://example.test/docs/\r\n  https://other.test/document',
  '\x1b[34mhttps://example.test/docs/\r\n  explanation follows here',
  '\x1b[34mhttps://example.test/\r\n  short.txt',
])('leaves unrelated or ambiguous hard lines to the standard provider: %j', async output => {
  const { links } = await fixture(output, 80);
  expect(links(1)).toBeUndefined();
  expect(links(2)).toBeUndefined();
});

it('keeps unrelated URLs on the same row separate', async () => {
  const { links } = await fixture(`https://other.test/ first (\x1b[34mhttps://${host}\r\n  ${id}\x1b[0m)`, 80);
  expect(links(1)?.map(link => link.text)).toEqual([url]);
});

it('bounds hard-wrap lookups and rejects missing or incomplete destinations', async () => {
  const { links } = await fixture('nothing here\r\n\x1b[34mhttps://\r\n  /invalid', 12);
  expect(links(1)).toBeUndefined();
  expect(links(3)).toBeUndefined();
  expect(links(500)).toBeUndefined();
});
