import React from 'react';
import { RiPaletteLine, RiTimerLine, RiInformationLine, RiAddLine, RiSubtractLine } from '@remixicon/react';
import type { CleanupDurationPreset } from '../../terminal/types';

interface MobileSettingsProps {
  theme: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  cleanupDurationPreset: CleanupDurationPreset | 'custom';
  customDurationInput: string;
  fontSize: number;
  showDebug: boolean;
  onThemeChange: (value: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord') => void;
  onCleanupPresetChange: (value: CleanupDurationPreset | 'custom') => void;
  onCustomDurationChange: (value: string) => void;
  onCustomDurationBlur: () => void;
  onSetCustomDuration: (ms: number) => void;
  onFontSizeChange: (size: number) => void;
  onToggleDebug: () => void;
}

export const MobileSettings: React.FC<MobileSettingsProps> = ({
  theme,
  cleanupDurationPreset,
  customDurationInput,
  fontSize,
  showDebug,
  onThemeChange,
  onCleanupPresetChange,
  onCustomDurationChange,
  onCustomDurationBlur,
  onSetCustomDuration,
  onFontSizeChange,
  onToggleDebug,
}) => {
  return (
    <div className="p-4 space-y-4">
      <div>
        <label htmlFor="mobile-theme" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
          <RiPaletteLine className="w-4 h-4" />
          Theme
        </label>
        <select
          id="mobile-theme"
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as any)}
          className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="solarized">Solarized</option>
          <option value="dracula">Dracula</option>
          <option value="nord">Nord</option>
        </select>
      </div>

      <div>
        <label htmlFor="mobile-cleanup" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
          <RiTimerLine className="w-4 h-4" />
          断联清理时长
        </label>
        <select
          id="mobile-cleanup"
          value={cleanupDurationPreset}
          onChange={(e) => onCleanupPresetChange(e.target.value as any)}
          className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
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

      {cleanupDurationPreset === 'custom' && (
        <div>
          <label htmlFor="mobile-custom-cleanup" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
            <RiTimerLine className="w-4 h-4" />
            自定义时长（分钟）
          </label>
          <input
            id="mobile-custom-cleanup"
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
            placeholder="请输入分钟数"
            className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
          />
          <p className="text-xs text-muted mt-1">范围：1-10080 分钟（最多7天）</p>
        </div>
      )}

      <div>
        <label htmlFor="mobile-fontsize" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
          <span className="text-base">A</span>
          字体大小
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onFontSizeChange(fontSize - 1)}
            className="flex-1 flex items-center justify-center gap-1 px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={fontSize <= 8}
          >
            <RiSubtractLine className="w-5 h-5" />
            <span>减小</span>
          </button>
          <div className="flex-1 flex items-center justify-center px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px]">
            <input
              id="mobile-fontsize"
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
              className="bg-transparent border-none outline-none w-16 text-center text-lg font-medium [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-muted ml-1">px</span>
          </div>
          <button
            type="button"
            onClick={() => onFontSizeChange(fontSize + 1)}
            className="flex-1 flex items-center justify-center gap-1 px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={fontSize >= 32}
          >
            <RiAddLine className="w-5 h-5" />
            <span>增大</span>
          </button>
        </div>
        <p className="text-xs text-muted mt-1">范围：8-32 px</p>
      </div>

      <div className="pt-2 border-t border-border">
        <button
          type="button"
          onClick={onToggleDebug}
          className={`w-full flex items-center justify-between px-4 py-3 text-sm rounded-lg transition-colors ${
            showDebug ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-surface-elevated hover:bg-accent/50'
          }`}
        >
          <span className="flex items-center gap-2">
            <RiInformationLine className="w-4 h-4" />
            Debug Mode
          </span>
          <span className={`text-xs px-2 py-0.5 rounded ${showDebug ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}>
            {showDebug ? 'ON' : 'OFF'}
          </span>
        </button>
      </div>
    </div>
  );
};
