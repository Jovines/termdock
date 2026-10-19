import { expect, it } from 'vitest';
import { computerTextKeysyms } from './textKeys';
it('sends each Unicode code point once and treats Windows, Unix and classic Mac line endings consistently', () => {
  expect([...computerTextKeysyms('A你🙂\r\nB\rC\n\t')]).toEqual([65, 0x01004f60, 0x0101f642, 0xff0d, 66, 0xff0d, 67, 0xff0d, 0xff09]);
});
