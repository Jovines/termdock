import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';

/** A real editable field opens the phone keyboard; text/IME commits become
 * remote key events, without round-tripping through the remote clipboard. */
export default function ComputerKeyboardInput({ sendText, sendKey }: { sendText: (text: string) => void; sendKey: (key: 'enter' | 'backspace') => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null), composing = useRef(false), frame = useRef<number | null>(null);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const value = input.current?.value || '';
    if (value) sendText(value);
    if (input.current) input.current.value = '';
    setDraft('');
  };
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);
  // Keep a real, focusable input inside the viewport for Safari/IME. A hidden
  // input or display:none cannot open the keyboard. It occupies no layout space.
  return <input ref={input} tabIndex={-1} className="pointer-events-none absolute left-0 top-0 h-px w-px border-0 p-0 text-base opacity-0"
    aria-label={t('computer.keyboardInput')} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
    maxLength={1024} value={draft} onChange={event => { setDraft(event.target.value); if (!composing.current && frame.current === null) commit(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => {
      composing.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => { frame.current = null; commit(); });
    }} onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || frame.current !== null) return;
      if (event.key === 'Enter' || (event.key === 'Backspace' && !event.currentTarget.value)) {
        event.preventDefault(); sendKey(event.key === 'Enter' ? 'enter' : 'backspace');
      }
    }} />;
}
