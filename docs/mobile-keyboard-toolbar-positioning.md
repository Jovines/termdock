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

Use keyboard-height logic only to decide whether the toolbar should render, and keep toolbar in normal layout flow.

1. Keep terminal resize behavior driven by `visualViewport`/`--app-vh`.
2. Render `MobileKeyboard` only when `keyboardHeight > 0`.
3. Do **not** use floating positioning (`fixed`/`absolute`) for the toolbar.
4. Do **not** add extra `safe-area-inset-bottom` padding for this toolbar while keyboard is open.

This ensures terminal area and toolbar are laid out in one flex flow, so there is no overlap and no duplicated bottom compensation.

## Current Implementation

- `src/lib/components/views/TerminalView.tsx`
  - Keyboard detection based on touch device + viewport height delta logic.
  - `MobileKeyboard` rendered as part of normal component tree.
- `src/lib/components/terminal/MobileKeyboard.tsx`
  - Visibility guard: `keyboardHeight > 0`.
  - Container is a regular block (`z-20 border-t ...`) without floating positioning.

## Validation Checklist

Test on iOS Safari and Android Chrome:

- Focus input in terminal, keyboard opens, toolbar appears.
- Toolbar does not overlap terminal content.
- Toolbar stays directly above keyboard/browser input bar area (no large unexpected gap).
- Closing keyboard hides toolbar and terminal returns to full height.
- Repeat open/close 10+ times; no drift or cumulative offset.

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
