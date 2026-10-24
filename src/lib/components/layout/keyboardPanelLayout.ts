import type { CSSProperties } from 'react';
import { usesNativeKeyboardLayout } from '../../hooks/nativeKeyboardLayout';

const rootStyle: CSSProperties = Object.freeze({
  transform: 'translateY(var(--kb-translate-y, 0px))',
  transition: 'none',
});
const contentStyle: CSSProperties = Object.freeze({
  marginTop: 'var(--kb-margin-top, 0px)',
  transition: 'none',
});
const mobile = Object.freeze({ rootStyle, contentStyle });
const desktop = Object.freeze({ rootStyle: undefined, contentStyle: undefined });
const native = Object.freeze({ rootStyle: undefined, contentStyle: Object.freeze({
  marginTop: 'var(--app-native-pan, 0px)', transition: 'none',
}) as CSSProperties });

/**
 * root = full-height flex column, content = min-h-0 flex-1,
 * footer = shrink-0 sibling after content. Keep navigation outside the root.
 * Consumes the app's viewport variables; never measures/listens to the keyboard.
 * An ancestor-owned layout must disable this on descendants to avoid doubling.
 * iOS has no authored root transform: native focus moves the input, while
 * content compensates for the measured page displacement. Other platforms
 * retain the paired height-based compatibility path.
 * See docs/soft-keyboard-adaptation.md for usage and the split-terminal exception.
 */
export function getKeyboardPanelStyles(enabled: boolean) {
  return enabled ? usesNativeKeyboardLayout() ? native : mobile : desktop;
}
