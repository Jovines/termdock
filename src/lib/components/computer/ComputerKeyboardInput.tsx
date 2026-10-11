import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n';

export type ComputerInputKey = 'enter' | 'backspace' | 'delete' | 'tab' | 'up' | 'down' | 'left' | 'right';
// Some phone keyboards emit no deletion event for an empty field. Leave one
// invisible character to delete, and restore it after each remote operation.
const ANCHOR = '\u200b';
const specialKeys: Record<string, ComputerInputKey> = {
  Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Tab: 'tab',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

export default function ComputerKeyboardInput({ sendText, sendKey, inputRef, onFocusChange }: { sendText: (text: string) => void; sendKey: (key: ComputerInputKey) => void; inputRef?: RefObject<HTMLInputElement>; onFocusChange?: (focused: boolean) => void }) {
  const { t } = useI18n();
  const ownInput = useRef<HTMLInputElement>(null), composing = useRef(false), frame = useRef<number | null>(null);
  const input = inputRef ?? ownInput;
  const callbacks = useRef({ sendText, sendKey }); callbacks.current = { sendText, sendKey };
  const [hasText, setHasText] = useState(false);
  const reset = () => {
    if (input.current) { input.current.value = ANCHOR; input.current.setSelectionRange(1, 1); }
    setHasText(false);
  };
  const commit = () => {
    const value = (input.current?.value || '').replace(/^\u200b/, '');
    if (value) callbacks.current.sendText(value);
    reset();
  };
  const finishCommit = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    commit();
  };
  useLayoutEffect(() => {
    const field = input.current!;
    field.value = ANCHOR; field.setSelectionRange(1, 1); field.focus({ preventScroll: true });
    // React's synthetic beforeinput does not reliably expose mobile InputEvent
    // inputType. Listen to the native event for software Delete/Return keys.
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing) return;
      const key = event.inputType === 'deleteContentBackward' ? 'backspace'
        : event.inputType === 'deleteContentForward' ? 'delete'
        : ['insertLineBreak', 'insertParagraph'].includes(event.inputType) ? 'enter' : null;
      if (!key) return;
      event.preventDefault();
      // Phone IMEs may append a line-break event to selecting a candidate.
      // A physical Return is handled separately by keydown below.
      const candidateReturn = key === 'enter' && frame.current !== null;
      finishCommit();
      if (!candidateReturn) callbacks.current.sendKey(key);
    };
    field.addEventListener('beforeinput', beforeInput);
    return () => {
      field.removeEventListener('beforeinput', beforeInput);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
  return <div className="relative shrink-0 border-t border-border bg-surface px-3 py-2">
    {!hasText && <span aria-hidden="true" className="pointer-events-none absolute inset-y-2 left-6 flex items-center text-sm text-muted-foreground">{t('computer.keyboardPlaceholder')}</span>}
    <input ref={input} className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base outline-none focus:border-primary"
      aria-label={t('computer.keyboardInput')} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
      inputMode="text" enterKeyHint="enter" maxLength={1025} defaultValue={ANCHOR}
      onChange={event => {
        setHasText(Boolean(event.target.value.replace(/^\u200b/, '')));
        if (composing.current || (event.nativeEvent as InputEvent).isComposing || frame.current !== null) return;
        const native = event.nativeEvent as InputEvent;
        if (native.inputType === 'deleteContentBackward' && !event.target.value) {
          callbacks.current.sendKey('backspace'); reset();
        } else commit();
      }}
      onCompositionStart={() => { if (frame.current !== null) finishCommit(); composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => { frame.current = null; commit(); });
      }}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => { if (!composing.current && frame.current !== null) finishCommit(); onFocusChange?.(false); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const key = specialKeys[event.key];
        // Escape belongs to the enclosing panel, which closes only that layer.
        if (!key) return;
        event.preventDefault(); finishCommit(); callbacks.current.sendKey(key);
      }} />
  </div>;
}
