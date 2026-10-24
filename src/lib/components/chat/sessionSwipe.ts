// Keep editor selection, horizontal content and embedded controls local. The
// conversation canvas (including the empty state) belongs to the Session pager.
export const SESSION_NO_SWIPE = "[data-mobile-keyboard='true'], [data-chat-composer], [data-chat-no-swipe], [data-session-chat] pre, [data-session-chat] table, [data-session-chat] input, [data-session-chat] textarea, [data-session-chat] select, [data-session-chat] [contenteditable='true']";

// Swiper directly blurs matching active fields on pointerdown AND pointermove,
// even when touchStartPreventDefault=false or inner handlers preventDefault.
// Session inputs own their focus lifecycle; exclude them from that blur policy.
// Their editor/toolbar gestures remain local through SESSION_NO_SWIPE above.
export const SESSION_SWIPER_FOCUSABLE_ELEMENTS = 'input, select, option, textarea:not([data-terminal-input-anchor]):not(.session-chat-input), button, video, label';
