/** Retain the entire incomplete OSC, including a split ESC/ST terminator.
 * Hook prompt payloads can be much longer than a normal terminal title. */
export function incompleteOscSuffix(buffer: string, consumed: number, cap = 512 * 1024): string {
  const tail = buffer.slice(consumed);
  const start = tail.lastIndexOf('\x1b]');
  if (start >= 0 && tail.length - start <= cap) return tail.slice(start);
  return tail.endsWith('\x1b') ? '\x1b' : '';
}
