import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, CornerDownLeft as RiArrowGoBackLine } from 'lucide-react';
import { light as hapticLight } from 'browser-haptic';
import { splitButtonsIntoRows, type MobileToolbarAction, type ToolbarPresetMode, type ToolbarPresetOption } from './mobileKeyboardPresets';
import { PRESET_MODE_BUTTON_SIZE_PX, PresetModeButton } from './PresetModeButton';

type Modifier = 'ctrl' | 'alt';
type MobileKey =
  | 'esc'
  | 'enter'
  | 'home'
  | 'end'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-w'
  | 'ctrl-u';

type ExpandedItem =
  | { id: 'preset'; kind: 'preset' }
  | { id: 'alt'; kind: 'alt' }
  | { id: 'home'; kind: 'key'; keyName: 'home' }
  | { id: 'end'; kind: 'key'; keyName: 'end' }
  | { id: 'ctrl-d'; kind: 'key'; keyName: 'ctrl-d' }
  | { id: string; kind: 'text'; action: MobileToolbarAction };

const BASE_KEY_SEQUENCES: Record<MobileKey, string> = {
  esc: '\u001b',
  enter: '\r',
  home: '\u001b[H',
  end: '\u001b[F',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'ctrl-w': '\u0017',
  'ctrl-u': '\u0015',
};

export function getSequenceForKey(key: MobileKey, _modifier: Modifier | null): string | null {
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
  const pendingTapRef = React.useRef<{
    actionId: string;
    timer: number;
  } | null>(null);

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

  React.useEffect(() => {
    setShowExtended(defaultShowExtended);
  }, [defaultShowExtended]);

  React.useEffect(() => {
    onExpandedChange?.(showExtended);
  }, [onExpandedChange, showExtended]);

  React.useEffect(() => {
    if (toolbarDisabled) {
      setShowPresetMenu(false);
      setPresetMenuPosition(null);
    }
  }, [toolbarDisabled]);

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

  const handleSinglePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, key: MobileKey) => {
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

  const DOUBLE_TAP_WINDOW_MS = 250;

  const clearPendingTap = React.useCallback(() => {
    if (pendingTapRef.current !== null) {
      window.clearTimeout(pendingTapRef.current.timer);
      pendingTapRef.current = null;
    }
  }, []);

  React.useEffect(() => () => {
    clearPendingTap();
  }, [clearPendingTap]);

  const handleTextPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, action: MobileToolbarAction) => {
      if (toolbarDisabled) {
        return;
      }
      event.preventDefault();
      onPressStart();

      if (!action.doubleTapSequence) {
        // No double-tap sequence: fire immediately (zero delay)
        onTextPress(action.sequence);
        return;
      }

      const pending = pendingTapRef.current;
      if (pending !== null && pending.actionId === action.id) {
        // Double tap detected: cancel pending single-tap, fire double-tap sequence
        window.clearTimeout(pending.timer);
        pendingTapRef.current = null;
        onTextPress(action.doubleTapSequence);
        return;
      }

      // First tap: start timer for single-tap, wait to see if double-tap follows
      clearPendingTap();
      const timer = window.setTimeout(() => {
        pendingTapRef.current = null;
        onTextPress(action.sequence);
      }, DOUBLE_TAP_WINDOW_MS);
      pendingTapRef.current = { actionId: action.id, timer };
    },
    [clearPendingTap, onPressStart, onTextPress, toolbarDisabled],
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
      { id: 'home', kind: 'key', keyName: 'home' as const },
      { id: 'end', kind: 'key', keyName: 'end' as const },
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
        className={`z-20 select-none overflow-hidden bg-background transition-all duration-150 ease-out max-h-40 px-1 py-0 ${
          visible
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
        onMouseDownCapture={preventToolbarButtonFocus}
        onPointerDownCapture={preventToolbarButtonFocus}
        onContextMenuCapture={preventContextMenu}
        onFocusCapture={handleToolbarButtonFocus}
      >
      <div className="rounded-2xl bg-surface-elevated p-0.5 space-y-0.5">
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
          onPointerDown={(event) => handleSinglePointerDown(event, 'enter')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          <RiArrowGoBackLine size={16} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleModifierPointerDown(event, 'ctrl')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className={`h-7 w-full rounded-full shadow-sm text-xs disabled:opacity-50 flex items-center justify-center transition-all ${
            activeModifier === 'ctrl'
              ? 'bg-primary text-primary-foreground scale-105 shadow-md shadow-primary/40'
              : 'bg-surface-2'
          } ${
            lockedModifier === 'ctrl' ? 'ring-2 ring-accent' : ''
          }`}
        >
          <span className="font-medium">{lockedModifier === 'ctrl' ? 'Ctrl*' : 'Ctrl'}</span>
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'ctrl-c')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          C-C
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'ctrl-w')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          C-W
        </button>
        <button
          type="button"
          onPointerDown={(event) => handleSinglePointerDown(event, 'ctrl-u')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          C-U
        </button>
        <button
          type="button"
          onPointerDown={() => onTextPress('/')}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
        >
          /
        </button>
        <button
          type="button"
          onPointerDown={handleToggleExtendedPointerDown}
          tabIndex={-1}
          disabled={toolbarDisabled}
          className="h-7 w-full rounded-full bg-surface-2 shadow-sm active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
        >
          {showExtended ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {showExtended && (
        <div className="mt-1 space-y-1">
          {expandedRows.map((row: { columns: number; items: ExpandedItem[] }, rowIndex: number) => {
            const hasPresetSlot = row.items[0]?.kind === 'preset';
            const baseCols = Math.max(2, row.columns);
            const gridTemplateColumns = hasPresetSlot
              ? `${PRESET_MODE_BUTTON_SIZE_PX}px repeat(${Math.max(1, baseCols - 1)}, minmax(0, 1fr))`
              : `repeat(${baseCols}, minmax(0, 1fr))`;
            return (
            <div
              key={`row-${rowIndex}`}
              className="relative grid gap-1"
              style={{ gridTemplateColumns }}
            >
              {row.items.map((item: ExpandedItem) => {
                if (item.kind === 'preset') {
                  return (
                    <PresetModeButton
                      key={item.id}
                      buttonRef={item.id === 'preset' ? presetButtonRef : undefined}
                      mode={presetMode}
                      presetLabel={presetLabel}
                      title={presetModeLabel}
                      disabled={toolbarDisabled}
                      onPointerDown={handlePresetCyclePointerDown}
                    />
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
                      className={`h-7 w-full rounded-full shadow-sm text-xs disabled:opacity-50 flex items-center justify-center transition-all ${
                        activeModifier === 'alt'
                          ? 'bg-primary text-primary-foreground scale-105 shadow-md shadow-primary/40'
                          : 'bg-surface-2'
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
                      onPointerDown={(event) => handleTextPointerDown(event, item.action)}
                      tabIndex={-1}
                      disabled={toolbarDisabled}
                      className="h-7 w-full rounded-full bg-surface-2 shadow-sm px-1 text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 relative"
                    >
                      {item.action.label}
                      {item.action.doubleTapSequence && (
                        <span className="absolute top-0.5 right-1.5 h-1 w-1 rounded-full bg-accent/60" />
                      )}
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
                    className="h-7 w-full rounded-full bg-surface-2 shadow-sm text-xs active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50"
                  >
                    {item.keyName === 'ctrl-d' ? 'Ctrl-D' : item.keyName === 'home' ? 'Home' : 'End'}
                  </button>
                );
              })}
            </div>
            );
          })}
        </div>
      )}
      </div>
      </div>
    </>
  );
};
