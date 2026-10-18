#ifndef TD_HOST_STATE_H
#define TD_HOST_STATE_H
#include <stdbool.h>
#include <stdint.h>
// Shared production scheduling, independent of AppKit/engine symbols.
// A cancellation survives a busy feed and precedes any newer marked text.
void td_preedit_mark(uint8_t *state);
void td_preedit_cancel(uint8_t *state);
// 0: no work, 1: clear engine composition, 2: apply current marked text.
int td_preedit_step(uint8_t *state, bool busy);
// masks: caps, left/right shift, left/right ctrl, left/right alt, left/right cmd.
// -1: unknown key, 0: release, 1: press; aggregate modifiers are insufficient.
int td_modifier_action(uint16_t keycode, uint64_t flags, const uint64_t masks[9]);
// Page-owned shortcuts must not leak release events into Kitty keyboard mode.
// Fixed storage, independent keys/repeats, and no modifier dependence at release.
bool td_shortcut_down(uint64_t state[4], uint16_t keycode, bool captured, bool repeat);
bool td_shortcut_release(uint64_t state[4], uint16_t keycode);
#endif
