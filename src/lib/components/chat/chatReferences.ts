export interface ChatReference { author: string; time: string; text: string }
/** Ordinary quoted text remains readable to existing clients and to the Agent. */
export function composeChatContent(text: string, reference: ChatReference | null): string {
  if (!reference) return text.trim();
  return `> ${reference.author.replace(/[\r\n]/g, ' ')} · ${reference.time}\n${reference.text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}\n\n${text.trim()}`;
}
export function parseChatContent(content: string): { text: string; reference: ChatReference | null } {
  const lines = content.split('\n'), heading = lines[0].match(/^> (.+) · (\d{2}:\d{2})$/);
  if (!heading) return { text: content, reference: null };
  let end = 1;
  while (end < lines.length && lines[end].startsWith('>')) end++;
  if (end < 2 || lines[end] !== '') return { text: content, reference: null };
  return { text: lines.slice(end + 1).join('\n'), reference: { author: heading[1], time: heading[2], text: lines.slice(1, end).map(line => line.replace(/^> ?/, '')).join('\n') } };
}
