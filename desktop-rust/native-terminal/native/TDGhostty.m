#import <objc/runtime.h>
// AppKit host of the complete pinned Ghostty engine. No renderer or VT parser.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <Carbon/Carbon.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <stdlib.h>
#include "TDGhostty.h"
#include "TDHostState.h"
#include "TDClipboardTypes.h"
#include "TDClipboardCopy.h"
#include "ghostty.h"
// Private exports implemented by the locked maintenance patch.
extern bool td_ghostty_feed(ghostty_surface_t,const uint8_t *,size_t);
extern void td_ghostty_flush_sync(ghostty_surface_t);
extern void td_ghostty_bind_yield(ghostty_surface_t,void *,bool (*)(void *));
extern bool td_ghostty_barrier(ghostty_surface_t,void *,void (*)(void *,bool));
extern void td_ghostty_cursor(ghostty_surface_t,uint32_t *,uint32_t *);
extern void td_ghostty_history(ghostty_surface_t,uint32_t);
extern size_t td_ghostty_viewport(ghostty_surface_t);
extern bool td_ghostty_restore_viewport(ghostty_surface_t,size_t);
extern bool td_ghostty_resize_checked(ghostty_surface_t,uint32_t,uint32_t,double);
extern bool td_ghostty_update_config(ghostty_surface_t,ghostty_config_t);
extern void td_ghostty_render_stats(ghostty_surface_t,uint64_t *,uint64_t *);
extern int td_ghostty_snapshot(ghostty_surface_t,uint8_t *,size_t,size_t *);
extern bool td_ghostty_path_hit(ghostty_surface_t,uint16_t,uint16_t,uint8_t *,size_t,size_t *);
extern bool td_ghostty_snapshot_finish(ghostty_surface_t,const uint8_t *,size_t);
extern bool td_ghostty_size_valid(ghostty_surface_t,uint32_t,uint32_t,double);

