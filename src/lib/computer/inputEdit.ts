/** A phone IME edits a local suffix, including corrections to committed words.
 * Replay that edit at the remote caret without splitting Unicode characters. */
export function computerInputEdit(previous: string, next: string): { backspaces: number; text: string } {
  const before = Array.from(previous), after = Array.from(next);
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++;
  return { backspaces: before.length - shared, text: after.slice(shared).join('') };
}
