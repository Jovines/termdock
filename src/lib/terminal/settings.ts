import type { TerminalRendererMode } from './renderer';

export type TerminalUnicodeVersion = '6' | '11';
export type TerminalFontWeight = 'normal' | 'bold' | number;

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  rendererMode: TerminalRendererMode;
  fontWeight: TerminalFontWeight;
  fontWeightBold: TerminalFontWeight;
  letterSpacing: number;
  lineHeight: number;
  minimumContrastRatio: number;
  drawBoldTextInBrightColors: boolean;
  unicodeVersion: TerminalUnicodeVersion;
  customGlyphs: boolean;
  rescaleOverlappingGlyphs: boolean;
  fontLigatures: boolean;
  enableImages: boolean;
  smoothScrolling: boolean;
}

// This key is also read by the server-side config reconciler in settings.ts.
// Changing it requires a coordinated deploy — old clients would silently lose
// their font / renderer / theme preferences and fall back to defaults.
export const TERMINAL_SETTINGS_STORAGE_KEY = 'termdock-settings';

export const MIN_TERMINAL_FONT_SIZE = 6;
export const MAX_TERMINAL_FONT_SIZE = 100;

export const TERMINAL_LIGATURE_FEATURE_SETTINGS = '"calt" on';
export const TERMINAL_FALLBACK_LIGATURES = [
  '<--', '<---', '<<-', '<-', '->', '->>', '-->', '--->',
  '<==', '<===', '<<=', '<=', '=>', '=>>', '==>', '===>', '>=', '>>=',
  '<->', '<-->', '<--->', '<---->', '<=>', '<==>', '<===>', '<====>', '::', ':::',
  '<~~', '</', '</>', '/>', '~~>', '==', '!=', '/=', '~=', '<>', '===', '!==', '!==',
  '<:', ':=', '*=', '*+', '<*', '<*>', '*>', '<|', '<|>', '|>', '+*', '=*', '=:', ':>',
  '/*', '*/', '+++', '<!--', '<!---',
];

export function getDefaultTerminalFontSize(): number {
  if (typeof window === 'undefined') return 13;
  const isMobileViewport = window.matchMedia('(max-width: 767px)').matches;
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  return isMobileViewport || isCoarsePointer ? 10 : 13;
}

export function getDefaultTerminalSettings(): TerminalSettings {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: getDefaultTerminalFontSize(),
    rendererMode: 'auto',
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    letterSpacing: 1,
    lineHeight: 1.05,
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: true,
    unicodeVersion: '11',
    customGlyphs: true,
    rescaleOverlappingGlyphs: false,
    fontLigatures: true,
    enableImages: true,
    smoothScrolling: true,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function normalizeFontWeight(value: unknown, fallback: TerminalFontWeight): TerminalFontWeight {
  if (value === 'normal' || value === 'bold') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(1000, Math.round(value)));
  }
  return fallback;
}

export function normalizeTerminalSettings(value: unknown): TerminalSettings {
  const defaults = getDefaultTerminalSettings();
  const data = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const rendererMode = data.rendererMode ?? data.renderer;

  return {
    fontFamily: typeof data.fontFamily === 'string' && data.fontFamily.trim()
      ? data.fontFamily.trim()
      : defaults.fontFamily,
    fontSize: clampNumber(data.fontSize, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, defaults.fontSize),
    rendererMode: rendererMode === 'auto' || rendererMode === 'webgl' || rendererMode === 'canvas'
      ? rendererMode
      : defaults.rendererMode,
    fontWeight: normalizeFontWeight(data.fontWeight, defaults.fontWeight),
    fontWeightBold: normalizeFontWeight(data.fontWeightBold, defaults.fontWeightBold),
    letterSpacing: Math.round(clampNumber(data.letterSpacing, -5, 10, defaults.letterSpacing)),
    lineHeight: clampNumber(data.lineHeight, 1, 2, defaults.lineHeight),
    minimumContrastRatio: clampNumber(data.minimumContrastRatio, 1, 21, defaults.minimumContrastRatio),
    // Hidden advanced xterm capabilities are product defaults, not user-facing
    // preferences. Ignore stale localStorage booleans from earlier experimental
    // builds so "default on" actually takes effect for existing browsers.
    drawBoldTextInBrightColors: defaults.drawBoldTextInBrightColors,
    unicodeVersion: defaults.unicodeVersion,
    customGlyphs: defaults.customGlyphs,
    rescaleOverlappingGlyphs: defaults.rescaleOverlappingGlyphs,
    fontLigatures: defaults.fontLigatures,
    enableImages: defaults.enableImages,
    smoothScrolling: defaults.smoothScrolling,
  };
}
