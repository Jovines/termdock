import React from 'react';
import { RiPaletteLine, RiTimerLine, RiSettings4Line, RiCloseLine, RiAddLine, RiSubtractLine } from '@remixicon/react';
import type { CleanupDurationPreset } from '../../terminal/types';

interface DesktopSettingsProps {
  theme: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  cleanupDurationPreset: CleanupDurationPreset | 'custom';
  customDurationInput: string;
  fontSize: number;
  isMobileMenuOpen: boolean;
  onThemeChange: (value: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord') => void;
  onCleanupPresetChange: (value: CleanupDurationPreset | 'custom') => void;
  onCustomDurationChange: (value: string) => void;
  onCustomDurationBlur: () => void;
  onSetCustomDuration: (ms: number) => void;
  onFontSizeChange: (size: number) => void;
  onToggleMenu: () => void;
}

export const DesktopSettings: React.FC<DesktopSettingsProps> = ({
  theme,
  cleanupDurationPreset,
  customDurationInput,
  fontSize,
  isMobileMenuOpen,
  onThemeChange,
  onCleanupPresetChange,
  onCustomDurationChange,
  onCustomDurationBlur,
  onSetCustomDuration,
  onFontSizeChange,
  onToggleMenu,
}) => {
  return (
    <>
      <div className="hidden lg:flex items-center gap-3">
        <div className="relative group">
          <label htmlFor="desktop-theme" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
            Theme
          </label>
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
            <RiPaletteLine className="w-4 h-4 text-muted" />
            <select
              id="desktop-theme"
              value={theme}
              onChange={(e) => onThemeChange(e.target.value as any)}
              className="bg-transparent border-none outline-none appearance-none cursor-pointer"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="solarized">Solarized</option>
              <option value="dracula">Dracula</option>
              <option value="nord">Nord</option>
            </select>
          </div>
        </div>
        <div className="relative group">
          <label htmlFor="desktop-cleanup" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
            Cleanup
          </label>
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
            <RiTimerLine className="w-4 h-4 text-muted" />
            <select
              id="desktop-cleanup"
              value={cleanupDurationPreset}
              onChange={(e) => onCleanupPresetChange(e.target.value as any)}
              className="bg-transparent border-none outline-none appearance-none cursor-pointer min-w-[120px]"
            >
              <option value="never">永不清理</option>
              <option value="default">默认（5分钟）</option>
              <option value="5min">5分钟</option>
              <option value="10min">10分钟</option>
              <option value="30min">30分钟</option>
              <option value="1hour">1小时</option>
              <option value="2hours">2小时</option>
              <option value="1day">1天</option>
              <option value="custom">自定义</option>
            </select>
          </div>
        </div>
        {cleanupDurationPreset === 'custom' && (
          <div className="relative group">
            <label htmlFor="desktop-custom-cleanup" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
              Minutes
            </label>
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <input
                id="desktop-custom-cleanup"
                type="number"
                min="1"
                max="10080"
                value={customDurationInput}
                onChange={(e) => {
                  const value = e.target.value;
                  onCustomDurationChange(value);
                  const minutes = parseInt(value, 10);
                  if (!isNaN(minutes) && minutes > 0) {
                    onSetCustomDuration(minutes * 60 * 1000);
                  }
                }}
                onBlur={onCustomDurationBlur}
                placeholder="分钟数"
                className="bg-transparent border-none outline-none w-20"
              />
            </div>
          </div>
        )}
        <div className="relative group">
          <label htmlFor="desktop-fontsize" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
            Font Size
          </label>
          <div className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
            <button
              type="button"
              onClick={() => onFontSizeChange(fontSize - 1)}
              className="p-0.5 rounded hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={fontSize <= 8}
              aria-label="Decrease font size"
            >
              <RiSubtractLine className="w-3.5 h-3.5" />
            </button>
            <input
              id="desktop-fontsize"
              type="number"
              min="8"
              max="32"
              value={fontSize}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!isNaN(value)) {
                  onFontSizeChange(value);
                }
              }}
              className="bg-transparent border-none outline-none w-12 text-center [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              type="button"
              onClick={() => onFontSizeChange(fontSize + 1)}
              className="p-0.5 rounded hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={fontSize >= 32}
              aria-label="Increase font size"
            >
              <RiAddLine className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleMenu}
        className="hidden lg:flex p-2 -mr-2 rounded-lg hover:bg-surface-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-accent min-w-[44px] min-h-[44px] items-center justify-center"
        aria-label="Toggle settings menu"
        aria-expanded={isMobileMenuOpen}
      >
        {isMobileMenuOpen ? (
          <RiCloseLine className="w-5 h-5" />
        ) : (
          <RiSettings4Line className="w-5 h-5" />
        )}
      </button>
    </>
  );
};
