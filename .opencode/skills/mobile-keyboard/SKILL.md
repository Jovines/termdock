---
name: mobile-keyboard
description: Diagnose and fix mobile soft-keyboard toolbar placement and terminal viewport behavior without introducing overlap or double compensation.
compatibility: opencode
metadata:
  audience: maintainers
  scope: termdock
---

## What this skill does

- Stabilizes terminal layout when soft keyboard opens/closes.
- Ensures toolbar appears only when keyboard is open.
- Keeps toolbar in correct visual position without covering terminal content.
- Avoids duplicate bottom offsets from mixed viewport/safe-area logic.
- Diagnoses duplicate terminal echo caused by repeated stream subscriptions.

## When to use

Use this skill when user reports issues like:

- Keyboard opens but toolbar does not show.
- Toolbar shows but is at wrong position.
- Toolbar overlaps terminal content.
- Large gap between toolbar and keyboard on iOS.
- Repeated open/close causes drift.
- Typed characters appear twice (or intermittently duplicate), including non-IME input.

## Project assumptions

- App height is synchronized to `visualViewport.height` via CSS var (`--app-vh`).
- Terminal view uses flex layout with `min-h-0` and hidden parent overflow.
- Keyboard visibility state is derived from viewport delta + hysteresis thresholds.

## Workflow

1. Confirm the symptom category
   - `not-shown`: toolbar never appears.
   - `wrong-position`: appears but detached from keyboard/top of keyboard area.
   - `overlap`: covers terminal content.
   - `large-gap`: obvious extra space to keyboard.
   - `duplicate-echo`: one keypress appears multiple times in terminal.

2. Verify keyboard state source
   - Use one source of truth for keyboard-open state (`keyboardHeight > 0`).
   - Keep hysteresis (`open >= 120`, `close <= 80`) to avoid flicker.
   - Prefer viewport-delta logic aligned with app `--app-vh` behavior.

3. Verify toolbar rendering contract
   - Render toolbar only when `keyboardHeight > 0`.
   - Do not gate by unrelated viewport width heuristics if keyboard state is already valid.

4. Verify positioning strategy
   - Preferred for this project: toolbar in normal layout flow (non-floating block at bottom of terminal flex column).
   - Avoid `fixed bottom-0` with `--app-vh` controlled containers.
   - Avoid `absolute bottom-0` if it causes overlay on terminal content.

5. Verify iOS spacing rules
   - Do not stack extra `safe-area-inset-bottom` padding during keyboard-open state unless measured need exists.
   - If spacing issue appears, remove duplicated compensation first.

6. Validate on real devices
   - iOS Safari: open/close keyboard 10+ times, no drift.
   - Android Chrome: toolbar appears/disappears correctly.
    - No overlap, no large gap, terminal remains usable.

7. If duplicate echo appears, verify stream lifecycle (high priority)
   - Differentiate source first:
     - If normal English input duplicates, prioritize stream duplication checks.
     - If only IME composition duplicates, check composition/input event handling.
   - Enforce single active stream per `TerminalView` instance:
     - Cleanup must always close previous subscription before opening a new one.
     - On unmount, must close stream and invalidate in-flight callbacks.
   - Add stale-callback guard (version/token) to ignore events from old streams.
   - Runtime verify via API: `GET /api/terminal/processes`
     - Suspicious signal: same backend `sessionId` with `clients > 1` when not expected.
   - Re-test by typing plain text (not IME). No repeated echo is the success criterion.

## Anti-patterns

- Using one signal for resize and another unrelated signal for toolbar visibility.
- Floating toolbar (`fixed`/`absolute`) plus flex-resized terminal without strict offset model.
- Applying both keyboard-height compensation and safe-area compensation blindly.
- Effect cleanup that only logs but does not actually close stream subscriptions.
- Reconnecting stream without invalidating callbacks from prior connection attempts.

## Output requirements for the agent

When this skill is applied, the response should include:

- Root-cause statement tied to concrete code paths.
- Chosen layout strategy and why.
- Exact files touched.
- Validation result (`lint/tests/manual steps`).
