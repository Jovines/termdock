// iPadOS 27 can hide its top scroll-edge blur only when the status bar
// obscures the WebView. Run synchronously before installation/first paint;
// keep the existing edge-to-edge mode on iPhone and other platforms.
// The app CSP allows same-origin scripts, so this must be an external file.
if (/iPad/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content = 'default';
  document.documentElement.dataset.termdockPwaStatusBar = 'default';
  // Native status bars live outside the page. Keep actual env insets on old
  // installations, without adding a second fallback gap on new installs.
  document.documentElement.style.setProperty('--safe-top-inset', 'env(safe-area-inset-top, 0px)');
}
