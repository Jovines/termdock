import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n';
import type { ComputerKey } from '../../computer/platform';
import { computerInputEdit } from '../../computer/inputEdit';

export type ComputerInputKey = 'enter' | 'backspace' | 'delete' | 'tab' | 'up' | 'down' | 'left' | 'right';
// Some phone keyboards emit no deletion event for an empty field. Leave one
// invisible character to delete, and restore it after each remote operation.
const ANCHOR = '\u200b';
const specialKeys: Record<string, ComputerInputKey> = {
  Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Tab: 'tab',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

interface KeyboardInputProps {
  sendText: (text: string) => void;
  sendKey: (key: ComputerInputKey) => void;
  sendChord?: (keys: ComputerKey[]) => void;
  pasteText?: (text: string) => void;
  commandKey?: ComputerKey;
  inputRef?: RefObject<HTMLInputElement>;
  onFocusChange?: (focused: boolean) => void;
}
export default function ComputerKeyboardInput({ sendText, sendKey, sendChord, pasteText, commandKey = [0xffeb, 'MetaLeft'], inputRef, onFocusChange }: KeyboardInputProps) {
  const { t } = useI18n();
  const ownInput = useRef<HTMLInputElement>(null), composing = useRef(false);
  const input = inputRef ?? ownInput;
  const callbacks = useRef({ sendText, sendKey }); callbacks.current = { sendText, sendKey };
  const confirmed = useRef(''), candidateReturn = useRef(false);
  const candidateTimer = useRef<ReturnType<typeof setTimeout>>();
  const [hasText, setHasText] = useState(false);
  const value = () => (input.current?.value || '').replace(/^\u200b/, '');
  const retain = (text: string) => {
    // A small native editing context lets phone keyboards correct words and
    // delete repeatedly. Keep the remote caret at the end of this local suffix.
    confirmed.current = Array.from(text).slice(-256).join('');
    if (input.current) {
      input.current.value = ANCHOR + confirmed.current;
      const end = input.current.value.length; input.current.setSelectionRange(end, end);
    }
    setHasText(Boolean(confirmed.current));
  };
  const reset = () => retain('');
  const commit = () => {
    if (composing.current) return;
    const next = value(), edit = computerInputEdit(confirmed.current, next);
    // Update before callbacks: a remote command may synchronously rerender.
    retain(next);
    for (let i = 0; i < edit.backspaces; i++) callbacks.current.sendKey('backspace');
    if (edit.text) callbacks.current.sendText(edit.text);
  };
  const finishCommit = () => { if (!composing.current) commit(); };
  const special = (key: ComputerInputKey) => {
    finishCommit();
    if (key === 'backspace') retain(Array.from(confirmed.current).slice(0, -1).join(''));
    else reset();
    callbacks.current.sendKey(key);
  };
  useLayoutEffect(() => {
    const field = input.current!;
    field.value = ANCHOR; field.setSelectionRange(1, 1); field.focus({ preventScroll: true });
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing) return;
      const deletion = event.inputType === 'deleteContentBackward' ? 'backspace'
        : event.inputType === 'deleteContentForward' ? 'delete' : null;
      if (deletion) {
        // Let the native input edit real context. At its boundary, continue
        // deleting on the remote computer using the otherwise empty sentinel.
        if (deletion === 'backspace' && confirmed.current) return;
        event.preventDefault(); special(deletion); return;
      }
      if (['insertLineBreak', 'insertParagraph'].includes(event.inputType)) {
        event.preventDefault();
        if (!candidateReturn.current) special('enter');
        candidateReturn.current = false;
      }
    };
    const resetContext = () => { if (!composing.current) reset(); };
    field.addEventListener('beforeinput', beforeInput);
    field.addEventListener('termdock:computer-input-reset', resetContext);
    return () => {
      field.removeEventListener('beforeinput', beforeInput);
      field.removeEventListener('termdock:computer-input-reset', resetContext);
      clearTimeout(candidateTimer.current);
    };
  }, []);
  return <div className="relative shrink-0 border-t border-border bg-surface px-2 py-1">
    {!hasText && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-5 flex items-center truncate pr-5 text-sm text-muted-foreground">{t('computer.keyboardPlaceholder')}</span>}
    <input ref={input} className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base outline-none focus:border-primary"
      aria-label={t('computer.keyboardInput')} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
      inputMode="text" enterKeyHint="enter" maxLength={1025} defaultValue={ANCHOR}
      onPaste={event => {
        if (composing.current || !event.clipboardData.types.includes('text/plain')) return;
        event.preventDefault(); finishCommit(); reset();
        const text = event.clipboardData.getData('text/plain');
        if (pasteText) pasteText(text);
        else callbacks.current.sendText(text);
      }}
      onChange={event => {
        setHasText(Boolean(event.target.value.replace(/^\u200b/, '')));
        if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
        if ((event.nativeEvent as InputEvent).inputType === 'deleteContentBackward' && !confirmed.current && !event.target.value) special('backspace');
        else commit();
      }}
      onCompositionStart={() => { composing.current = true; candidateReturn.current = false; }}
      onCompositionEnd={() => {
        composing.current = false; commit();
        // Some IMEs append Return while confirming a candidate. This guard lasts
        // only through that event turn; it never delays the committed text.
        candidateReturn.current = true; clearTimeout(candidateTimer.current);
        candidateTimer.current = setTimeout(() => { candidateReturn.current = false; }, 0);
      }}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => { if (!composing.current) { finishCommit(); reset(); } onFocusChange?.(false); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        // A hardware keyboard may still be used while this mobile/IME field
        // owns focus. Preserve selection, word deletion and application shortcuts.
        // Native paste and AltGraph stay with the input's text/IME path.
        const modified = event.ctrlKey || event.altKey || event.metaKey;
        const nativePaste = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v';
        if (sendChord && !nativePaste && !event.getModifierState('AltGraph') && (modified || event.shiftKey)) {
          const keysyms: Record<string, number> = { Enter: 0xff0d, Backspace: 0xff08, Delete: 0xffff, Tab: 0xff09,
            ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56 };
          const keysym = keysyms[event.key] ?? (modified && event.key.length === 1 ? event.key.toLowerCase().codePointAt(0) : undefined);
          if (keysym !== undefined) {
            event.preventDefault(); finishCommit();
            const keys: ComputerKey[] = [];
            if (event.ctrlKey) keys.push([0xffe3, 'ControlLeft']);
            if (event.altKey) keys.push([0xffe9, 'AltLeft']);
            if (event.metaKey && !keys.some(([key]) => key === commandKey[0])) keys.push(commandKey);
            if (event.shiftKey) keys.push([0xffe1, 'ShiftLeft']);
            keys.push([keysym, event.code || event.key]); reset(); sendChord(keys); return;
          }
        }
        const key = specialKeys[event.key];
        // Escape belongs to the enclosing panel, which closes only that layer.
        if (!key) return;
        event.preventDefault(); special(key);
      }} />
  </div>;
}
