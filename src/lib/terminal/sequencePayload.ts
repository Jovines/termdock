import { buildBracketedPastePayload } from './bracketedPaste';
import type { OwnedTerminalPaste } from './ownedPaste';

export interface TerminalSequenceOptions {
  consumeModifier?: boolean;
  paste?: boolean;
  submitAfterPaste?: boolean;
  targeted?: boolean;
  ownedPaste?: OwnedTerminalPaste;
}

export function terminalSequencePayload(seq: string, options?: TerminalSequenceOptions): string {
  if (options?.ownedPaste) return buildBracketedPastePayload(seq, false);
  if (options?.paste && /[\r\n]/.test(seq)) {
    return buildBracketedPastePayload(seq, options.submitAfterPaste ?? seq.endsWith('\r'));
  }
  return seq;
}
