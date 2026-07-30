import { describe, expect, it } from 'vitest';
import { escapeShellPath } from './shellPath';

describe('escapeShellPath', () => {
  it('keeps ordinary absolute paths unquoted', () => {
    expect(escapeShellPath('/Users/alice/project/src')).toBe('/Users/alice/project/src');
  });

  it('escapes shell-significant characters individually', () => {
    expect(escapeShellPath('/Users/alice/My Folder/$draft (1).txt'))
      .toBe('/Users/alice/My\\ Folder/\\$draft\\ \\(1\\).txt');
  });

  it('keeps non-ASCII filenames readable', () => {
    expect(escapeShellPath('/Users/alice/桌面/终端 截图.png'))
      .toBe('/Users/alice/桌面/终端\\ 截图.png');
  });

  it('escapes quotes, glob characters, and backslashes', () => {
    expect(escapeShellPath('/tmp/a\'b"c*[x]\\d'))
      .toBe('/tmp/a\\\'b\\"c\\*\\[x\\]\\\\d');
  });
});
