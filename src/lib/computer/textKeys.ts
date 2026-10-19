/** X11/Guacamole Unicode keysyms, iterating code points rather than UTF-16 units. */
export function* computerTextKeysyms(text: string): Generator<number> {
  for (const character of text.replace(/\r\n?/g, '\n')) {
    const code = character.codePointAt(0)!;
    yield character === '\n' ? 0xff0d : character === '\t' ? 0xff09 : code < 256 ? code : 0x01000000 | code;
  }
}
