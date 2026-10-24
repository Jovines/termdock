// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import { normalizeChatMarkdown } from './normalizeChatMarkdown';
import { Markdown } from '../markdown/Markdown';

afterEach(cleanup);

it('renders escaped paragraphs and list boundaries from existing replies as Markdown', async () => {
  const content = String.raw`已收到实际状态：\n\n- 排查：27 条反馈。\n- 执行：保留真实问题。\n\n继续跟进。`;
  const view = render(<ChatMarkdown content={content} />);
  await screen.findByText('继续跟进。');
  expect([...view.container.querySelectorAll('li')].map(item => item.textContent)).toEqual(['排查：27 条反馈。', '执行：保留真实问题。']);
  expect(view.container.textContent).not.toContain('\\n');
  view.rerender(<ChatMarkdown content="正常段落。\n\n- 原有列表" />);
  expect(await screen.findByText('原有列表')).toBeTruthy();
  expect(view.container.querySelectorAll('li')).toHaveLength(1);
});

it('handles CRLF escapes, mixed real newlines, numbered lists, headings and quotes', () => {
  expect(normalizeChatMarkdown('状态：\\r\\n\\r\\n1. 第一项\\r\\n2. 第二项\n\n补充：\\n## 标题\\n> 引用'))
    .toBe('状态：\n\n1. 第一项\n2. 第二项\n\n补充：\n## 标题\n> 引用');
});

it.each([
  '`\\n\\n- literal`',
  '``包含 ` 和 \\n\\n- literal``',
  '```js\nconst value = "\\n\\n- literal";\n```',
  '~~~text\n\\n\\n- literal\n~~~',
  '    indented \\n\\n- literal',
  '<pre>\\n\\n- literal</pre>',
  '<code>\\n\\n- literal</code>',
  '<span title="\\n\\n- literal">原文</span>',
  '[链接](https://example.com/\\n\\n?q=1)',
  'https://example.com/\\n\\n',
  'C:\\new\\notes.txt',
  '\\\\nas\\new\\notes.txt',
  '"\\n\\n- literal"',
  '$$x\\n\\n- y$$',
  '/\\n\\n/g',
  '正则 \\n、\\t 和 \\u4e2d 保持原样。',
  String.raw`双重反斜杠 \\n\\n- literal`,
])('preserves technical content while repairing surrounding prose: %s', literal => {
  const content = `说明：\\n\\n${literal}\n\n结论：\\n\\n完成。`;
  expect(normalizeChatMarkdown(content)).toBe(`说明：\n\n${literal}\n\n结论：\n\n完成。`);
});

it('leaves an unfinished code fence intact through the end of the reply', () => {
  expect(normalizeChatMarkdown('说明：\\n\\n```text\n字面换行 \\n\\n- literal\n后续 \\n\\n内容'))
    .toBe('说明：\n\n```text\n字面换行 \\n\\n- literal\n后续 \\n\\n内容');
});

it('does not reinterpret escapes in file previews or other shared Markdown consumers', async () => {
  const content = String.raw`字面量\n\n- 原文`;
  const view = render(<Markdown content={content} />);
  await screen.findByText(content);
  expect(view.container.querySelector('li')).toBeNull();
});

it('leaves ordinary Markdown unchanged and is idempotent', () => {
  const content = '第一段\n\n- 正常列表\n- 下一项\n\n```js\nconsole.log("\\n");\n```';
  expect(normalizeChatMarkdown(content)).toBe(content);
  const normalized = normalizeChatMarkdown(String.raw`正文\n\n- 一项\n- 下一项`);
  expect(normalizeChatMarkdown(normalized)).toBe(normalized);
});
