import { useState, useEffect, useCallback, useRef } from 'react';

const SETTINGS_STORAGE_KEY = 'termdock-settings';
const DEFAULT_DESKTOP_FONT_SIZE = 13;
const DEFAULT_MOBILE_FONT_SIZE = 10;
const DEFAULT_FONT_SIZE = DEFAULT_DESKTOP_FONT_SIZE;  // 桌面端默认字体大小（像素）
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

function getDefaultFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_DESKTOP_FONT_SIZE;

  const isMobileViewport = window.matchMedia('(max-width: 767px)').matches;
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  return isMobileViewport || isCoarsePointer ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE;
}

interface UseFontSizeReturn {
  fontSize: number;
  setFontSize: (size: number) => void;
  incrementFontSize: () => void;
  decrementFontSize: () => void;
  resetToDefault: () => void;
  isLoading: boolean;
}

export function useFontSize(): UseFontSizeReturn {
  const [fontSize, setFontSizeState] = useState<number>(getDefaultFontSize);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  // 从 localStorage 读取设置
  const loadSettings = useCallback(() => {
    if (typeof window === 'undefined') return getDefaultFontSize();

    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const size = data.fontSize;
        // 验证字体大小是否在有效范围内
        if (typeof size === 'number' && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) {
          return size;
        }
      }
    } catch (error) {
      console.error('Failed to load fontSize from localStorage:', error);
    }

    return getDefaultFontSize();
  }, []);

  // 保存设置到 localStorage
  const persistSettings = useCallback((newFontSize: number) => {
    if (typeof window === 'undefined') return;

    try {
      // 先读取现有设置
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const existingData = stored ? JSON.parse(stored) : {};
      
      // 更新字体大小
      const newData = { ...existingData, fontSize: newFontSize };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(newData));
    } catch (error) {
      console.error('Failed to save fontSize to localStorage:', error);
    }
  }, []);

  // 初始化时加载设置
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      const loadedFontSize = loadSettings();
      setFontSizeState(loadedFontSize);
      setIsLoading(false);
    }
  }, [loadSettings]);

  // 设置字体大小
  const setFontSize = useCallback((size: number) => {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
    setFontSizeState(clampedSize);
    persistSettings(clampedSize);
  }, [persistSettings]);

  // 增加字体大小
  const incrementFontSize = useCallback(() => {
    setFontSize(fontSize + 1);
  }, [fontSize, setFontSize]);

  // 减少字体大小
  const decrementFontSize = useCallback(() => {
    setFontSize(fontSize - 1);
  }, [fontSize, setFontSize]);

  // 重置为默认设置
  const resetToDefault = useCallback(() => {
    const defaultFontSize = getDefaultFontSize();
    setFontSizeState(defaultFontSize);
    persistSettings(defaultFontSize);
  }, [persistSettings]);

  return {
    fontSize,
    setFontSize,
    incrementFontSize,
    decrementFontSize,
    resetToDefault,
    isLoading,
  };
}

// 导出常量供外部使用
export { DEFAULT_FONT_SIZE, DEFAULT_DESKTOP_FONT_SIZE, DEFAULT_MOBILE_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE };
