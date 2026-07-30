export function appendContextDraft(current: string, addition: string): string {
  const chunk = addition.trim();
  if (!chunk) return current;
  if (!current.trim()) return chunk;
  const separator = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${chunk}`;
}

export function buildDraftTerminalPayload(draft: string, submit: boolean): string {
  const text = draft.trim();
  if (!text) return '';
  if (submit) return `${text}\r`;
  return /\s$/.test(draft) ? draft : `${text} `;
}