@class TDGhosttyView;
typedef struct {
    void *retained_view;
    ghostty_app_t app;
    ghostty_surface_t surface;
    ghostty_config_t config;
    void *context;
    td_event_fn callback;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    bool barrier_done, barrier_success;
    atomic_bool busy;
    atomic_bool replaying;
    atomic_bool wakeup;
    atomic_bool needs_barrier;
    atomic_bool gui_requested;
    atomic_bool closing;
    atomic_bool failed;
    bool gui_done;
    uint8_t preedit_state;
    uint64_t shortcut_keys[4];
    bool tmux_scroll;
    bool desired_visible, visibility_dirty, desired_focus, focus_dirty, has_rect;
    bool reported_focus;
    uint64_t focus_revision;
    double scale, initial_font_points;
    double created_geometry[16], first_rect_geometry[16];
    bool created_geometry_valid, first_rect_geometry_valid;
    bool keyboard_fixture;
    uint64_t keyboard_stages[20];
} TDHandle;
// AppKit interpretation happens during keyDown. Only the immutable result is
// delayed until the serialized engine feed releases its barrier.
@interface TDInterpretedKey : NSObject
@property(nonatomic,strong) NSEvent *event;
@property(nonatomic,copy) NSArray<NSString *> *text;
@property(nonatomic) bool composing;
@property(nonatomic) size_t byteCount;
@end
@implementation TDInterpretedKey
@end
@interface TDGhosttyView : NSView<NSTextInputClient,NSDraggingDestination>
@property(nonatomic,assign) TDHandle *host;
@property(nonatomic,weak) NSView *inputWebview;
@property(nonatomic,strong) NSMutableAttributedString *marked;
@property(nonatomic) NSRange markedSelection;
@property(nonatomic,strong) NSMutableArray<NSString *> *accumulator;
@property(nonatomic,strong) NSMutableArray<id> *pending;
@property(nonatomic,strong) NSTrackingArea *tracking;
@property(nonatomic) bool interpreting;
@property(nonatomic) bool optionAsAlt;
@property(nonatomic) bool cancellingComposition;
@property(nonatomic) uint64_t compositionGeneration;
@property(nonatomic) size_t pendingBytes;
@property(nonatomic) NSRect imeRect;
@property(nonatomic,strong) NSArray<NSValue *> *clipHoles;
- (void)dispatchEvent:(NSEvent *)event;
- (void)dispatchKey:(TDInterpretedKey *)key;
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender;
- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender;
- (void)syncPreedit;
- (void)flushPreedit;
- (void)cancelComposition;
@end
static int emit(TDHandle *h,uint32_t kind,const void *data,size_t n,uint64_t a,uint64_t b) {
    return h && h->callback ? h->callback(h->context,kind,data,n,a,b) : 0;
}
static void textEvent(TDHandle *h,uint32_t kind,const char *s) {
    size_t n=s ? strnlen(s,262145) : 0;
    if(n>262144){emit(h,5,NULL,0,0,0);return;}
    emit(h,kind,s,n,0,0);
}
static TDHandle *surfaceHost(ghostty_surface_t surface) {
    return (TDHandle *)ghostty_surface_userdata(surface);
}
static void outputCallback(ghostty_surface_t surface,const char *data,size_t len) {
    TDHandle *h=surfaceHost(surface);
    if(atomic_load(&h->replaying))return;
    // IO thread only, bounded Rust callback queue. Main never enters Ghostty
    // while the serialized feed/barrier is active, so it can drain freely.
    while(len) {
        size_t count=MIN(len,262144);
        if(!emit(h,0,data,count,0,0))return; // only explicit close rejects IO
        len-=count;data+=count;
    }
}
static void resizeCallback(ghostty_surface_t surface,uint16_t cols,uint16_t rows,uint32_t w,uint32_t height) {
    (void)w;(void)height;
    TDHandle *h=surfaceHost(surface);
    if(!atomic_load(&h->replaying))emit(h,1,NULL,0,cols,rows);
}
static void wakeupCallback(void *ctx) {TDHandle *h=ctx;atomic_store(&h->wakeup,true);emit(h,16,NULL,0,0,0);}
static bool actionCallback(ghostty_app_t app,ghostty_target_s target,ghostty_action_s action) {
    TDHandle *h=(TDHandle *)ghostty_app_userdata(app);
    if(target.tag==GHOSTTY_TARGET_SURFACE)h=surfaceHost(target.target.surface);
    switch(action.tag) {
        case GHOSTTY_ACTION_SET_TITLE:textEvent(h,3,action.action.set_title.title);return true;
        case GHOSTTY_ACTION_RING_BELL:emit(h,4,NULL,0,0,0);return true;
        case GHOSTTY_ACTION_RENDERER_HEALTH:
            if(action.action.renderer_health==GHOSTTY_RENDERER_HEALTH_UNHEALTHY)textEvent(h,10,"Ghostty Metal renderer unhealthy");return true;
        case GHOSTTY_ACTION_START_SEARCH:textEvent(h,6,action.action.start_search.needle);return true;
        case GHOSTTY_ACTION_END_SEARCH:return true;
        case GHOSTTY_ACTION_OPEN_URL:
            if(action.action.open_url.len>16384){emit(h,5,NULL,0,0,0);return false;}
            emit(h,18,action.action.open_url.url,action.action.open_url.len,0,0);return true;
        // No binding can create an app/window/local shell. Host owns sessions.
        case GHOSTTY_ACTION_NEW_WINDOW:case GHOSTTY_ACTION_NEW_TAB:case GHOSTTY_ACTION_NEW_SPLIT:return false;
        case GHOSTTY_ACTION_CLOSE_WINDOW:case GHOSTTY_ACTION_CLOSE_TAB:emit(h,7,NULL,0,0,0);return true;
        default:return false;
    }
}
static void readClipboard(void *ctx,ghostty_clipboard_e clipboard,void *state) {
    // Remote clipboard read/write denied in immutable config. Cmd+V below is
    // local user action, not a remote OSC52 request.
    (void)clipboard;
    TDHandle *h=ctx;
    ghostty_surface_complete_clipboard_request(h->surface,"",state,false);
}
static void confirmClipboard(void *ctx,const char *text,void *state,ghostty_clipboard_request_e request) {
    (void)text;(void)request;TDHandle *h=ctx;
    ghostty_surface_complete_clipboard_request(h->surface,"",state,false);
}
static void writeClipboard(void *ctx,ghostty_clipboard_e clipboard,const ghostty_clipboard_content_s *content,size_t len,bool confirm) {
    (void)ctx;(void)clipboard;(void)content;(void)len;(void)confirm;
    // Only direct local selection copy is supported. No remote clipboard writes.
}
static void closeSurface(void *ctx,bool alive) {(void)alive;emit(ctx,7,NULL,0,0,0);}
static ghostty_input_mods_e modifiers(NSEventModifierFlags flags) {
    unsigned m=0;
    if(flags&NSEventModifierFlagShift)m|=GHOSTTY_MODS_SHIFT;
    if(flags&NSEventModifierFlagControl)m|=GHOSTTY_MODS_CTRL;
    if(flags&NSEventModifierFlagOption)m|=GHOSTTY_MODS_ALT;
    if(flags&NSEventModifierFlagCommand)m|=GHOSTTY_MODS_SUPER;
    if(flags&NSEventModifierFlagCapsLock)m|=GHOSTTY_MODS_CAPS;
    if(flags&NX_DEVICERSHIFTKEYMASK)m|=GHOSTTY_MODS_SHIFT_RIGHT;
    if(flags&NX_DEVICERCTLKEYMASK)m|=GHOSTTY_MODS_CTRL_RIGHT;
    if(flags&NX_DEVICERALTKEYMASK)m|=GHOSTTY_MODS_ALT_RIGHT;
    if(flags&NX_DEVICERCMDKEYMASK)m|=GHOSTTY_MODS_SUPER_RIGHT;
    return (ghostty_input_mods_e)m;
}
static bool canInput(TDHandle *h) {return emit(h,9,NULL,0,0,0)!=0;}
static bool yieldToMain(void *ctx) {
    TDHandle *h=ctx;
    if(NSThread.isMainThread)return false;
    pthread_mutex_lock(&h->mutex);h->gui_done=false;atomic_store(&h->gui_requested,true);emit(h,16,NULL,0,0,0);
    struct timespec deadline;clock_gettime(CLOCK_REALTIME,&deadline);deadline.tv_sec+=30;
    while(!h->gui_done&&!atomic_load(&h->closing)){
        if(pthread_cond_timedwait(&h->cond,&h->mutex,&deadline)!=0)break;
    }
    bool ok=h->gui_done&&!atomic_load(&h->closing);pthread_mutex_unlock(&h->mutex);
    if(!ok)atomic_store(&h->failed,true);
    return ok;
}
static void barrierCallback(void *ctx,bool success) {
    TDHandle *h=ctx;pthread_mutex_lock(&h->mutex);
    h->barrier_done=true;h->barrier_success=success;pthread_cond_signal(&h->cond);pthread_mutex_unlock(&h->mutex);
}
int td_native_is_main_thread(void) {return NSThread.isMainThread;}
void *td_native_create(void *parent,void *context,td_event_fn cb,const char *text,float font,uint16_t cols,uint16_t rows,uint32_t history) {
    if(!NSThread.isMainThread||!parent||!cb||cols<2||rows<1||(size_t)cols*rows>262144)return NULL;
    static dispatch_once_t once;static bool initialized;
    dispatch_once(&once,^{char *argv[]={"termdock-native",NULL};initialized=ghostty_init(1,argv)==GHOSTTY_SUCCESS;});
    if(!initialized)return NULL;
    TDHandle *h=calloc(1,sizeof(*h));if(!h)return NULL;
    pthread_mutex_init(&h->mutex,NULL);pthread_cond_init(&h->cond,NULL);
    atomic_init(&h->busy,false);atomic_init(&h->wakeup,false);atomic_init(&h->replaying,false);atomic_init(&h->needs_barrier,false);atomic_init(&h->gui_requested,false);atomic_init(&h->closing,false);atomic_init(&h->failed,false);
    double scale=[(__bridge NSView *)parent window].backingScaleFactor;
    if(!isfinite(scale)||scale<1||scale>4){td_native_destroy(h);return NULL;}
    h->context=context;h->callback=cb;h->desired_visible=false;h->scale=scale;h->initial_font_points=font;
    TDGhosttyView *v=[[TDGhosttyView alloc]initWithFrame:NSMakeRect(0,0,960,640)];
    [v registerForDraggedTypes:@[NSPasteboardTypeFileURL]];
    v.host=h;v.marked=[[NSMutableAttributedString alloc]init];v.pending=[NSMutableArray array];
    h->retained_view=(void *)CFBridgingRetain(v);
    h->config=ghostty_config_new();if(!h->config)goto failed;
    ghostty_config_load_string(h->config,text,strlen(text));ghostty_config_finalize(h->config);
    if(ghostty_config_diagnostics_count(h->config))goto failed;
    ghostty_runtime_config_s runtime={0};
    runtime.userdata=h;runtime.wakeup_cb=wakeupCallback;runtime.action_cb=actionCallback;
    runtime.read_clipboard_cb=readClipboard;runtime.confirm_read_clipboard_cb=confirmClipboard;
    runtime.write_clipboard_cb=writeClipboard;runtime.close_surface_cb=closeSurface;
    h->app=ghostty_app_new(&runtime,h->config);if(!h->app)goto failed;
    ghostty_surface_config_s cfg=ghostty_surface_config_new();
    cfg.platform_tag=GHOSTTY_PLATFORM_MACOS;cfg.platform.macos.nsview=(__bridge void *)v;
    cfg.userdata=h;cfg.scale_factor=scale;cfg.font_size=font;
    cfg.backend_type=GHOSTTY_BACKEND_EXTERNAL;cfg.write_callback=outputCallback;cfg.resize_callback=resizeCallback;
    cfg.command=NULL;cfg.initial_input=NULL;cfg.working_directory=NULL;cfg.env_vars=NULL;cfg.env_var_count=0;
    h->surface=ghostty_surface_new(h->app,&cfg);if(!h->surface)goto failed;
    v.optionAsAlt=!(ghostty_surface_key_translation_mods(h->surface,GHOSTTY_MODS_ALT)&GHOSTTY_MODS_ALT);
    td_ghostty_bind_yield(h->surface,h,yieldToMain);
    td_ghostty_history(h->surface,history);
    ghostty_surface_size_s size=ghostty_surface_size(h->surface);
    if(!size.cell_width_px||!size.cell_height_px)goto failed;
    uint32_t width=(uint32_t)cols*size.cell_width_px,height=(uint32_t)rows*size.cell_height_px;
    if(!td_ghostty_resize_checked(h->surface,width,height,scale))goto failed;
    [v setFrameSize:NSMakeSize(width/scale,height/scale)];v.layer.contentsScale=scale;v.hidden=YES;
    [(__bridge NSView *)parent addSubview:v];h->visibility_dirty=true;
    h->created_geometry_valid=td_native_geometry(h,0,h->created_geometry);
    return h;
failed:
    td_native_destroy(h);return NULL;
}
void td_native_destroy(void *handle) {
    TDHandle *h=handle;if(!h)return;NSCAssert(NSThread.isMainThread,@"main thread required");
    // Rust already stopped new work, closed callback queue and joined its worker.
    // Ghostty joins its IO/renderer threads before callback context is released.
    if(h->surface){ghostty_surface_free(h->surface);h->surface=NULL;}
    if(h->app){ghostty_app_free(h->app);h->app=NULL;}
    if(h->config){ghostty_config_free(h->config);h->config=NULL;}
    if(h->retained_view){TDGhosttyView *v=CFBridgingRelease(h->retained_view);v.host=NULL;[v removeFromSuperview];h->retained_view=NULL;}
    h->callback=NULL;pthread_cond_destroy(&h->cond);pthread_mutex_destroy(&h->mutex);free(h);
}
void *td_native_view(void *handle) {TDHandle *h=handle;return h ? h->retained_view : NULL;}
bool td_native_feed(void *handle,const uint8_t *data,size_t len) {
    TDHandle *h=handle;return h&&h->surface&&!atomic_load(&h->closing)&&td_ghostty_feed(h->surface,data,len)&&!atomic_load(&h->failed);
}
bool td_native_drain_app(void *handle){
    TDHandle *h=handle;if(atomic_load(&h->closing))return false;
    return !atomic_load(&h->wakeup)||yieldToMain(h);
}
int td_native_pump_io(void *handle){
    TDHandle *h=handle;
    // The parser is at a stable yield with renderer mutex released. Existing
    // IO requests are bounded by the 64-slot engine mailbox. This headroom
    // also keeps metadata callbacks from blocking the AppKit thread.
    if(!atomic_load(&h->gui_requested)||!canInput(h))return 0;
    atomic_store(&h->wakeup,false);ghostty_app_tick(h->app);
    pthread_mutex_lock(&h->mutex);h->gui_done=true;atomic_store(&h->gui_requested,false);pthread_cond_broadcast(&h->cond);pthread_mutex_unlock(&h->mutex);return 1;
}
void td_native_cancel(void *handle){
    TDHandle *h=handle;atomic_store(&h->closing,true);
    pthread_mutex_lock(&h->mutex);pthread_cond_broadcast(&h->cond);pthread_mutex_unlock(&h->mutex);
}
bool td_native_barrier(void *handle) {
    TDHandle *h=handle;if(!h||!h->surface||NSThread.isMainThread)return false;
    pthread_mutex_lock(&h->mutex);h->barrier_done=false;h->barrier_success=false;pthread_mutex_unlock(&h->mutex);
    if(!td_ghostty_barrier(h->surface,h,barrierCallback))return false;
    struct timespec deadline;clock_gettime(CLOCK_REALTIME,&deadline);deadline.tv_sec+=30;
    pthread_mutex_lock(&h->mutex);
    while(!h->barrier_done&&!atomic_load(&h->closing)){if(pthread_cond_timedwait(&h->cond,&h->mutex,&deadline)!=0)break;}
    bool ok=h->barrier_done&&h->barrier_success&&!atomic_load(&h->closing);pthread_mutex_unlock(&h->mutex);return ok;
}
void td_native_worker_busy(void *handle,bool busy){TDHandle *h=handle;atomic_store(&h->busy,busy);if(busy)atomic_store(&h->needs_barrier,false);}
bool td_native_is_busy(void *handle){return atomic_load(&((TDHandle *)handle)->busy);}
void td_native_replaying(void *handle,bool replaying){
    TDHandle *h=handle;atomic_store(&h->replaying,replaying);
    TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;
    v.hidden=replaying||!h->desired_visible||!h->has_rect;h->visibility_dirty=true;
}
int td_native_rect(void *handle,double x,double y,double w,double height,double scale,uint16_t *cols,uint16_t *rows) {
    TDHandle *h=handle;if(!h||atomic_load(&h->busy)||!NSThread.isMainThread)return false;
    TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;NSView *parent=v.superview;if(!parent)return false;
    if(w==0||height==0){h->has_rect=false;h->visibility_dirty=true;v.hidden=YES;*cols=2;*rows=1;return true;}
    uint32_t width_px=(uint32_t)llround(w*scale),height_px=(uint32_t)llround(height*scale);
    if(!td_ghostty_size_valid(h->surface,width_px,height_px,scale))return false;
    if(!td_ghostty_resize_checked(h->surface,width_px,height_px,scale))return -1;
    ghostty_surface_size_s size=ghostty_surface_size(h->surface);*cols=size.columns;*rows=size.rows;
    NSRect bounds=parent.bounds;
    CGFloat top=parent.isFlipped ? bounds.origin.y+y : NSMaxY(bounds)-y-height;
    v.frame=NSMakeRect(bounds.origin.x+x,top,w,height);
    h->scale=scale;v.layer.contentsScale=scale;h->has_rect=true;h->visibility_dirty=true;v.hidden=!h->desired_visible||atomic_load(&h->replaying);
    if(!h->first_rect_geometry_valid)h->first_rect_geometry_valid=td_native_geometry(h,0,h->first_rect_geometry);
    return true;
}
bool td_native_replay_size(void *handle,uint32_t w,uint32_t height,double scale,uint16_t cols,uint16_t rows) {
    TDHandle *h=handle;if(!h||!NSThread.isMainThread||atomic_load(&h->busy)||!td_ghostty_resize_checked(h->surface,w,height,scale))return false;
    ghostty_surface_size_s size=ghostty_surface_size(h->surface);
    if(size.columns!=cols||size.rows!=rows)return false;
    TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;
    [v setFrameSize:NSMakeSize(w/scale,height/scale)];h->scale=scale;v.layer.contentsScale=scale;return true;
}
void td_native_dimensions(void *handle,uint32_t *w,uint32_t *height,double *scale,uint16_t *cols,uint16_t *rows) {
    TDHandle *h=handle;ghostty_surface_size_s size=ghostty_surface_size(h->surface);
    *w=size.width_px;*height=size.height_px;*scale=h->scale;*cols=size.columns;*rows=size.rows;
}
void td_native_render_stats(void *handle,uint64_t *attempts,uint64_t *submissions) {
    td_ghostty_render_stats(((TDHandle *)handle)->surface,attempts,submissions);
}
bool td_native_geometry(void *handle,uint32_t phase,double values[16]) {
    TDHandle *h=handle;if(!h||!values||!NSThread.isMainThread||!h->surface||phase>2)return false;
    if(phase){if(phase==1&&!h->created_geometry_valid)return false;if(phase==2&&!h->first_rect_geometry_valid)return false;memcpy(values,phase==1?h->created_geometry:h->first_rect_geometry,16*sizeof(double));return true;}
    TDGhosttyView *view=(__bridge TDGhosttyView *)h->retained_view;ghostty_surface_size_s size=ghostty_surface_size(h->surface);CALayer *layer=view.layer;
    float points=0;ghostty_config_get(h->config,&points,"font-size",9);
    double result[16]={size.width_px,size.height_px,size.cell_width_px,size.cell_height_px,size.columns,size.rows,h->scale,view.bounds.size.width,view.bounds.size.height,layer.bounds.size.width,layer.bounds.size.height,layer.contentsScale,view.window.backingScaleFactor,view.wantsLayer?1:0,h->initial_font_points,points};
    memcpy(values,result,sizeof(result));return true;
}
bool td_native_window_geometry(void *wk_view,double values[32]) {
    if(!wk_view||!values||!NSThread.isMainThread)return false;NSView *view=(__bridge NSView *)wk_view;NSWindow *window=view.window;if(!window)return false;
    memset(values,0,32*sizeof(double));values[0]=view.bounds.size.width;values[1]=view.bounds.size.height;values[2]=view.isFlipped?1:0;values[3]=window.backingScaleFactor;
    NSWindowButton types[3]={NSWindowCloseButton,NSWindowMiniaturizeButton,NSWindowZoomButton};
    for(size_t i=0;i<3;i++){NSButton *button=[window standardWindowButton:types[i]];if(!button)continue;values[28]+=(double)(1u<<i);NSRect frame=button.frame,rect=[view convertRect:button.bounds fromView:button];double *out=values+4+i*8;out[0]=frame.origin.x;out[1]=frame.origin.y;out[2]=frame.size.width;out[3]=frame.size.height;out[4]=rect.origin.x;out[5]=view.isFlipped?rect.origin.y:NSHeight(view.bounds)-NSMaxY(rect);out[6]=NSMidX(rect);out[7]=view.isFlipped?NSMidY(rect):NSHeight(view.bounds)-NSMidY(rect);}
    values[29]=(window.styleMask&NSWindowStyleMaskFullScreen)?1:0;values[30]=window.frame.size.width;values[31]=window.frame.size.height;return true;
}
bool td_native_palette(void *handle,const char *text) {
    TDHandle *h=handle;if(!h||atomic_load(&h->busy))return false;
    ghostty_config_t config=ghostty_config_new();if(!config)return false;
    ghostty_config_load_string(config,text,strlen(text));ghostty_config_finalize(config);
    if(ghostty_config_diagnostics_count(config)){ghostty_config_free(config);return false;}
    if(!td_ghostty_update_config(h->surface,config)){ghostty_config_free(config);return false;}
    ghostty_config_free(h->config);h->config=config;return true;
}
void td_native_focus(void *handle) {TDHandle *h=handle;h->desired_focus=true;h->focus_dirty=true;}
void td_native_policy(void *handle,bool tmux) {((TDHandle *)handle)->tmux_scroll=tmux;}
void td_native_history(void *handle,uint32_t history) {td_ghostty_history(((TDHandle *)handle)->surface,history);}
bool td_native_bind_webview(void *handle,void *wk_view) {
    if(!NSThread.isMainThread||!handle||!wk_view)return false;
    TDHandle *h=handle;TDGhosttyView *view=(__bridge TDGhosttyView *)h->retained_view;
    NSView *wk=(__bridge NSView *)wk_view;Class wkClass=NSClassFromString(@"WKWebView");
    if(!wkClass||![wk isKindOfClass:wkClass]||!view.window||wk.window!=view.window||!view.superview||wk.superview!=view.superview)return false;
    view.inputWebview=wk;return true;
}
static void reportActualFocus(TDHandle *h,TDGhosttyView *v,bool confirm) {
    bool focused=v.window&&v.window.firstResponder==v&&v.window.isKeyWindow&&!v.hidden;
    if(confirm||focused!=h->reported_focus){h->reported_focus=focused;emit(h,22,NULL,0,focused?1:0,++h->focus_revision);}
}
static bool releaseNativeResponder(TDGhosttyView *view) {
    NSWindow *window=view.window;if(!window||window.firstResponder!=view)return true;
    NSView *wk=view.inputWebview;
    if(!wk||wk.window!=window||!view.superview||wk.superview!=view.superview)return false;
    if(![window makeFirstResponder:wk])return false;
    NSResponder *actual=window.firstResponder;
    return actual==wk||([actual isKindOfClass:NSView.class]&&[(NSView *)actual isDescendantOf:wk]);
}
bool td_native_blur(void *handle) {
    TDHandle *h=handle;TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;
    [v cancelComposition];h->desired_focus=false;h->focus_dirty=true;
    bool released=releaseNativeResponder(v);reportActualFocus(h,v,true);return released;
}
bool td_native_action(void *handle,const char *action,size_t len) {
    return ghostty_surface_binding_action(((TDHandle *)handle)->surface,action,len);
}
void td_native_text(void *handle,const uint8_t *text,size_t len) {
    ghostty_surface_text(((TDHandle *)handle)->surface,(const char *)text,len);
}
int td_native_read_text(void *handle,bool selection) {
    TDHandle *h=handle;ghostty_text_s text={0};
    bool ok=selection&&ghostty_surface_read_selection(h->surface,&text);
    if(!ok){
        ghostty_selection_s range={.top_left={.tag=GHOSTTY_POINT_VIEWPORT,.coord=GHOSTTY_POINT_COORD_TOP_LEFT},.bottom_right={.tag=GHOSTTY_POINT_VIEWPORT,.coord=GHOSTTY_POINT_COORD_BOTTOM_RIGHT},.rectangle=false};
        ok=ghostty_surface_read_text(h->surface,range,&text);
    }
    if(!ok)return 0;
    int status=text.text_len>262144?3:text.text_len==0?2:1;
    if(status==1)emit(h,2,text.text,text.text_len,0,0);
    ghostty_surface_free_text(h->surface,&text);return status;
}
uint32_t td_native_attachment(void *handle,void *wk_view) {
    if(!NSThread.isMainThread)return 0;
    TDHandle *h=handle;NSView *view=(__bridge NSView *)h->retained_view,*wk=(__bridge NSView *)wk_view;
    if(!view.superview||view.superview!=wk.superview||!view.window||view.window!=wk.window)return 0;
    NSArray *siblings=view.superview.subviews;
    NSUInteger nativeIndex=[siblings indexOfObjectIdenticalTo:view],wkIndex=[siblings indexOfObjectIdenticalTo:wk];
    if(nativeIndex==NSNotFound||wkIndex==NSNotFound||nativeIndex<=wkIndex)return 0;
    return 1u|(view.hidden?2u:0u)|(atomic_load(&h->replaying)?4u:0u)|(view.window.firstResponder==view?8u:0u);
}
void td_native_cursor(void *handle,uint32_t *x,uint32_t *y) {
    td_ghostty_cursor(((TDHandle *)handle)->surface,x,y);
}
bool td_native_clip(void *handle,const double *rects,size_t count) {
    if(count>8192)return false;
    TDHandle *h=handle;TDGhosttyView *view=(__bridge TDGhosttyView *)h->retained_view;
    NSMutableArray<NSValue *> *holes=[NSMutableArray array];CGMutablePathRef path=CGPathCreateMutable();
    CGPathAddRect(path,NULL,NSRectToCGRect(view.bounds));
    for(size_t i=0;i<count;i++){
        const double *r=rects+4*i;
        if(!isfinite(r[0])||!isfinite(r[1])||!isfinite(r[2])||!isfinite(r[3])||r[2]<0||r[3]<0){CGPathRelease(path);return false;}
        NSRect rect=NSIntersectionRect(view.bounds,NSMakeRect(r[0],r[1],r[2],r[3]));
        if(!NSIsEmptyRect(rect)){[holes addObject:[NSValue valueWithRect:rect]];CGPathAddRect(path,NULL,NSRectToCGRect(rect));}
    }
    if(count){CAShapeLayer *mask=[CAShapeLayer layer];mask.frame=view.bounds;mask.path=path;mask.fillRule=kCAFillRuleEvenOdd;view.layer.mask=mask;}else view.layer.mask=nil;
    view.clipHoles=holes;CGPathRelease(path);return true;
}
// Presentation is independent of the IO/parser barrier. Keep the last Metal
// contents attached while the engine catches up; never call Ghostty here.
int td_native_present_layout(void *handle,double x,double y,double w,double height,const double *rects,size_t count,bool visible) {
    TDHandle *h=handle;
    if(!h||!NSThread.isMainThread||!h->has_rect||atomic_load(&h->replaying)||count>8192)return 0;
    TDGhosttyView *view=(__bridge TDGhosttyView *)h->retained_view;
    NSView *parent=view.superview;if(!parent)return 0;
    if(!isfinite(x)||!isfinite(y)||!isfinite(w)||!isfinite(height)||w<=0||height<=0||w>32768||height>32768)return 0;
    for(size_t i=0;i<count;i++)if(!isfinite(rects[4*i])||!isfinite(rects[4*i+1])||!isfinite(rects[4*i+2])||!isfinite(rects[4*i+3])||rects[4*i+2]<0||rects[4*i+3]<0)return 0;
    NSRect bounds=parent.bounds;CGFloat top=parent.isFlipped?bounds.origin.y+y:NSMaxY(bounds)-y-height;
    [CATransaction begin];[CATransaction setDisableActions:YES];
    view.frame=NSMakeRect(bounds.origin.x+x,top,w,height);
    bool clipped=td_native_clip(handle,rects,count);
    if(clipped){h->desired_visible=visible;h->visibility_dirty=true;view.hidden=!visible;}
    else {h->desired_visible=false;h->visibility_dirty=true;view.hidden=YES;}
    [CATransaction commit];return clipped;
}
int td_native_layout(void *handle,double x,double y,double w,double height,double scale,const double *rects,size_t count,bool resize,bool visible,uint16_t *cols,uint16_t *rows) {
    TDHandle *h=handle;if(!h||!NSThread.isMainThread||!cols||!rows||count>8192)return 0;
    TDGhosttyView *view=(__bridge TDGhosttyView *)h->retained_view;
    [CATransaction begin];[CATransaction setDisableActions:YES];
    int result=1;
    if(resize){result=td_native_rect(handle,x,y,w,height,scale,cols,rows);}
    else {
        *cols=0;*rows=0;
        NSView *parent=view.superview;if(!parent)result=0;
        else {NSRect bounds=parent.bounds;CGFloat top=parent.isFlipped?bounds.origin.y+y:NSMaxY(bounds)-y-height;view.frame=NSMakeRect(bounds.origin.x+x,top,w,height);}
    }
    if(result>0&&!td_native_clip(handle,rects,count))result=0;
    if(result>0){h->desired_visible=visible;h->visibility_dirty=true;view.hidden=!visible||!h->has_rect||atomic_load(&h->replaying);}
    else {h->desired_visible=false;h->visibility_dirty=true;view.hidden=YES;}
    [CATransaction commit];return result;
}
bool td_native_visible(void *handle,bool visible) {
    TDHandle *h=handle;TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;
    h->desired_visible=visible;h->visibility_dirty=true;v.hidden=!visible||!h->has_rect||atomic_load(&h->replaying);
    if(!visible)[v cancelComposition];
    bool released=visible||releaseNativeResponder(v);reportActualFocus(h,v,true);return released;
}
int td_native_pump(void *handle) {
    TDHandle *h=handle;if(!h)return 0;
    if(atomic_load(&h->busy))return atomic_exchange(&h->needs_barrier,false)?1:0;
    TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;
    int work=0;
    // A cancelled composition must clear before any queued input can run.
    if(h->preedit_state){[v flushPreedit];work=1;}
    if(h->visibility_dirty){
        h->visibility_dirty=false;ghostty_surface_set_occlusion(h->surface,h->desired_visible&&!v.hidden&&((v.window.occlusionState&NSWindowOcclusionStateVisible)!=0));
        if(!h->desired_visible){h->desired_focus=false;h->focus_dirty=true;}
        work=1;
    }
    bool focusConfirmation=h->focus_dirty;
    if(h->focus_dirty){
        h->focus_dirty=false;
        if(h->desired_focus&&h->desired_visible)[v.window makeFirstResponder:v];
        bool focused=h->desired_focus&&h->desired_visible&&!v.hidden&&v.window.isKeyWindow;
        ghostty_app_set_focus(h->app,focused);ghostty_surface_set_focus(h->surface,focused);work=1;
    }
    if(atomic_exchange(&h->wakeup,false)){ghostty_app_tick(h->app);work=1;}
    // Interpreted keys/text and pointer events wait while a feed owns the engine.
    if(!atomic_load(&h->replaying)&&v.pending.count&&canInput(h)){
        id item=v.pending.firstObject;[v.pending removeObjectAtIndex:0];
        if([item isKindOfClass:TDInterpretedKey.class]){
            v.pendingBytes-=((TDInterpretedKey *)item).byteCount;
            [v dispatchKey:item];
        }else if([item isKindOfClass:NSString.class]){
            v.pendingBytes-=[item lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
            atomic_store(&h->busy,true);atomic_store(&h->needs_barrier,true);emit(h,16,NULL,0,0,0);
            const char *text=[item UTF8String];ghostty_surface_text(h->surface,text,strlen(text));
        }else{
            NSEvent *event=item;
            if(event.type==NSEventTypeKeyDown||event.type==NSEventTypeKeyUp)
                v.pendingBytes-=[event.characters lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
            [v dispatchEvent:event];
        }
        work=1;
    }
    // Report actual AppKit ownership, never an accepted focus intent.
    reportActualFocus(h,v,focusConfirmation);
    if(h->preedit_state){[v flushPreedit];work=1;}
    if(!atomic_load(&h->busy)){
        double x=0,y=0,w=0,height=0;
        ghostty_surface_ime_point(h->surface,&x,&y,&w,&height);
        v.imeRect=NSMakeRect(x,y,w,height);
    }
    return work;
}
int td_native_snapshot(void *handle,uint8_t *bytes,size_t cap,size_t *len){return td_ghostty_snapshot(((TDHandle *)handle)->surface,bytes,cap,len);}
bool td_native_snapshot_finish(void *handle,const uint8_t *bytes,size_t len){return td_ghostty_snapshot_finish(((TDHandle *)handle)->surface,bytes,len);}
void td_native_flush_sync(void *handle){td_ghostty_flush_sync(((TDHandle *)handle)->surface);}
size_t td_native_viewport(void *handle){return td_ghostty_viewport(((TDHandle *)handle)->surface);}
bool td_native_restore_viewport(void *handle,size_t offset){return td_ghostty_restore_viewport(((TDHandle *)handle)->surface,offset);}
int td_native_search(void *handle,const char *needle,size_t len,int direction,intptr_t *total,intptr_t *selected) {
    TDHandle *h=handle;ghostty_search_result_s result;
    switch(direction){case 0:result=ghostty_surface_search_start(h->surface,needle,len);break;
        case 1:result=ghostty_surface_search_next(h->surface);break;case -1:result=ghostty_surface_search_prev(h->surface);break;
        case 2:ghostty_surface_search_end(h->surface);*total=0;*selected=-1;return 1;default:return 0;}
    *total=result.total;*selected=result.selected;return result.success;
}
@implementation TDGhosttyView
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    if(self.window){
        for(NSString *name in @[NSWindowDidBecomeKeyNotification,NSWindowDidResignKeyNotification,NSWindowDidChangeOcclusionStateNotification])
            [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(windowChanged:) name:name object:self.window];
    }
    if(self.host){self.host->visibility_dirty=true;self.host->focus_dirty=true;}
}
- (void)windowChanged:(NSNotification *)notification {
    if([notification.name isEqualToString:NSWindowDidResignKeyNotification])[self cancelComposition];
    if(self.host){self.host->visibility_dirty=true;self.host->focus_dirty=true;}
}
- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    // Engine DPI changes only through the validated resize/replay path. Do not
    // advance the layer independently while that geometry/barrier is pending.
    if(self.host&&!atomic_load(&self.host->busy)&&self.window.backingScaleFactor==self.host->scale)self.layer.contentsScale=self.host->scale;
    if(self.host)emit(self.host,8,NULL,0,0,0);
}
- (void)dealloc {[NSNotificationCenter.defaultCenter removeObserver:self];}
- (BOOL)isFlipped{return YES;}
- (BOOL)acceptsFirstResponder{return YES;}
- (BOOL)becomeFirstResponder {if(self.host){self.host->desired_focus=true;self.host->focus_dirty=true;emit(self.host,16,NULL,0,0,0);}return YES;}
- (BOOL)resignFirstResponder {
    // Do not enter Ghostty while the feed worker owns terminal state.
    if(self.host){self.host->desired_focus=false;self.host->focus_dirty=true;self.host->visibility_dirty=true;}
    [self cancelComposition];return YES;
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas];if(self.tracking)[self removeTrackingArea:self.tracking];
    self.tracking=[[NSTrackingArea alloc]initWithRect:NSZeroRect options:NSTrackingInVisibleRect|NSTrackingActiveInKeyWindow|NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited owner:self userInfo:nil];
    [self addTrackingArea:self.tracking];
}
- (void)queue:(NSEvent *)event {
    if(!self.host||atomic_load(&self.host->replaying))return;
    if(self.pending.count>=4096){emit(self.host,5,NULL,0,0,0);NSBeep();return;}
    // Text fields of NSEvent are limited to 256KiB before retaining them.
    size_t bytes=0;
    if(event.type==NSEventTypeKeyDown||event.type==NSEventTypeKeyUp)
        bytes=[event.characters lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if(bytes>262144||self.pendingBytes+bytes>1048576){emit(self.host,5,NULL,0,0,0);NSBeep();return;}
    self.pendingBytes+=bytes;
    [self.pending addObject:event];
    emit(self.host,16,NULL,0,0,0);
}
- (void)copy:(id)sender {
    (void)sender;TDHandle *h=self.host;if(!h||!h->surface||atomic_load(&h->busy))return;
    if(!ghostty_surface_has_selection(h->surface)){if(h->tmux_scroll)emit(h,11,(const uint8_t *)"c",1,8,8);return;}
    ghostty_text_s text={0};
    if(!ghostty_surface_read_selection(h->surface,&text)){emit(h,21,NULL,0,2,0);return;}
    int status=td_write_clipboard_selection(NSPasteboard.generalPasteboard,(const uint8_t *)text.text,text.text_len);
    if(status>0&&status<4)emit(h,21,NULL,0,status,0);
    else if(status==0)emit(h,2,text.text,text.text_len,0,0);
    ghostty_surface_free_text(h->surface,&text);
}
- (void)paste:(id)sender {(void)sender;if(self.host)emit(self.host,12,NULL,0,0,0);}
- (void)selectAll:(id)sender {(void)sender;if(self.host&&!atomic_load(&self.host->busy))ghostty_surface_binding_action(self.host->surface,"select_all",10);}
- (void)keyDown:(NSEvent *)event {
    TDHandle *h=self.host;if(!h||atomic_load(&h->replaying))return;
    if(h->keyboard_fixture){uint64_t *v=h->keyboard_stages;v[0]++;v[16]=event.characters.length;unichar c=event.characters.length?[event.characters characterAtIndex:0]:0;v[17]=!event.characters.length?0:c<32||c==127?1:c>=0xf700&&c<=0xf8ff?3:c<127?2:4;v[18]=modifiers(event.modifierFlags);}
    unsigned mods=modifiers(event.modifierFlags)&15;
    NSString *plain=[event charactersByApplyingModifiers:0]?:event.charactersIgnoringModifiers?:@"";
    bool shortcut=(mods&GHOSTTY_MODS_SUPER)||(mods==GHOSTTY_MODS_CTRL&&[plain.lowercaseString isEqualToString:@"k"]);
    if(shortcut){
        if(self.hasMarkedText){td_shortcut_down(h->shortcut_keys,event.keyCode,true,event.isARepeat);[self interpretKeyEvents:@[event]];return;}
        [self queue:event];return;
    }
    if(self.pending.count>=4096||[event.characters lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>262144){emit(h,5,NULL,0,0,0);NSBeep();return;}
    uint64_t generation=self.compositionGeneration;bool wasMarked=self.hasMarkedText;
    self.accumulator=[NSMutableArray array];self.interpreting=true;
    // Never defer interpretKeyEvents to the engine pump: input methods inspect
    // NSApp.currentEvent and use this synchronous responder transaction for
    // space-to-select, dead keys, candidate navigation and dictation.
    NSEvent *translation=event;
    if(self.optionAsAlt&&(event.modifierFlags&NSEventModifierFlagOption)){
        NSEventModifierFlags flags=event.modifierFlags&~NSEventModifierFlagOption;
        translation=[NSEvent keyEventWithType:event.type location:event.locationInWindow modifierFlags:flags timestamp:event.timestamp windowNumber:event.windowNumber context:nil characters:[event charactersByApplyingModifiers:flags]?:@"" charactersIgnoringModifiers:event.charactersIgnoringModifiers?:@"" isARepeat:event.isARepeat keyCode:event.keyCode];
    }
    if(h->keyboard_fixture)h->keyboard_stages[2]++;
    @try{[self interpretKeyEvents:@[translation?:event]];}@finally{self.interpreting=false;}
    if(h->keyboard_fixture)h->keyboard_stages[12]=self.marked.length;
    if(generation!=self.compositionGeneration){if(h->keyboard_fixture)h->keyboard_stages[11]++;self.accumulator=nil;return;}
    TDInterpretedKey *key=[TDInterpretedKey new];key.event=event;
    key.composing=self.hasMarkedText||wasMarked;
    key.text=self.accumulator.count?[self.accumulator copy]:@[(translation.characters?:@"").copy];
    // A committed candidate is text, even though this key started in preedit.
    if(self.accumulator.count)key.composing=false;
    self.accumulator=nil;
    key.byteCount=[event.characters lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    for(NSString *text in key.text)key.byteCount+=[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if(key.byteCount>1048576||self.pendingBytes+key.byteCount>1048576){[self cancelComposition];emit(h,5,NULL,0,0,0);NSBeep();return;}
    self.pendingBytes+=key.byteCount;[self.pending addObject:key];
    [self syncPreedit];emit(h,16,NULL,0,0,0);
}
- (void)dispatchKey:(TDInterpretedKey *)key {
    if(self.host->keyboard_fixture)self.host->keyboard_stages[1]++;
    // Captured shortcut repeats must remain captured until their key-up.
    if(td_shortcut_down(self.host->shortcut_keys,key.event.keyCode,false,key.event.isARepeat))return;
    ghostty_input_action_e action=key.event.isARepeat?GHOSTTY_ACTION_REPEAT:GHOSTTY_ACTION_PRESS;
    for(NSString *text in key.text)[self sendKey:key.event action:action text:text composing:key.composing];
}
- (void)keyUp:(NSEvent *)event{[self queue:event];}
- (void)flagsChanged:(NSEvent *)event{[self queue:event];}
- (void)mouseDown:(NSEvent *)event{[self.window makeFirstResponder:self];[self queue:event];}
- (void)mouseUp:(NSEvent *)event{[self queue:event];}
- (void)mouseDragged:(NSEvent *)event{[self queue:event];}
- (void)rightMouseDown:(NSEvent *)event{[self queue:event];}
- (void)rightMouseUp:(NSEvent *)event{[self queue:event];}
- (void)otherMouseDown:(NSEvent *)event{[self queue:event];}
- (void)otherMouseUp:(NSEvent *)event{[self queue:event];}
- (void)mouseMoved:(NSEvent *)event{[self queue:event];}
- (void)scrollWheel:(NSEvent *)event{[self queue:event];}
- (NSView *)hitTest:(NSPoint)point {
    NSPoint local=[self convertPoint:point fromView:self.superview];
    for(NSValue *hole in self.clipHoles)if(NSPointInRect(local,hole.rectValue))return nil;
    return [super hitTest:point];
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if(self.window.firstResponder!=self)return NO;
    // Keep font +/-/0 in the focused session. AppKit's zoom menu otherwise
    // consumes '-' and '0', while shifted '+' can reach a different path.
    unsigned mods=modifiers(event.modifierFlags)&15;
    NSString *plain=[event charactersByApplyingModifiers:0]?:event.charactersIgnoringModifiers?:@"";
    bool font=(mods==GHOSTTY_MODS_SUPER||mods==(GHOSTTY_MODS_SUPER|GHOSTTY_MODS_SHIFT))
        &&([plain isEqualToString:@"+"]||[plain isEqualToString:@"="]
            ||(mods==GHOSTTY_MODS_SUPER&&([plain isEqualToString:@"-"]||[plain isEqualToString:@"0"])));
    if(font){[self keyDown:event];return YES;}
    if(event.modifierFlags&NSEventModifierFlagCommand){if([NSApp.mainMenu performKeyEquivalent:event]){if(self.host)td_shortcut_down(self.host->shortcut_keys,event.keyCode,true,event.isARepeat);return YES;}[self queue:event];return YES;}return NO;
}
- (void)sendKey:(NSEvent *)event action:(ghostty_input_action_e)action text:(NSString *)text composing:(bool)composing {
    ghostty_input_key_s key={0};key.action=action;key.mods=modifiers(event.modifierFlags);key.keycode=event.keyCode;
    key.composing=composing;
    // Match the pinned Ghostty AppKit host: let the engine encode control and
    // function-key characters instead of treating them as committed Unicode.
    unichar first=text.length?[text characterAtIndex:0]:0;
    key.text=(first>=0x20 && !(first>=0xf700&&first<=0xf8ff))?text.UTF8String:NULL;
    if(event.type==NSEventTypeKeyDown||event.type==NSEventTypeKeyUp){
        NSString *plain=[event charactersByApplyingModifiers:0];
        if(plain.length){uint32_t cp=[plain characterAtIndex:0];
            if(cp>=0xd800&&cp<=0xdbff&&plain.length>1){uint32_t low=[plain characterAtIndex:1];if(low>=0xdc00&&low<=0xdfff)cp=0x10000+((cp-0xd800)<<10)+(low-0xdc00);}
            key.unshifted_codepoint=cp;
        }
    }
    ghostty_input_mods_e translated=ghostty_surface_key_translation_mods(self.host->surface,key.mods);
    key.consumed_mods=(ghostty_input_mods_e)(translated&~(GHOSTTY_MODS_CTRL|GHOSTTY_MODS_SUPER));
    bool consumed=ghostty_surface_key(self.host->surface,key);
    if(self.host->keyboard_fixture){uint64_t *stages=self.host->keyboard_stages;stages[6]++;stages[7]+=key.text!=NULL;stages[8]+=key.text?strlen(key.text):0;stages[9]+=key.composing;stages[10]+=consumed;}
}
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    TDHandle *h=self.host;
    if(!h||!h->surface||self.hidden||!self.window)return NSDragOperationNone;
    NSDictionary *options=@{NSPasteboardURLReadingFileURLsOnlyKey:@YES};
    return [sender.draggingPasteboard canReadObjectForClasses:@[NSURL.class] options:options]
        ? NSDragOperationCopy : NSDragOperationNone;
}
- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    TDHandle *h=self.host;
    if(!h||!h->surface||self.hidden||!self.window)return NO;
    NSArray *objects=[sender.draggingPasteboard readObjectsForClasses:@[NSURL.class]
        options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
    if(!objects.count||objects.count>50)return NO;
    NSMutableArray<NSString *> *paths=[NSMutableArray arrayWithCapacity:objects.count];
    for(id object in objects){
        if(![object isKindOfClass:NSURL.class])return NO;
        NSURL *url=(NSURL *)object;
        if(!url.isFileURL||!url.path.isAbsolutePath)return NO;
        [paths addObject:url.path];
    }
    NSError *error=nil;
    NSData *json=[NSJSONSerialization dataWithJSONObject:paths options:0 error:&error];
    if(!json||json.length>262144||error)return NO;
    // This callback is queued to the owning NativePanel. Its Rust view key
    // selects the React terminal, independent of Retina scale and split layout.
    if(!emit(h,20,json.bytes,json.length,0,0))return NO;
    [self.window makeFirstResponder:self];
    return YES;
}
- (void)dispatchEvent:(NSEvent *)event {
    TDHandle *h=self.host;if(!h||!h->surface)return;
    if(event.type==NSEventTypeKeyDown){
        if(h->keyboard_fixture)h->keyboard_stages[1]++;
        bool command=event.modifierFlags&NSEventModifierFlagCommand;
        unsigned shortcutMods=modifiers(event.modifierFlags)&15;
        NSString *plain=[event charactersByApplyingModifiers:0]?:event.charactersIgnoringModifiers?:@"";
        NSString *lower=plain.lowercaseString;
        // Capture also survives modifier release before key-up and repeats.
        bool captured=command||(shortcutMods==GHOSTTY_MODS_CTRL&&[lower isEqualToString:@"k"]);
        if(td_shortcut_down(h->shortcut_keys,event.keyCode,captured,event.isARepeat)&&!captured)return;
        // A composing input must commit/cancel through NSTextInputClient, not
        // bypass the preedit with a page line-edit or local-clear shortcut.
        if(self.hasMarkedText&&(command||(shortcutMods==GHOSTTY_MODS_CTRL&&[lower isEqualToString:@"k"]))){[self interpretKeyEvents:@[event]];return;}
        if(shortcutMods==GHOSTTY_MODS_CTRL&&[lower isEqualToString:@"k"]){
            const char *key=plain.UTF8String;emit(h,11,(const uint8_t *)key,strlen(key),event.keyCode,modifiers(event.modifierFlags));return;
        }
        if(shortcutMods==GHOSTTY_MODS_SUPER&&[lower isEqualToString:@"c"]){
            if(!ghostty_surface_has_selection(h->surface)){
                // tmux paints its own selection; only this explicit Command-C
                // gesture asks the current page to read that session's selection.
                if(h->tmux_scroll)emit(h,11,(const uint8_t *)"c",1,event.keyCode,modifiers(event.modifierFlags));
                return;
            }
            [self copy:nil];return;
        }
        if(command&&!(shortcutMods&(GHOSTTY_MODS_SHIFT|GHOSTTY_MODS_ALT))&&[lower isEqualToString:@"v"]){
            for(NSPasteboardItem *item in NSPasteboard.generalPasteboard.pasteboardItems){
                if(td_clipboard_types_have_movie(item.types)){emit(h,12,NULL,0,0,0);return;}
            }
            if([NSPasteboard.generalPasteboard canReadObjectForClasses:@[NSImage.class,NSURL.class] options:nil]){
                emit(h,12,NULL,0,0,0);return;
            }
            NSString *s=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
            if([s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>262144){emit(h,5,NULL,0,0,0);NSBeep();return;}
            if(s){const char *bytes=s.UTF8String;emit(h,17,bytes,strlen(bytes),0,0);}return;
        }
        if(shortcutMods==GHOSTTY_MODS_SUPER&&[lower isEqualToString:@"f"]){emit(h,6,NULL,0,0,0);return;}
        if(command){
            const char *key=plain.UTF8String;
            emit(h,11,(const uint8_t *)key,strlen(key),event.keyCode,modifiers(event.modifierFlags));return;
        }
        // Ordinary keys were already interpreted synchronously in keyDown.
        return;
    }
    if(event.type==NSEventTypeKeyUp){if(td_shortcut_release(h->shortcut_keys,event.keyCode))return;[self sendKey:event action:GHOSTTY_ACTION_RELEASE text:nil composing:false];return;}
    if(event.type==NSEventTypeFlagsChanged){
        if(self.hasMarkedText||event.keyCode==54||event.keyCode==55)return;
        const uint64_t masks[9]={NSEventModifierFlagCapsLock,
            NX_DEVICELSHIFTKEYMASK,NX_DEVICERSHIFTKEYMASK,
            NX_DEVICELCTLKEYMASK,NX_DEVICERCTLKEYMASK,
            NX_DEVICELALTKEYMASK,NX_DEVICERALTKEYMASK,
            NX_DEVICELCMDKEYMASK,NX_DEVICERCMDKEYMASK};
        int action=td_modifier_action(event.keyCode,event.modifierFlags,masks);
        if(action<0)return;
        [self sendKey:event action:action?GHOSTTY_ACTION_PRESS:GHOSTTY_ACTION_RELEASE text:nil composing:false];return;
    }
    NSPoint p=[self convertPoint:event.locationInWindow fromView:nil];
    ghostty_surface_mouse_pos(h->surface,p.x,p.y,modifiers(event.modifierFlags));
    if(event.type==NSEventTypeScrollWheel){
        // Page owns tmux's forced SGR policy and session font shortcuts. Shell
        // wheel/alternate/mouse tracking remains solely Ghostty's VT policy.
        bool zoom=(event.modifierFlags&(NSEventModifierFlagControl|NSEventModifierFlagCommand))!=0;
        if(zoom||(h->tmux_scroll&&!(event.modifierFlags&NSEventModifierFlagShift))){
            ghostty_surface_size_s size=ghostty_surface_size(h->surface);
            NSDictionary *value=@{@"deltaY":@(-event.scrollingDeltaY),@"x":@(p.x),@"y":@(p.y),@"width":@(self.bounds.size.width),@"height":@(self.bounds.size.height),@"cellHeight":@(size.cell_height_px/h->scale),@"modifiers":@(modifiers(event.modifierFlags)),@"precise":@(event.hasPreciseScrollingDeltas)};
            NSData *json=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
            if(json.length)emit(h,14,json.bytes,json.length,0,0);return;
        }
        int mods=event.hasPreciseScrollingDeltas?1:0;
        // Exact packed ABI documented in Ghostty input/mouse.zig: precision bit
        // and momentum enum at bits 1..3; scale is handled by the engine.
        ghostty_input_mouse_momentum_e momentum=GHOSTTY_MOUSE_MOMENTUM_NONE;
        if(event.momentumPhase&NSEventPhaseBegan)momentum=GHOSTTY_MOUSE_MOMENTUM_BEGAN;
        else if(event.momentumPhase&NSEventPhaseChanged)momentum=GHOSTTY_MOUSE_MOMENTUM_CHANGED;
        else if(event.momentumPhase&NSEventPhaseEnded)momentum=GHOSTTY_MOUSE_MOMENTUM_ENDED;
        else if(event.momentumPhase&NSEventPhaseCancelled)momentum=GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
        mods|=((int)momentum<<1);
        ghostty_surface_mouse_scroll(h->surface,event.scrollingDeltaX,event.scrollingDeltaY,mods);return;
    }
    bool press=event.type==NSEventTypeLeftMouseDown||event.type==NSEventTypeRightMouseDown||event.type==NSEventTypeOtherMouseDown;
    bool release=event.type==NSEventTypeLeftMouseUp||event.type==NSEventTypeRightMouseUp||event.type==NSEventTypeOtherMouseUp;
    if(press)emit(h,15,NULL,0,0,0);
    if(press||release)ghostty_surface_mouse_button(h->surface,press?GHOSTTY_MOUSE_PRESS:GHOSTTY_MOUSE_RELEASE,(ghostty_input_mouse_button_e)(event.buttonNumber+1),modifiers(event.modifierFlags));
    if(event.type==NSEventTypeLeftMouseUp&&(event.modifierFlags&NSEventModifierFlagCommand)){
        ghostty_surface_size_s size=ghostty_surface_size(h->surface);
        if(size.cell_width_px&&size.cell_height_px&&p.x>=0&&p.y>=0){
            uint16_t col=MIN(size.columns-1,(uint32_t)floor(p.x*h->scale/size.cell_width_px));
            uint16_t row=MIN(size.rows-1,(uint32_t)floor(p.y*h->scale/size.cell_height_px));
            uint8_t data[262144];size_t len=0;
            if(td_ghostty_path_hit(h->surface,col,row,data,sizeof(data),&len)&&len<=sizeof(data))emit(h,19,data,len,0,0);
        }
    }
    if(release){ghostty_text_s text={0};if(ghostty_surface_read_selection(h->surface,&text)){if(text.text_len<=262144)emit(h,2,text.text,text.text_len,0,0);else emit(h,21,NULL,0,1,0);ghostty_surface_free_text(h->surface,&text);}else if(ghostty_surface_has_selection(h->surface))emit(h,21,NULL,0,2,0);}
}
- (void)cancelComposition {
    // AppKit cancellation only; never enter Ghostty during an active feed.
    if(self.cancellingComposition)return;
    BOOL hadMarkedText=self.hasMarkedText;
    self.cancellingComposition=true;self.compositionGeneration++;
    // An unfocused view without local preedit has no AppKit composition to
    // discard. Keep cancellation generations and engine preedit invalidation,
    // without creating/consulting its text context while WK owns input.
    if(hadMarkedText)[self.inputContext discardMarkedText];
    self.cancellingComposition=false;
    [self.marked.mutableString setString:@""];
    self.markedSelection=NSMakeRange(NSNotFound,0);
    [self.accumulator removeAllObjects];
    if(self.host)td_preedit_cancel(&self.host->preedit_state);
}
- (void)syncPreedit {
    if(!self.host)return;
    td_preedit_mark(&self.host->preedit_state);
    [self flushPreedit];
    // Dictation can update marked text without any keyDown/pending event.
    emit(self.host,16,NULL,0,0,0);
}
- (void)flushPreedit {
    if(!self.host)return;
    int action=td_preedit_step(&self.host->preedit_state,atomic_load(&self.host->busy));
    if(action==1){ghostty_surface_preedit(self.host->surface,"",0);return;}
    if(action==2){
        const char *s=self.marked.string.UTF8String;
        ghostty_surface_preedit(self.host->surface,s?:"",s?strlen(s):0);
    }
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
    if(self.cancellingComposition)return;
    if(self.host&&self.host->keyboard_fixture)self.host->keyboard_stages[3]++;
    (void)replacement;NSString *s=[value isKindOfClass:NSAttributedString.class]?[value string]:value;
    if(![s isKindOfClass:NSString.class]||!self.host)return;
    // AppKit may lend mutable marked/IME storage. Snapshot before unmarkText
    // clears it, and before the input method can reuse it after this callback.
    if([s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>262144){emit(self.host,5,NULL,0,0,0);return;}
    s=[s copy];
    if(self.host->keyboard_fixture)self.host->keyboard_stages[4]+=[s lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    [self unmarkText];
    if(self.accumulator){if(self.host->keyboard_fixture)self.host->keyboard_stages[5]++;[self.accumulator addObject:s];return;}
    // Asynchronous IME/dictation commits preserve order with interpreted keys.
    // Committed text enters the engine only from the serialized input pump.
    size_t count=[s lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if(self.pending.count>=4096||self.pendingBytes+count>1048576){emit(self.host,5,NULL,0,0,0);NSBeep();return;}
    self.pendingBytes+=count;[self.pending addObject:s];emit(self.host,16,NULL,0,0,0);
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
    if(self.cancellingComposition)return;
    if(self.host&&self.host->keyboard_fixture)self.host->keyboard_stages[3]++;
    (void)replacement;NSString *s=[value isKindOfClass:NSAttributedString.class]?[value string]:value;
    if([s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>262144){emit(self.host,5,NULL,0,0,0);return;}
    self.marked=[[NSMutableAttributedString alloc]initWithString:s?:@""];self.markedSelection=selected;
    if(!self.interpreting)[self syncPreedit];
}
- (void)unmarkText {[self.marked.mutableString setString:@""];if(!self.interpreting)[self syncPreedit];}
- (BOOL)hasMarkedText{return self.marked.length!=0;}
- (NSRange)markedRange{return self.hasMarkedText?NSMakeRange(0,self.marked.length):NSMakeRange(NSNotFound,0);}
- (NSRange)selectedRange{return self.hasMarkedText?self.markedSelection:NSMakeRange(0,0);}
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText{return @[];}
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    if(actual)*actual=range;if(range.location==NSNotFound||NSMaxRange(range)>self.marked.length)return nil;
    return [self.marked attributedSubstringFromRange:range];
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point{(void)point;return NSNotFound;}
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    if(actual)*actual=range;
    // Return cached engine coordinates while IO is busy; never synchronously
    // wait for terminal mutex from an AppKit IME query.
    NSRect r=[self convertRect:self.imeRect toView:nil];return [self.window convertRectToScreen:r];
}
- (void)doCommandBySelector:(SEL)selector{(void)selector;}
@end

// Fixture lifecycle, no subprocess or service access.
void *td_native_demo_window(void){
    if(!NSThread.isMainThread)return NULL;[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,960,640) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Termdock Ghostty fixture";[window center];[window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];return (void *)CFBridgingRetain(window);
}
int td_native_demo_step(void *handle){@autoreleasepool{NSWindow *w=(__bridge NSWindow *)handle;if(!w.visible)return 0;NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.016] inMode:NSDefaultRunLoopMode dequeue:YES];if(event)[NSApp sendEvent:event];[NSApp updateWindows];return 1;}}
void td_native_demo_close(void *handle){NSWindow *w=CFBridgingRelease(handle);[w close];}
void *td_native_demo_parent(void *handle){return (__bridge void *)((__bridge NSWindow *)handle).contentView;}
void td_native_demo_bounds(void *handle,double *w,double *height,double *scale){NSWindow *window=(__bridge NSWindow *)handle;*w=window.contentView.bounds.size.width;*height=window.contentView.bounds.size.height;*scale=window.backingScaleFactor;}

// Fixed owned keyboard fixture only. No IPC, arbitrary keys, OS event posting,
// general pasteboard, local process input or business transport.
void *td_native_keyboard_window(void){
    if(!NSThread.isMainThread)return NULL;[NSApplication sharedApplication];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,640,400) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Owned native keyboard fixture";
    return (void *)CFBridgingRetain(window);
}
static TDGhosttyView *keyboardFixtureView(NSWindow *window){
    if(!window||!NSThread.isMainThread)return nil;
    TDGhosttyView *found=nil;NSMutableArray<NSView *> *queue=[NSMutableArray arrayWithObject:window.contentView];
    for(NSUInteger index=0;index<queue.count;index++){
        NSView *node=queue[index];if([node isKindOfClass:TDGhosttyView.class]){if(found)return nil;found=(TDGhosttyView *)node;}
        if(queue.count+node.subviews.count>64)return nil;[queue addObjectsFromArray:node.subviews];
    }
    return found.host&&found.window==window?found:nil;
}
static bool keyboardCase(void *owned_window,uint32_t which,bool forceResponder){
    if(which>=6)return false;NSWindow *window=(__bridge NSWindow *)owned_window;TDGhosttyView *view=keyboardFixtureView(window);if(!view)return false;
    TDHandle *h=view.host;if(atomic_load(&h->busy)||atomic_load(&h->replaying)||view.pending.count)return false;
    h->keyboard_fixture=true;memset(h->keyboard_stages,0,sizeof(h->keyboard_stages));
    static const unsigned short codes[6]={0,11,0,36,48,51};
    NSString *texts[6]={@"a",@"b",@"A",@"\r",@"\t",@"\x7f"};
    h->keyboard_stages[19]=window.firstResponder==view;
    if(forceResponder&&![window makeFirstResponder:view])return false;
    NSEventModifierFlags mods=which==2?NSEventModifierFlagShift:0;
    for(NSUInteger phase=0;phase<2;phase++){
        NSEvent *event=[NSEvent keyEventWithType:phase?NSEventTypeKeyUp:NSEventTypeKeyDown location:NSMakePoint(4,4) modifierFlags:mods timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:texts[which] charactersIgnoringModifiers:which==2?@"a":texts[which] isARepeat:NO keyCode:codes[which]];
        if(!event)return false;[window sendEvent:event];
    }
    return true;
}
bool td_native_keyboard_case(void *window,uint32_t which){return keyboardCase(window,which,true);}
// Fixed owned comparison actions; these are never ordinary native requests.
bool td_native_keyboard_prepare(void *raw,uint32_t action){
    NSWindow *window=(__bridge NSWindow *)raw;TDGhosttyView *view=keyboardFixtureView(window);if(!view)return false;
    if(action==0)return true;
    if(action==2){[window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];return true;}
    if(action==3)return [window makeFirstResponder:view];
    if(action!=1)return false;
    NSPoint point=[view convertPoint:NSMakePoint(NSMidX(view.bounds),NSMidY(view.bounds)) toView:nil];
    for(NSUInteger phase=0;phase<2;phase++){
        NSEvent *event=[NSEvent mouseEventWithType:phase?NSEventTypeLeftMouseUp:NSEventTypeLeftMouseDown location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:phase?0:1];
        if(!event)return false;[window sendEvent:event];
    }
    return true;
}
bool td_native_keyboard_context(void *raw,uint64_t values[12]){
    if(!NSThread.isMainThread||!values)return false;memset(values,0,12*sizeof(uint64_t));
    NSWindow *window=(__bridge NSWindow *)raw;TDGhosttyView *view=keyboardFixtureView(window);if(!view)return false;
    NSResponder *responder=window.firstResponder;BOOL wk=NO;
    for(Class cls=[responder class];cls;cls=class_getSuperclass(cls))if([NSStringFromClass(cls) hasPrefix:@"WK"]){wk=YES;break;}
    values[0]=NSApp.isActive;values[1]=window.isKeyWindow;values[2]=window.isMainWindow;
    values[3]=responder==view;values[4]=wk;values[5]=responder!=nil&&!wk&&responder!=view;
    values[6]=view.window==window;values[7]=!view.hidden;values[8]=view.host->desired_focus;
    values[9]=view.host->desired_visible;values[10]=view.inputContext!=nil;values[11]=responder!=nil;
    return true;
}
bool td_native_keyboard_app_case(void *window,uint32_t which){return keyboardCase(window,which,false);}
// Exercise the production insertText method with owned mutable IME values.
// No surface, responder, events, clipboard or text input context is touched.
uint32_t td_native_keyboard_commit_snapshot_fixture(void){
    if(!NSThread.isMainThread)return 0;
    uint32_t passed=0;
    for(uint32_t which=0;which<3;which++){@autoreleasepool{
        TDHandle host={0};TDGhosttyView *view=[[TDGhosttyView alloc]initWithFrame:NSZeroRect];
        view.host=&host;view.interpreting=true;view.accumulator=[NSMutableArray array];
        view.marked=[[NSMutableAttributedString alloc]initWithString:which<2?@"a":@""];
        NSMutableString *external=[NSMutableString stringWithString:@"a"];
        id value=which==0?view.marked.mutableString:which==1?(id)view.marked:external;
        [view insertText:value replacementRange:NSMakeRange(NSNotFound,0)];
        if(which==2)[external setString:@""];
        if(view.accumulator.count==1&&[view.accumulator.firstObject isEqualToString:@"a"]&&view.marked.length==0)passed|=1u<<which;
        view.host=NULL;
    }}
    return passed;
}
bool td_native_keyboard_arm(void *owned_window){
    if(!NSThread.isMainThread)return false;
    TDGhosttyView *view=keyboardFixtureView((__bridge NSWindow *)owned_window);if(!view)return false;
    view.host->keyboard_fixture=true;memset(view.host->keyboard_stages,0,sizeof(view.host->keyboard_stages));return true;
}
bool td_native_keyboard_stages(void *owned_window,uint64_t stages[20]){
    TDGhosttyView *view=keyboardFixtureView((__bridge NSWindow *)owned_window);if(!view||!view.host->keyboard_fixture||!stages)return false;
    view.host->keyboard_stages[13]=view.pending.count;view.host->keyboard_stages[14]=atomic_load(&view.host->busy);view.host->keyboard_stages[15]=atomic_load(&view.host->gui_requested);memcpy(stages,view.host->keyboard_stages,20*sizeof(uint64_t));return true;
}
void td_native_keyboard_step(void){@autoreleasepool{[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.001]];}}
