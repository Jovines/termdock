#ifndef TD_GHOSTTY_H
#define TD_GHOSTTY_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
// Rust binds only this private scalar/pointer ABI. The actual Ghostty structs
// are compiled in Objective-C against the verbatim SHA-verified fork header.
typedef int (*td_event_fn)(void *, uint32_t, const uint8_t *, size_t, uint64_t, uint64_t);
int td_native_is_main_thread(void);
void *td_native_create(void *parent, void *context, td_event_fn callback,
                       const char *config, float font, uint16_t cols, uint16_t rows, uint32_t history);
void td_native_destroy(void *handle);
void *td_native_view(void *handle);
void td_native_cancel(void *handle);
bool td_native_drain_app(void *handle);
int td_native_pump_io(void *handle);
bool td_native_feed(void *handle, const uint8_t *data, size_t len);
bool td_native_barrier(void *handle);
void td_native_worker_busy(void *handle, bool busy);
bool td_native_is_busy(void *handle);
int td_native_pump(void *handle);
int td_native_rect(void *handle, double x, double y, double w, double h,
                    double scale, uint16_t *cols, uint16_t *rows);
bool td_native_replay_size(void *handle, uint32_t w, uint32_t h, double scale, uint16_t cols, uint16_t rows);
void td_native_dimensions(void *handle, uint32_t *w, uint32_t *h, double *scale, uint16_t *cols, uint16_t *rows);
void td_native_render_stats(void *handle, uint64_t *attempts, uint64_t *submissions);
// Read-only main-thread scalar snapshots: live/create/first-rect and NSWindow buttons.
bool td_native_geometry(void *handle, uint32_t phase, double values[16]);
bool td_native_window_geometry(void *wk_view, double values[32]);
bool td_native_palette(void *handle, const char *config);
void td_native_focus(void *handle);
bool td_native_bind_webview(void *handle,void *wk_view);
bool td_native_blur(void *handle);
bool td_native_link_hover(void *handle,uint64_t revision,const double *rects,size_t count);
void td_native_policy(void *handle, bool tmux);
void td_native_history(void *handle, uint32_t history);
bool td_native_action(void *handle, const char *action, size_t len);
void td_native_text(void *handle, const uint8_t *text, size_t len);
// 0 unreadable, 1 copied, 2 empty, 3 exceeds copy budget; all allocated text is freed once.
int td_native_read_text(void *handle, bool selection);
uint32_t td_native_attachment(void *handle, void *wk_view);
void td_native_cursor(void *handle, uint32_t *x, uint32_t *y);
bool td_native_clip(void *handle,const double *rects,size_t count);
int td_native_layout(void *handle,double x,double y,double w,double height,double scale,const double *rects,size_t count,bool resize,bool visible,uint16_t *cols,uint16_t *rows);
bool td_native_visible(void *handle, bool visible);
void td_native_replaying(void *handle, bool replaying);
int td_native_snapshot(void *handle,uint8_t *bytes,size_t cap,size_t *len);
bool td_native_snapshot_finish(void *handle,const uint8_t *bytes,size_t len);
void td_native_flush_sync(void *handle);
size_t td_native_viewport(void *handle);
bool td_native_restore_viewport(void *handle, size_t offset);
int td_native_search(void *handle, const char *needle, size_t len, int direction,
                     intptr_t *total, intptr_t *selected);
void *td_native_keyboard_window(void);
bool td_native_keyboard_case(void *window,uint32_t which);
bool td_native_keyboard_prepare(void *window,uint32_t action);
bool td_native_keyboard_context(void *window,uint64_t values[12]);
bool td_native_keyboard_app_case(void *window,uint32_t which);
uint32_t td_native_keyboard_commit_snapshot_fixture(void);
bool td_native_keyboard_arm(void *window);
bool td_native_keyboard_stages(void *window,uint64_t stages[20]);
void td_native_keyboard_step(void);
void *td_native_demo_window(void);
int td_native_demo_step(void *window);
void td_native_demo_close(void *window);
void *td_native_demo_parent(void *window);
void td_native_demo_bounds(void *window, double *w, double *h, double *scale);
void td_native_input_blocked(void *handle,bool blocked);
#endif
