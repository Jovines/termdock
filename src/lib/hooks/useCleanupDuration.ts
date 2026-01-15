import { useState, useEffect, useCallback, useRef } from 'react';
import type { CleanupDurationPreset, TerminalSettings } from '../terminal/types';

const SETTINGS_STORAGE_KEY = 'web-terminal-settings';
const DEFAULT_SETTINGS: TerminalSettings = {
  cleanupDuration: 5 * 60 * 1000,  // 默认5分钟
  cleanupDurationPreset: 'default',
};

// 预设时长选项的显示名称
export const CLEANUP_DURATION_LABELS: Record<CleanupDurationPreset | 'custom', string> = {
  'never': '永不清理',
  'default': '默认（5分钟）',
  '5min': '5分钟',
  '10min': '10分钟',
  '30min': '30分钟',
  '1hour': '1小时',
  '2hours': '2小时',
  '1day': '1天',
  'custom': '自定义',
};

// 预设时长选项的毫秒值
const PRESET_VALUES: Record<CleanupDurationPreset, number> = {
  'never': Infinity,
  'default': 5 * 60 * 1000,  // 默认5分钟（开发环境）
  '5min': 5 * 60 * 1000,
  '10min': 10 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '1hour': 60 * 60 * 1000,
  '2hours': 2 * 60 * 60 * 1000,
  '1day': 24 * 60 * 60 * 1000,
} as const;

interface UseCleanupDurationReturn {
  // 当前清理时长（毫秒），Infinity 表示永不清理
  cleanupDurationMs: number;
  // 当前设置的预设选项
  cleanupDurationPreset: CleanupDurationPreset | 'custom';
  // 自定义时长（毫秒），仅当 preset 为 'custom' 时有效
  customDurationMs: number | null;
  // 是否正在加载设置
  isLoading: boolean;
  // 设置清理时长（通过预设选项）
  setCleanupDurationPreset: (preset: CleanupDurationPreset | 'custom') => void;
  // 设置自定义清理时长（毫秒）
  setCustomDuration: (durationMs: number) => void;
  // 获取当前有效的清理时长（毫秒）
  getEffectiveDuration: () => number;
  // 重置为默认设置
  resetToDefault: () => void;
  // 获取人类可读的时长描述
  getDurationDescription: () => string;
}

export function useCleanupDuration(): UseCleanupDurationReturn {
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  // 从 localStorage 读取设置
  const loadSettings = useCallback(() => {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;

    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return {
          cleanupDuration: data.cleanupDuration ?? DEFAULT_SETTINGS.cleanupDuration,
          cleanupDurationPreset: data.cleanupDurationPreset ?? DEFAULT_SETTINGS.cleanupDurationPreset,
        };
      }
    } catch (error) {
      console.error('Failed to load settings from localStorage:', error);
    }

    return DEFAULT_SETTINGS;
  }, []);

  // 保存设置到 localStorage
  const persistSettings = useCallback((newSettings: TerminalSettings) => {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(newSettings));
    } catch (error) {
      console.error('Failed to save settings to localStorage:', error);
    }
  }, []);

  // 初始化时加载设置
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      const loadedSettings = loadSettings();
      setSettings(loadedSettings);
      setIsLoading(false);
    }
  }, [loadSettings]);

  // 计算当前清理时长（毫秒）
  const cleanupDurationMs = settings.cleanupDurationPreset === 'custom'
    ? settings.cleanupDuration
    : PRESET_VALUES[settings.cleanupDurationPreset as CleanupDurationPreset] ?? PRESET_VALUES['default'];

  // 自定义时长（毫秒）
  const customDurationMs = settings.cleanupDurationPreset === 'custom' ? settings.cleanupDuration : null;

  // 设置清理时长预设
  const setCleanupDurationPreset = useCallback((preset: CleanupDurationPreset | 'custom') => {
    const duration = preset === 'custom' 
      ? settings.cleanupDuration 
      : PRESET_VALUES[preset];
    
    const newSettings: TerminalSettings = {
      cleanupDuration: duration,
      cleanupDurationPreset: preset,
    };
    
    setSettings(newSettings);
    persistSettings(newSettings);
  }, [settings.cleanupDuration, persistSettings]);

  // 设置自定义清理时长
  const setCustomDuration = useCallback((durationMs: number) => {
    const newSettings: TerminalSettings = {
      cleanupDuration: durationMs,
      cleanupDurationPreset: 'custom',
    };
    
    setSettings(newSettings);
    persistSettings(newSettings);
  }, [persistSettings]);

  // 获取当前有效的清理时长（毫秒）
  const getEffectiveDuration = useCallback(() => {
    return cleanupDurationMs;
  }, [cleanupDurationMs]);

  // 重置为默认设置
  const resetToDefault = useCallback(() => {
    const defaultSettings = DEFAULT_SETTINGS;
    setSettings(defaultSettings);
    persistSettings(defaultSettings);
  }, [persistSettings]);

  // 获取人类可读的时长描述
  const getDurationDescription = useCallback(() => {
    if (settings.cleanupDurationPreset === 'never') {
      return '永不清理';
    }
    
    if (settings.cleanupDurationPreset === 'custom') {
      const minutes = Math.round(settings.cleanupDuration / 60000);
      if (minutes >= 60 * 24) {
        const days = Math.round(minutes / 60 / 24 * 10) / 10;
        return `${days}天`;
      }
      if (minutes >= 60) {
        const hours = Math.round(minutes / 60 * 10) / 10;
        return `${hours}小时`;
      }
      return `${minutes}分钟`;
    }
    
    return CLEANUP_DURATION_LABELS[settings.cleanupDurationPreset] || '默认';
  }, [settings]);

  return {
    cleanupDurationMs,
    cleanupDurationPreset: settings.cleanupDurationPreset,
    customDurationMs,
    isLoading,
    setCleanupDurationPreset,
    setCustomDuration,
    getEffectiveDuration,
    resetToDefault,
    getDurationDescription,
  };
}

// 导出预设值供外部使用
export { PRESET_VALUES };
