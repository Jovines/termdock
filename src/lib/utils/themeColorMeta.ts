/**
 * Keep Safari's chrome tint (`theme-color` meta) in sync with the app theme.
 * The meta ships dark by default; without this, light-theme users get a dark
 * gray status/URL area above an otherwise paper-white app.
 */
export function syncThemeColorMeta(theme: 'dark' | 'light'): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'light' ? '#FFFCF0' : '#1C1B1A');
  }
}
