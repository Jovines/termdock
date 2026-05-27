import React from 'react';
import { createPortal } from 'react-dom';
import { RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine } from '@remixicon/react';
import { light as hapticLight } from 'browser-haptic';
import { splitButtonsIntoRows, type MobileToolbarAction, type ToolbarPresetMode, type ToolbarPresetOption } from './mobileKeyboardPresets';

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
type ExpandedItem =
  | { id: 'preset'; kind: 'preset' }
  | { id: 'alt'; kind: 'alt' }
  | { id: 'enter'; kind: 'key'; keyName: 'enter' }
  | { id: 'home'; kind: 'key'; keyName: 'home' }
  | { id: 'end'; kind: 'key'; keyName: 'end' }
  | { id: 'ctrl-c'; kind: 'key'; keyName: 'ctrl-c' }
  | { id: 'ctrl-d'; kind: 'key'; keyName: 'ctrl-d' }
  | { id: string; kind: 'text'; action: MobileToolbarAction };

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
  defaultShowExtended?: boolean;
  presetLabel: string;
  presetModeLabel: string;
  presetMode: ToolbarPresetMode;
  presetOptions: ToolbarPresetOption[];
  includeAlt: boolean;
  presetRowLayout: number[];
  extraActions: MobileToolbarAction[];
  onKeyPress: (key: MobileKey) => void;
  onTextPress: (sequence: string) => void;
  onModifierToggle: (modifier: Modifier) => void;
  onPresetSelect: (mode: ToolbarPresetMode) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onPressStart: () => void;
}

