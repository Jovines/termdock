import React from 'react';
import { RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine } from '@remixicon/react';

type Modifier = 'ctrl' | 'alt';
type MobileKey =
  | 'esc'
  | 'tab'
  | 'enter'
  | 'home'
  | 'end'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right';

type RepeatableMobileKey = 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right';

const REPEAT_START_DELAY_MS = 280;
const REPEAT_INTERVAL_MS = 70;

const BASE_KEY_SEQUENCES: Record<MobileKey, string> = {
  esc: '\u001b',
  tab: '\t',
  enter: '\r',
  home: '\u001b[H',
  end: '\u001b[F',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'arrow-up': '\u001b[A',
  'arrow-down': '\u001b[B',
  'arrow-left': '\u001b[D',
  'arrow-right': '\u001b[C',
};

const MODIFIER_ARROW_SUFFIX: Record<Modifier, string> = {
  ctrl: '5',
  alt: '3',
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
  visible: boolean;
  activeModifier: Modifier | null;
  lockedModifier: Modifier | null;
  disabled: boolean;
  onKeyPress: (key: MobileKey) => void;
  onModifierToggle: (modifier: Modifier) => void;
  onPressStart: () => void;
}

export const MobileKeyboard: React.FC<MobileKeyboardProps> = ({
  visible,
  activeModifier,
  lockedModifier,
  disabled,
  onKeyPress,
  onModifierToggle,
  onPressStart,
}) => {
  const [showExtended, setShowExtended] = React.useState(false);
  const toolbarDisabled = disabled || !visible;
  const repeatStateRef = React.useRef<{
    key: RepeatableMobileKey | null;
    pointerId: number | null;
    delayTimer: number | null;
    intervalTimer: number | null;
  }>({
    key: null,
    pointerId: null,
    delayTimer: null,
    intervalTimer: null,
  });

  const preventToolbarButtonFocus = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) => {
      if (toolbarDisabled) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest('button')) {
        event.preventDefault();
        onPressStart();
      }
    },
    [onPressStart, toolbarDisabled]
  );

  const preventContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const handleToolbarButtonFocus = React.useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const target = event.target;
      if (toolbarDisabled) {
        return;
      }
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (!target.closest('button')) {
        return;
      }
      target.blur();
      onPressStart();
    },
    [onPressStart, toolbarDisabled]
  );

  const stopKeyRepeat = React.useCallback(() => {
    const state = repeatStateRef.current;
    if (state.delayTimer !== null) {
      window.clearTimeout(state.delayTimer);
      state.delayTimer = null;
    }
    if (state.intervalTimer !== null) {
      window.clearInterval(state.intervalTimer);
      state.intervalTimer = null;
    }
    state.key = null;
    state.pointerId = null;
  }, []);

  React.useEffect(() => () => {
    stopKeyRepeat();
  }, [stopKeyRepeat]);

  React.useEffect(() => {
    if (toolbarDisabled) {
      stopKeyRepeat();
    }
  }, [stopKeyRepeat, toolbarDisabled]);

  React.useEffect(() => {
    if (visible) {
      return;
    }
    setShowExtended(false);
  }, [visible]);

  const handleRepeatPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, key: RepeatableMobileKey) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();

      stopKeyRepeat();

      const state = repeatStateRef.current;
      state.key = key;
      state.pointerId = event.pointerId;

      onKeyPress(key);

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch { /* ignored */ }

      state.delayTimer = window.setTimeout(() => {
        const nextKey = repeatStateRef.current.key;
        if (!nextKey) {
          return;
        }
        repeatStateRef.current.intervalTimer = window.setInterval(() => {
          const currentKey = repeatStateRef.current.key;
          if (!currentKey || toolbarDisabled) {
            return;
          }
          onKeyPress(currentKey);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_START_DELAY_MS);
    },
    [onKeyPress, onPressStart, stopKeyRepeat, toolbarDisabled]
  );

  const handleRepeatPointerEnd = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = repeatStateRef.current;
      if (state.pointerId !== null && state.pointerId !== event.pointerId) {
        return;
      }
      const hasCapture = event.currentTarget.hasPointerCapture?.(event.pointerId) ?? false;
      if (hasCapture) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      stopKeyRepeat();
    },
    [stopKeyRepeat]
  );

  const handleSinglePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, key: Exclude<MobileKey, RepeatableMobileKey>) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      onKeyPress(key);
    },
    [onKeyPress, onPressStart, toolbarDisabled]
  );

  const handleModifierPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, modifier: Modifier) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      onModifierToggle(modifier);
    },
    [onModifierToggle, onPressStart, toolbarDisabled]
  );

  const handleToggleExtendedPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      setShowExtended((current) => !current);
    },
    [onPressStart, toolbarDisabled]
  );

  return (
    <div
      data-mobile-keyboard="true"
      className={`z-20 select-none overflow-hidden bg-background transition-all duration-150 ease-out ${
        visible
          ? 'max-h-40 border-t border-border px-3 py-2 opacity-100 translate-y-0 pointer-events-auto'
          : 'max-h-0 border-t-0 px-3 py-0 opacity-0 translate-y-1 pointer-events-none'
      }`}
      onMouseDownCapture={preventToolbarButtonFocus}
      onPointerDownCapture={preventToolbarButtonFocus}
      onContextMenuCapture={preventContextMenu}
      onFocusCapture={handleToolbarButtonFocus}
    >
      <div className="grid grid-cols-8 gap-1">
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'esc')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
        >
          Esc
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'tab')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
        >
          Tab
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleModifierPointerDown(event, 'ctrl')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className={`h-6 w-full border rounded text-xs disabled:opacity-50 flex items-center justify-center ${
            activeModifier === 'ctrl' ? 'bg-primary text-primary-foreground' : ''
          } ${
            lockedModifier === 'ctrl' ? 'ring-1 ring-primary' : ''
          }`}
        >
          <span className="font-medium">{lockedModifier === 'ctrl' ? 'Ctrl*' : 'Ctrl'}</span>
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleRepeatPointerDown(event, 'arrow-left')}
          onPointerUp={handleRepeatPointerEnd}
          onPointerCancel={handleRepeatPointerEnd}
          onPointerLeave={handleRepeatPointerEnd}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowLeftLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleRepeatPointerDown(event, 'arrow-up')}
          onPointerUp={handleRepeatPointerEnd}
          onPointerCancel={handleRepeatPointerEnd}
          onPointerLeave={handleRepeatPointerEnd}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowUpLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleRepeatPointerDown(event, 'arrow-down')}
          onPointerUp={handleRepeatPointerEnd}
          onPointerCancel={handleRepeatPointerEnd}
          onPointerLeave={handleRepeatPointerEnd}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowDownLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleRepeatPointerDown(event, 'arrow-right')}
          onPointerUp={handleRepeatPointerEnd}
          onPointerCancel={handleRepeatPointerEnd}
          onPointerLeave={handleRepeatPointerEnd}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowRightLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={handleToggleExtendedPointerDown}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
        >
          {showExtended ? 'Less' : 'More'}
        </button>
      </div>

      {showExtended && (
        <div className="mt-1 grid grid-cols-3 gap-1">
          <button
            type="button"
            onPointerDown={(event) => handleModifierPointerDown(event, 'alt')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className={`h-6 w-full border rounded text-xs disabled:opacity-50 flex items-center justify-center ${
              activeModifier === 'alt' ? 'bg-primary text-primary-foreground' : ''
            } ${
              lockedModifier === 'alt' ? 'ring-1 ring-primary' : ''
            }`}
          >
            <span className="font-medium">{lockedModifier === 'alt' ? 'Alt*' : 'Alt'}</span>
          </button>
          <button
            type="button"
            onPointerDown={(event) => handleSinglePointerDown(event, 'enter')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className="h-6 w-full border rounded active:bg-accent transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
          >
            <RiArrowGoBackLine size={16} />
          </button>
          <button
            type="button"
            onPointerDown={(event) => handleSinglePointerDown(event, 'home')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
          >
            Home
          </button>
          <button
            type="button"
            onPointerDown={(event) => handleSinglePointerDown(event, 'end')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
          >
            End
          </button>
          <button
            type="button"
            onPointerDown={(event) => handleSinglePointerDown(event, 'ctrl-c')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
          >
            Ctrl-C
          </button>
          <button
            type="button"
            onPointerDown={(event) => handleSinglePointerDown(event, 'ctrl-d')}
            tabIndex={-1}
            disabled={toolbarDisabled}
            className="h-6 w-full border rounded text-xs active:bg-accent transition-all keyboard-button-active disabled:opacity-50"
          >
            Ctrl-D
          </button>
        </div>
      )}
    </div>
  );
};
