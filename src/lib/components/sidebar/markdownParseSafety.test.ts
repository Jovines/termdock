import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { scanMarkdownInlineTokens } from './markdownInlineTokens';
import { MarkdownParseBudget, MarkdownParseError } from './markdownParseBudget';

const tokens = (text: string) => [...scanMarkdownInlineTokens(text, new MarkdownParseBudget())];
afterEach(() => vi.restoreAllMocks());

describe('bounded Markdown inline parsing', () => {
  it('finishes the original backtracking trigger in an externally timed process', () => {
    // A Vitest timeout cannot interrupt a synchronous regex. A separate process
    // makes a recurrence fail this test instead of wedging the test runner.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { scanMarkdownInlineTokens } from './src/lib/components/sidebar/markdownInlineTokens.ts';
      import { MarkdownParseBudget } from './src/lib/components/sidebar/markdownParseBudget.ts';
      const url = 'https://example.com/' + 'a'.repeat(100);
      for (const text of ['[x](' + url, 'search_id [x](' + url + '/table_value)']) {
        [...scanMarkdownInlineTokens(text, new MarkdownParseBudget())];
      }
      console.log('completed');
    `], { cwd: process.cwd(), timeout: 2_000, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('completed');
  });

  it('keeps intraword underscores literal, including Unicode words and strong delimiters', () => {
    expect(tokens('search_id table_name foo__bar__baz 中文_标识_字段')).toEqual([]);
    expect(tokens('_emphasis_ __strong__').map(({ token }) => token)).toEqual(['_emphasis_', '__strong__']);
  });

  it('does not split emphasis out of a URL in the reported lark document pattern', () => {
    const url = `https://example.com/${'a'.repeat(4_000)}/table_value`;
    const result = tokens(`search_id [x](${url})`);
    expect(result).toEqual([{ index: 10, token: `[x](${url})` }]);
  });

  it('returns promptly for a long link missing its closing parenthesis', () => {
    const url = `https://example.com/${'a'.repeat(8_000)}`;
    expect(tokens(`[x](${url}`).map(({ token }) => token)).toEqual(['[x]', url]);
  });

  it('preserves balanced URL parentheses, link titles, and images', () => {
    expect(tokens('[x](https://example.com/a(b)c "Title") ![alt](./file.png)').map(({ token }) => token))
      .toEqual(['[x](https://example.com/a(b)c "Title")', '![alt](./file.png)']);
  });

  it('handles unmatched long backtick runs without regex backtracking', () => {
    expect(tokens('`'.repeat(8_000) + 'unfinished')).toEqual([]);
    expect(tokens('``a ` b``').map(({ token }) => token)).toEqual(['``a ` b``']);
  });

  it('rejects oversized inputs before running regexes', () => {
    expect(() => tokens('[x](' + 'a'.repeat(20_000))).toThrow(MarkdownParseError);
  });

  it('checks the deadline between failed token candidates', () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time++);
    expect(() => tokens('a'.repeat(1_000))).toThrow('timeout');
  });

  it('limits recursion and restores the depth counter after a failure', () => {
    const budget = new MarkdownParseBudget();
    const recurse = (): void => budget.nested(recurse);
    expect(recurse).toThrow('depth');
    expect(budget.nested(() => 'ok')).toBe('ok');
  });
});
