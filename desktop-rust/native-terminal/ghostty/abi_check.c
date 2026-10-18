// Compile against the VERBATIM pinned header, on Linux and on macOS.
#include "ghostty.h"
#include "../native/TDGhostty.h"
_Static_assert(GHOSTTY_BACKEND_EXTERNAL == 1, "external tag changed");
_Static_assert(GHOSTTY_BACKEND_EXEC == 0, "exec tag changed");
static void write_cb(ghostty_surface_t s, const char *p, size_t n) {(void)s;(void)p;(void)n;}
static void resize_cb(ghostty_surface_t s,uint16_t c,uint16_t r,uint32_t w,uint32_t h) {(void)s;(void)c;(void)r;(void)w;(void)h;}
void td_verify_header_abi(void) {
    ghostty_surface_config_s cfg = ghostty_surface_config_new();
    cfg.backend_type = GHOSTTY_BACKEND_EXTERNAL;
    cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    cfg.platform.macos.nsview = (void *)0;
    cfg.write_callback = write_cb;
    cfg.resize_callback = resize_cb;
    void (*feed)(ghostty_surface_t,const char *,uintptr_t) = ghostty_surface_write_output;
    bool (*key)(ghostty_surface_t,ghostty_input_key_s) = ghostty_surface_key;
    void (*preedit)(ghostty_surface_t,const char *,uintptr_t) = ghostty_surface_preedit;
    void (*free_text)(ghostty_surface_t,ghostty_text_s *) = ghostty_surface_free_text;
    (void)cfg;(void)feed;(void)key;(void)preedit;(void)free_text;
}
