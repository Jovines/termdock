import React from 'react';
import { RiFolderLine, RiPaletteLine, RiTimerLine, RiInformationLine } from '@remixicon/react';
import type { CleanupDurationPreset } from '../../terminal/types';

interface MobileSettingsProps {
  defaultCwd: string;
  theme: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  cleanupDurationPreset: CleanupDurationPreset | 'custom';
  customDurationInput: string;
  showDebug: boolean;
  onCwdChange: (value: string) => void;
  onThemeChange: (value: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord') => void;
  onCleanupPresetChange: (value: CleanupDurationPreset | 'custom') => void;
  onCustomDurationChange: (value: string) => void;
  onCustomDurationBlur: () => void;
  onSetCustomDuration: (ms: number) => void;
  onToggleDebug: () => void;
}

export const MobileSettings: React.FC<MobileSettingsProps> = ({
  defaultCwd,
  theme,
  cleanupDurationPreset,
  customDurationInput,
  showDebug,
  onCwdChange,
  onThemeChange,
  onCleanupPresetChange,
  onCustomDurationChange,
  onCustomDurationBlur,
  onSetCustomDuration,
  onToggleDebug,
}) => {
  return (
    <div className="p-4 space-y-4">
      <div>
        <label htmlFor="mobile-cwd" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
          <RiFolderLine className="w-4 h-4" />
          Working Directory
        </label>
        <input
          id="mobile-cwd"
          type="text"
          value={defaultCwd}
          onChange={(e) => onCwdChange(e.target.value)}
          placeholder="/home"
          className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
      </div>

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
