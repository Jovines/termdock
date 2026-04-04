# Mobile Keyboard Adaptation Skill

Use this skill when mobile soft keyboard behavior causes layout jumps, parent scrolling, or unstable terminal sizing.

## Goal

- Keep the app root locked to the visible viewport height.
- Let keyboard open/close resize terminal height predictably.
- Ensure touch scroll only affects terminal content, never parent containers.
- Respect iOS safe areas without creating extra page height.

## Core Rules

1. Single height source
   - Drive layout from `visualViewport.height`.
   - Write to CSS var `--app-vh` in `requestAnimationFrame`.
   - Root container height must use `var(--app-vh, 100dvh)`.

2. Keyboard state is state only
   - Keyboard height formula: `innerHeight - visualViewport.height - visualViewport.offsetTop`.
   - Use hysteresis thresholds to avoid flicker (open >= 120, close <= 80).
   - Do not apply a second `calc(100% - keyboardHeight)` on terminal wrappers.

3. Lock page scroll chain
   - Set `html, body, #root` to fixed viewport height and `overflow: hidden`.
   - Use `overscroll-behavior: none` globally.
   - Remove global safe-area paddings on `html/body` if they add document height.

4. Terminal handles touch scroll
   - Terminal viewport should use `touch-action: none` on mobile.
   - In touch/pointer move handlers, call `preventDefault()` and `stopPropagation()`.
   - Keep parent wrappers `min-height: 0` and `overflow: hidden` in flex layout.

5. iOS focus stability
   - Keep hidden input fixed and not dynamically repositioned per tap.
   - Prefer `position: fixed`, tiny size, off interaction path.
   - Use `font-size: 16px` for hidden text input to reduce iOS zoom/pan side effects.
   - If viewport drifts, hard reset with `window.scrollTo(0, 0)` during viewport sync.

## Implementation Checklist

- [ ] Viewport meta includes `interactive-widget=resizes-content` and `viewport-fit=cover`.
- [ ] `--app-vh` updater listens to `resize`, `orientationchange`, and `visualViewport` events.
- [ ] Root/app wrappers use `--app-vh` and cannot scroll.
- [ ] Terminal view has no duplicate height subtraction.
- [ ] Mobile keyboard bar is `fixed` at bottom and uses only safe-area bottom padding.
- [ ] Touch scrolling never moves parent page.
- [ ] iOS repeated open/close does not push terminal view out of screen.

## Validation Scenarios

1. iOS Safari
   - Focus terminal repeatedly at different positions.
   - Open/close keyboard 10+ times.
   - Confirm no upward drift and no parent scrolling.

2. Android Chrome
   - Verify keyboard resize and terminal fit updates.
   - Confirm terminal content scroll works while page stays fixed.

3. Orientation changes
   - Rotate with keyboard open and closed.
   - Ensure terminal remains visible and sized correctly.

## Related Files in This Project

- `index.html`
- `src/App.tsx`
- `src/index.css`
- `src/lib/components/views/TerminalView.tsx`
- `src/lib/components/terminal/MobileKeyboard.tsx`
- `src/lib/components/terminal/TerminalViewport.tsx`
- `src/lib/hooks/useTouchScroll.ts`
