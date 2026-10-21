import { writeTerminalClipboardText } from './clipboardText';

const MAX_BYTES = 262144;

/** Let xterm frame OSC 52 across output chunks; only writes are supported. */
export function createOsc52ClipboardHandler(
  current: () => boolean,
  onFailure: () => void,
): (data: string) => boolean {
  return data => {
    if (!current()) return true;
    const separator = data.indexOf(';');
    if (separator < 0) return true;
    const payload = data.slice(separator + 1);
    // Queries must never disclose the client's existing clipboard to a program.
    if (!payload || payload === '?' || payload.length > 4 * Math.ceil(MAX_BYTES / 3)) return true;
    let text: string;
    try {
      const raw = atob(payload);
      if (raw.length > MAX_BYTES) return true;
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, ch => ch.charCodeAt(0)));
    } catch { return true; }
    if (text) {
      // Do not pause terminal parsing while the OS/browser handles clipboard IO.
      void writeTerminalClipboardText(text, current).then(copied => {
        if (!copied && current()) onFailure();
      });
    }
    return true;
  };
}
