import React from 'react';
import { RiMagicLine } from '@remixicon/react';
import type { ToolbarPresetMode } from './mobileKeyboardPresets';

export const PRESET_MODE_BUTTON_SIZE_PX = 28;

interface PresetModeButtonProps {
  mode: ToolbarPresetMode;
  presetLabel: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/**
 * The square mode-switch button shown in the first slot of the expanded
 * mobile toolbar. In Auto mode it renders a magic-wand icon; in manual
 * mode it renders the uppercased first character of the preset label.
 *
 * Keep this in sync with any visual variants used elsewhere (e.g. the
 * settings preview) so users see exactly what they'll get.
 */
export const PresetModeButton: React.FC<PresetModeButtonProps> = ({
  mode,
  presetLabel,
  title,
  ariaLabel,
  disabled,
  onPointerDown,
  buttonRef,
}) => {
  return (
    <button
      ref={buttonRef}
      type="button"
      onPointerDown={onPointerDown}
      tabIndex={-1}
      disabled={disabled}
      className="h-7 w-7 rounded-full bg-surface-2 shadow-sm text-[11px] font-medium active:bg-accent active:text-accent-foreground transition-all keyboard-button-active disabled:opacity-50 flex items-center justify-center"
      title={title}
      aria-label={ariaLabel ?? title}
    >
      {mode === 'auto' ? (
        <RiMagicLine size={14} />
      ) : (
        (presetLabel.charAt(0) || '?').toUpperCase()
      )}
    </button>
  );
};
