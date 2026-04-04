import React from 'react';
import { RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine, RiCommandLine } from '@remixicon/react';

type Modifier = 'ctrl' | 'cmd';
type MobileKey =
  | 'esc'
  | 'tab'
  | 'enter'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right';

const BASE_KEY_SEQUENCES: Record<MobileKey, string> = {
  esc: '\u001b',
  tab: '\t',
  enter: '\r',
  'arrow-up': '\u001b[A',
  'arrow-down': '\u001b[B',
  'arrow-left': '\u001b[D',
  'arrow-right': '\u001b[C',
};

const MODIFIER_ARROW_SUFFIX: Record<Modifier, string> = {
  ctrl: '5',
  cmd: '3',
};

export function getSequenceForKey(key: MobileKey, modifier: Modifier | null): string | null {
  if (modifier) {
    switch (key) {
      case 'arrow-up':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}A`;
      case 'arrow-down':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}B`;
      case 'arrow-right':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}C`;
      case 'arrow-left':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}D`;
      default:
        break;
    }
  }

  return BASE_KEY_SEQUENCES[key] ?? null;
}

interface MobileKeyboardProps {
  keyboardHeight: number;
  isIOS: boolean;
  activeModifier: Modifier | null;
  disabled: boolean;
  onKeyPress: (key: MobileKey) => void;
  onModifierToggle: (modifier: Modifier) => void;
}

export const MobileKeyboard: React.FC<MobileKeyboardProps> = ({
  keyboardHeight,
  isIOS,
  activeModifier,
  disabled,
  onKeyPress,
  onModifierToggle,
}) => {
  if (keyboardHeight <= 0) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background px-3 py-2"
      style={{
        paddingBottom: isIOS ? 'env(safe-area-inset-bottom, 0px)' : undefined,
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onKeyPress('esc')}
          disabled={disabled}
          className="h-6 px-2 text-xs border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
        >
          Esc
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('tab')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowRightLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onModifierToggle('ctrl')}
          disabled={disabled}
          className={`h-6 w-9 p-0 border rounded disabled:opacity-50 flex items-center justify-center ${
            activeModifier === 'ctrl' ? 'bg-primary text-primary-foreground' : ''
          }`}
        >
          <span className="text-xs font-medium">Ctrl</span>
        </button>
        <button
          type="button"
          onClick={() => onModifierToggle('cmd')}
          disabled={disabled}
          className={`h-6 w-9 p-0 border rounded disabled:opacity-50 flex items-center justify-center ${
            activeModifier === 'cmd' ? 'bg-primary text-primary-foreground' : ''
          }`}
        >
          <RiCommandLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('arrow-up')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowUpLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('arrow-left')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowLeftLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('arrow-down')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowDownLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('arrow-right')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowRightLine size={16} />
        </button>
        <button
          type="button"
          onClick={() => onKeyPress('enter')}
          disabled={disabled}
          className="h-6 w-9 p-0 border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowGoBackLine size={16} />
        </button>
      </div>
    </div>
  );
};
