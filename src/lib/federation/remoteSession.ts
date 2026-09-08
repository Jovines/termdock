/** Preserve existing origin-qualified collaboration IDs; verified service identity mapping lives in the access gate. */
export function remoteSessionAddress(value: string): { origin: string; sessionId: string } | null {
  if (!value.startsWith('remote:')) return null;
  const parts = value.slice('remote:'.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const origin = decodeURIComponent(parts[0]), sessionId = decodeURIComponent(parts[1]);
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || !sessionId) return null;
    return { origin, sessionId };
  } catch { return null; }
}
export async function openRemoteSession(value: string): Promise<void> {
  const address = remoteSessionAddress(value);
  if (!address) throw new Error('远端会话标识无效');
  if (window.termdockDesktop?.collaborationFocus) {
    try { if (await window.termdockDesktop.collaborationFocus(value)) return; } catch { /* fall through to verified service access */ }
  }
  window.dispatchEvent(new CustomEvent('termdock:open-remote-session', { detail: address }));
}
