import { expect, it } from 'vitest';
import { computerInputEdit } from './inputEdit';
it.each([
  ['', 'hello', 0, 'hello'], ['hello', 'hello ', 0, ' '],
  ['teh', 'the', 2, 'he'], ['你好', '你好吗', 0, '吗'],
  ['🙂你', '🙂', 1, ''], ['a🙂', 'a', 1, ''], ['你好🙂', '你好🙂', 0, ''],
  ['hello world', 'hello phone', 5, 'phone'],
])('replays native editing from %s to %s', (previous, next, backspaces, text) => {
  expect(computerInputEdit(previous, next)).toEqual({ backspaces, text });
});
