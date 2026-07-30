const SAFE_ASCII_PATH_CHARACTER = /^[A-Za-z0-9_@%+=:,./-]$/;

/**
 * Encode an absolute Finder path as an unquoted shell word.
 *
 * Non-ASCII filename characters can be emitted directly; ASCII characters
 * with shell syntax meaning are escaped individually so the inserted text
 * remains readable and editable in the terminal.
 */
export function escapeShellPath(filePath: string): string {
  return Array.from(filePath, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0x7f || SAFE_ASCII_PATH_CHARACTER.test(character)) {
      return character;
    }
    return `\\${character}`;
  }).join('');
}
