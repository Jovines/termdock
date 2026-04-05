# Mobile Keyboard Toolbar Positioning

This note captures the root cause and final fix for mobile soft-keyboard toolbar placement in the terminal view.

## Problem Observed

- Toolbar was visible when keyboard opened, but position was wrong.
- In one iteration, toolbar stayed at screen bottom (`fixed bottom-0`), not aligned with the visible terminal area.
- In another iteration, toolbar was over terminal content (`absolute bottom-0`), causing overlap.
- Extra gap appeared between toolbar and keyboard on iOS when safe-area padding was applied during keyboard-open state.

## Root Cause

Toolbar visibility and toolbar positioning were handled by different coordinate systems:

- Visibility: based on keyboard-open detection (`keyboardHeight > 0`).
- Positioning: based on viewport/screen anchoring (`fixed` or `absolute`).

When these are not aligned, keyboard state can be correct while UI position is still wrong.

## Final Approach (Stable)

Use an input-anchor focus signal to decide whether the toolbar should render, and keep the toolbar in normal layout flow.

1. Keep terminal resize behavior driven by `visualViewport`/`--app-vh`.
   - Compensate `visualViewport.offsetTop` only for small transient shifts; ignore large offsets to avoid canceling keyboard shrink.
2. Use the terminal input anchor (`textarea`) focus state as the toolbar visibility signal.
3. Do **not** use floating positioning (`fixed`/`absolute`) for the toolbar.
4. Do **not** add extra `safe-area-inset-bottom` padding for this toolbar while keyboard is open.
5. Avoid forcing `window.scrollTo(0, 0)` during keyboard animation.

This ensures terminal area and toolbar are laid out in one flex flow, so there is no overlap and no duplicated bottom compensation.

## Current Implementation

- `src/lib/components/views/TerminalView.tsx`
  - Keyboard visibility for toolbar is driven by input focus (`onInputFocusChange`).
  - Backend resize calls are throttled and deduplicated to reduce keyboard-animation jitter.
  - `MobileKeyboard` rendered as part of normal component tree.
- `src/lib/components/terminal/MobileKeyboard.tsx`
  - Visibility guard: `visible` (focus-based).
  - Container is a regular block (`z-20 border-t ...`) without floating positioning.
- `src/lib/components/terminal/TerminalViewport.tsx`
  - Input anchor is positioned at a stable top-left spot inside terminal container.
  - Input focus and blur state are emitted to parent.
  - Prefer `WebglAddon` for visual quality, fallback to canvas on load/context-loss failure.
  - Refresh texture atlas on resize/device-pixel-ratio changes to reduce transient stretch artifacts.

## Validation Checklist

Test on iOS Safari and Android Chrome:

- Focus input in terminal, keyboard opens, toolbar appears.
- Toolbar does not overlap terminal content.
- Toolbar stays directly above keyboard/browser input bar area (no large unexpected gap).
- Closing keyboard hides toolbar and terminal returns to full height.
- Repeat open/close 10+ times; no drift or cumulative offset.

## Debug Instrumentation

When diagnosing keyboard animation issues, enable scoped debug channels:

- URL query: `?debug=keyboard,viewport,terminal`
- Or localStorage: `localStorage.setItem('web-terminal:debug', 'keyboard,viewport,terminal')`
- Reload page after changing debug channels.

Current channel coverage:

- `viewport`: `--app-vh` sync decisions (`innerHeight`, `visualViewport.height`, `offsetTop`, compensated result).
- `keyboard`: focus-driven keyboard visibility and throttled resize queue/flush events.
- `terminal`: renderer selection (`webgl`/`canvas`), `ResizeObserver` events, and `fit` before/after rows/cols.

## Related Troubleshooting: Duplicate Echo While Typing

If users report repeated characters (including normal non-IME typing), check stream duplication first:

- Verify one active stream per backend session in `/api/terminal/processes` (`clients` should not grow unexpectedly).
- Ensure `TerminalView` cleanup closes old subscriptions on unmount/reconnect.
- Guard stream callbacks with a connection version/token, and ignore stale callbacks.

This issue can look like input-method behavior, but if plain English typing also duplicates, stream lifecycle is usually the root cause.

## Anti-Patterns To Avoid

- `fixed bottom-0` toolbar while terminal height is controlled by `--app-vh`.
- `absolute bottom-0` floating toolbar inside terminal wrapper (content overlap risk).
- Stacking keyboard compensation + safe-area compensation without explicit need.
