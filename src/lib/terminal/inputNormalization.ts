/** Shared legacy textarea/native clipboard cleaning. It never adds Enter or
 * bracketed-paste delimiters; the owned page sequence path encodes those once. */
export function sanitizeTerminalInput(input:string):string {
  return input.replace(/\r\n|\r|\n/g,'\r')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g,' ')
    .replace(/[\u200B-\u200D\uFEFF]/g,'');
}