export const MobileKeyboard: React.FC<MobileKeyboardProps> = ({
  visible,
  activeModifier,
  lockedModifier,
  disabled,
  defaultShowExtended = false,
  presetLabel,
  presetModeLabel,
  presetMode,
  presetOptions,
  includeAlt,
  presetRowLayout,
  extraActions,
  onKeyPress,
  onTextPress,
  onModifierToggle,
  onPresetSelect,
  onExpandedChange,
  onPressStart,
}) => {
  const [showExtended, setShowExtended] = React.useState(defaultShowExtended);
  const [showPresetMenu, setShowPresetMenu] = React.useState(false);
  const [presetMenuPosition, setPresetMenuPosition] = React.useState<{ top: number; left: number } | null>(null);
  const toolbarDisabled = disabled || !visible;
  const presetButtonRef = React.useRef<HTMLButtonElement | null>(null);
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
        hapticLight();
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
    setShowExtended(defaultShowExtended);
  }, [defaultShowExtended]);

  React.useEffect(() => {
    onExpandedChange?.(showExtended);
  }, [onExpandedChange, showExtended]);

  React.useEffect(() => {
    if (toolbarDisabled) {
      stopKeyRepeat();
      setShowPresetMenu(false);
      setPresetMenuPosition(null);
    }
  }, [stopKeyRepeat, toolbarDisabled]);

  React.useEffect(() => {
    if (visible) {
      return;
    }
    setShowPresetMenu(false);
    setPresetMenuPosition(null);
  }, [visible]);

  React.useEffect(() => {
    if (!showPresetMenu) {
      return;
    }

    const updatePosition = () => {
      const rect = presetButtonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setPresetMenuPosition({
        left: Math.max(8, rect.left),
        top: Math.max(8, rect.top - 8),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showPresetMenu]);

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

  const handleTextPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, sequence: string) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      onTextPress(sequence);
    },
    [onPressStart, onTextPress, toolbarDisabled]
  );

  const handlePresetCyclePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      const rect = event.currentTarget.getBoundingClientRect();
      setPresetMenuPosition({
        left: Math.max(8, rect.left),
        top: Math.max(8, rect.top - 8),
      });
      setShowPresetMenu((current) => !current);
    },
    [onPressStart, toolbarDisabled]
  );

  const handlePresetOptionPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, mode: ToolbarPresetMode) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();
      setShowPresetMenu(false);
      setPresetMenuPosition(null);
      onPresetSelect(mode);
    },
    [onPressStart, onPresetSelect, toolbarDisabled]
  );

  const hasPresetActions = extraActions.length > 0;
  const expandedItems = React.useMemo(() => {
    const defaultItems: ExpandedItem[] = [
      { id: 'preset', kind: 'preset' },
    ];

    if (includeAlt) {
      defaultItems.push({ id: 'alt', kind: 'alt' });
    }

    if (hasPresetActions) {
      return defaultItems.concat(extraActions.map((action) => ({ id: action.id, kind: 'text' as const, action })));
    }

    return defaultItems.concat([
      { id: 'enter', kind: 'key', keyName: 'enter' as const },
      { id: 'home', kind: 'key', keyName: 'home' as const },
      { id: 'end', kind: 'key', keyName: 'end' as const },
      { id: 'ctrl-c', kind: 'key', keyName: 'ctrl-c' as const },
      { id: 'ctrl-d', kind: 'key', keyName: 'ctrl-d' as const },
    ]);
  }, [extraActions, hasPresetActions, includeAlt]);
  const expandedRows = React.useMemo(() => splitButtonsIntoRows(expandedItems, presetRowLayout), [expandedItems, presetRowLayout]);
  const presetMenu = showPresetMenu && presetMenuPosition
    ? createPortal(
      <div
        className="fixed z-[200] min-w-28 -translate-y-full rounded-2xl bg-surface-elevated p-1.5 shadow-xl border border-border/15"
        style={{ left: presetMenuPosition.left, top: presetMenuPosition.top }}
      >
        <div className="grid gap-1">
          {presetOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onPointerDown={(event) => handlePresetOptionPointerDown(event, option.id)}
              tabIndex={-1}
              disabled={toolbarDisabled}
              className={`h-7 rounded-full px-3 text-left text-xs font-medium transition-colors disabled:opacity-50 ${
                option.id === presetMode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-2 hover:bg-surface-elevated text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>,
      document.body
    )
    : null;

  return (
    <>
      {presetMenu}
      <div
        data-mobile-keyboard="true"
        className={`z-20 select-none overflow-hidden bg-background transition-all duration-150 ease-out ${
          visible
            ? 'max-h-40 px-3 py-2 opacity-100 translate-y-0 pointer-events-auto'
            : 'max-h-0 border-t-0 px-3 py-0 opacity-0 translate-y-1 pointer-events-none'
        }`}
        onMouseDownCapture={preventToolbarButtonFocus}
        onPointerDownCapture={preventToolbarButtonFocus}
        onContextMenuCapture={preventContextMenu}
        onFocusCapture={handleToolbarButtonFocus}
      >
      <div className="rounded-2xl bg-surface-elevated p-1.5 space-y-1">
      <div className="grid grid-cols-8 gap-1">
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'esc')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          Esc
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'tab')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          Tab
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleModifierPointerDown(event, 'ctrl')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className={`h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs disabled:opacity-50 flex items-center justify-center ${
            activeModifier === 'ctrl' ? 'bg-primary text-primary-foreground' : ''
          } ${
            lockedModifier === 'ctrl' ? 'ring-2 ring-accent' : ''
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
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
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
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
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
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
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
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowRightLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={handleToggleExtendedPointerDown}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          {showExtended ? 'Less' : 'More'}
        </button>
      </div>

      {showExtended && (
        <div className="mt-1 space-y-1">
          {expandedRows.map((row: { columns: number; items: ExpandedItem[] }, rowIndex: number) => (
            <div
              key={`row-${rowIndex}`}
              className="relative grid gap-1"
              style={{ gridTemplateColumns: `repeat(${Math.max(2, row.columns)}, minmax(0, 1fr))` }}
            >
              {row.items.map((item: ExpandedItem) => {
                if (item.kind === 'preset') {
                  return (
                    <button
                      key={item.id}
                      ref={item.id === 'preset' ? presetButtonRef : undefined}
                      type="button"
                      onPointerDown={handlePresetCyclePointerDown}
                      tabIndex={-1}
                      disabled={toolbarDisabled}
                      className="h-7 w-full rounded-full bg-surface-2 shadow-sm px-1 text-[10px] active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
                      title={presetModeLabel}
                    >
                      {presetLabel}
                    </button>
                  );
                }

                if (item.kind === 'alt') {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onPointerDown={(event) => handleModifierPointerDown(event, 'alt')}
                      tabIndex={-1}
                      disabled={toolbarDisabled}
                      className={`h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs disabled:opacity-50 flex items-center justify-center ${
                        activeModifier === 'alt' ? 'bg-primary text-primary-foreground' : ''
                      } ${lockedModifier === 'alt' ? 'ring-2 ring-accent' : ''}`}
                    >
                      <span className="font-medium">{lockedModifier === 'alt' ? 'Alt*' : 'Alt'}</span>
                    </button>
                  );
                }

                if (item.kind === 'text') {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onPointerDown={(event) => handleTextPointerDown(event, item.action.sequence)}
                      tabIndex={-1}
                      disabled={toolbarDisabled}
                      className="h-7 w-full rounded-full bg-surface-2 shadow-sm px-1 text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
                    >
                      {item.action.label}
                    </button>
                  );
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    onPointerDown={(event) => handleSinglePointerDown(event, item.keyName)}
                    tabIndex={-1}
                    disabled={toolbarDisabled}
                    className={`h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 ${
                      item.keyName === 'enter' ? 'flex items-center justify-center' : ''
                    }`}
                  >
                    {item.keyName === 'enter' ? <RiArrowGoBackLine size={16} /> : item.keyName === 'ctrl-c' ? 'Ctrl-C' : item.keyName === 'ctrl-d' ? 'Ctrl-D' : item.keyName === 'home' ? 'Home' : 'End'}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      </div>
      </div>
    </>
  );
};
