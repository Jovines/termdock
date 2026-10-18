#include "TDHostState.h"
enum { DIRTY = 1, CLEAR = 2 };
bool td_shortcut_down(uint64_t state[4], uint16_t keycode, bool captured, bool repeat) {
    if (keycode >= 256) return false;
    uint64_t mask = UINT64_C(1) << (keycode % 64);
    // A new physical press supersedes a release lost during blur. A repeat
    // of an already captured held key retains its ownership after mods change.
    if (!repeat) state[keycode / 64] &= ~mask;
    if (captured) state[keycode / 64] |= mask;
    return (state[keycode / 64] & mask) != 0;
}
bool td_shortcut_release(uint64_t state[4], uint16_t keycode) {
    if (keycode >= 256) return false;
    uint64_t mask = UINT64_C(1) << (keycode % 64);
    bool captured = (state[keycode / 64] & mask) != 0;
    state[keycode / 64] &= ~mask;
    return captured;
}
void td_preedit_mark(uint8_t *state) { *state |= DIRTY; }
void td_preedit_cancel(uint8_t *state) { *state = CLEAR; }
int td_preedit_step(uint8_t *state, bool busy) {
    if (busy) return 0;
    if (*state & CLEAR) { *state &= (uint8_t)~CLEAR; return 1; }
    if (*state & DIRTY) { *state &= (uint8_t)~DIRTY; return 2; }
    return 0;
}
int td_modifier_action(uint16_t keycode, uint64_t flags, const uint64_t masks[9]) {
    unsigned index;
    switch (keycode) {
        case 0x39: index = 0; break;
        case 0x38: index = 1; break;
        case 0x3c: index = 2; break;
        case 0x3b: index = 3; break;
        case 0x3e: index = 4; break;
        case 0x3a: index = 5; break;
        case 0x3d: index = 6; break;
        case 0x37: index = 7; break;
        case 0x36: index = 8; break;
        default: return -1;
    }
    return (flags & masks[index]) != 0;
}
