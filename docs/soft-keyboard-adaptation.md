# Soft Keyboard Adaptation

## Problem

On mobile, when the soft keyboard opens, the browser's visual viewport shrinks.
If the terminal container shrinks with it, xterm.js recalculates rows/cols and
sends a resize event to the backend PTY — expensive and causes flicker.

Additionally, a toolbar (esc/tab/ctrl/arrow keys) is rendered below the terminal.
If it toggles between visible/hidden (`max-h-40` ↔ `max-h-0`), the terminal's
flex height changes, triggering another resize.

## Solution Overview

**Terminal pixel height never changes.**  When the keyboard opens, the entire
terminal + toolbar is pushed *up* via `transform: translateY()`.  The toolbar
always occupies its full space (only `opacity` toggles).  No resize events.

## Architecture

### Layer 1: Height anchoring

`useViewportHeight` hook sets two CSS variables on `<html>`:

| Variable | Value | Updates on |
|----------|-------|------------|
| `--app-base-vh` | `window.innerHeight` | startup, orientation change |
| `--app-vh` | `visualViewport.height` | every `visualViewport.resize/scroll` |

`--app-base-vh` does **not** shrink when the keyboard opens. On mobile, all
root elements use it:

```css
@media (max-width: 768px) {
  html, body, #root {
    height: var(--app-base-vh, 100lvh);
  }
}
```

This keeps the entire layout at full viewport height regardless of keyboard state.

### Layer 2: translateY push

The `TerminalView` wrapper applies:

```tsx
style={{
  transform: `translateY(calc(var(--app-vh, 0px) - var(--app-base-vh, 0px)))`
}}
```

- Keyboard closed: `--app-vh ≈ --app-base-vh` → `translateY(0)` → no shift.
- Keyboard open (e.g., 300px): `translateY(-300px)` → content pushed up, reveals
  the toolbar just above the keyboard.

The terminal DOM height is unchanged.  xterm.js does not fire a resize.

### Layer 3: Toolbar always at full height

`MobileKeyboard` hidden state uses only `opacity-0 pointer-events-none`,
**never** collapses its `max-h` or `py`.  The toolbar always occupies ~32–62px
in the flex layout, so the terminal's `flex-1` allocation is constant.

```
TerminalView (flex-col h-full)
├── Terminal area (flex-1 min-h-0)   ← constant height
└── MobileKeyboard                    ← constant height, opacity toggled
```

### Layer 4: Safe area (bottom inset)

`#root` reserves the iPhone safe area via padding:

```css
#root {
  padding-bottom: max(0px, env(safe-area-inset-bottom, 0px) - 16px);
}
```

The `-16px` accounts for xterm.js's character-row rounding: removing safe-area
padding gives the terminal extra pixel height, but xterm only renders whole
rows.  If the extra pixels don't fill an entire row, they become dead space
(a visible gap between xterm content and the toolbar).  Subtracting 16px
(≈ one row on typical font sizes) absorbs this dead space.

The translateY formula reads this computed padding from `#root` and exposes
it as `--safe-bottom-px` (a plain JS-computed pixel value) to avoid nested
`max()`/`calc()`/`env()` parsing issues on mobile browsers:

```tsx
style={{
  transform: `translateY(
    min(0px, calc(
      var(--app-vh, 0px) - var(--app-base-vh, 0px) + var(--safe-bottom-px, 0px)
    ))
  )`
}}
```

`min(0px, ...)` prevents a positive translateY when the keyboard is closed
(`--app-vh ≈ --app-base-vh`, but `--safe-bottom-px > 0`).

## Zero-Resize Guarantee

| Action | Terminal height change? | Resize event? |
|--------|------------------------|---------------|
| Keyboard opens | No (translateY push) | No |
| Keyboard closes | No (translateY returns) | No |
| Toolbar appears | No (always at full height) | No |
| Toolbar hidden | No (opacity only) | No |
| Orientation change | Yes (legitimate) | Yes |

## Key Files

| File | Role |
|------|------|
| `useViewportHeight.ts` | `--app-vh`, `--app-base-vh`, `--safe-bottom-px` |
| `index.css` | Mobile root heights, safe-area padding |
| `TerminalView.tsx` | translateY inline style |
| `MobileKeyboard.tsx` | Opacity-only toggle, `py-0 px-1` tight spacing |
| `clientLog.ts` | Phone → server log forwarding |

## Debugging

Phone-side logs are forwarded to the server via `POST /api/client-log`.
Use `clientLog(level, message, data)` from any client code.  Monitor with:

```bash
tail -f /tmp/termdock-dev.log | grep client-log
```

## Known Pitfalls

### Nested `max()`/`env()` inside `calc()` breaks on mobile Safari

Do **not** write:

```css
/* BROKEN — nested max() inside calc() ignored on iOS Safari */
transform: translateY(min(0px, calc(var(--app-vh) - var(--app-base-vh) + max(0px, env(safe-area-inset-bottom) - 16px))));
```

The `max(0px, env(...))` inside `calc()` is silently dropped on mobile Safari,
resulting in the wrong translateY and a gap between the toolbar and keyboard.

**Fix:** Compute the value in JS and expose it as a plain px CSS variable:

```typescript
// In useViewportHeight.ts — read computed padding from #root
const root = document.getElementById('root');
const pad = parseFloat(getComputedStyle(root).paddingBottom) || 0;
document.documentElement.style.setProperty('--safe-bottom-px', `${pad}px`);
```

```css
/* OK — only simple arithmetic with plain px variables */
transform: translateY(min(0px, calc(var(--app-vh) - var(--app-base-vh) + var(--safe-bottom-px, 0px))));
```
