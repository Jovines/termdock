#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <UserNotifications/UserNotifications.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <ImageIO/ImageIO.h>
#import <objc/runtime.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/resource.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <errno.h>
#include <stdio.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>
#include "window_chrome.h"

// Tao's y inset controls a container height, not a button's top edge. Align
// using the actual WK/button conversion, retaining normal horizontal placement.
@interface TDTitlebarAlignment : NSObject
@property(nonatomic,weak) NSView *view;
@property(nonatomic) CGFloat center;
@property(nonatomic) BOOL aligning;
@property(nonatomic) BOOL configuredForAlignment;
@property(nonatomic,strong) NSHashTable<NSView *> *observedViews;
@property(nonatomic,weak) NSWindow *diagnosticWindow;
@property(nonatomic) uint64_t diagnosticOwner, diagnosticDocument;
@property(nonatomic) TDChromeReserve diagnosticReserve;
@property(nonatomic) TDChromeReceive diagnosticReceive;
@property(nonatomic) TDChromeCounts diagnosticCounts;
@property(nonatomic) uint32_t scheduleCount, writeCount, rejectCount, countsSaturated;
- (void)count:(unsigned)kind;
- (void)diagnostic:(uint32_t)phase ticket:(uint64_t)ticket owner:(uint64_t)owner document:(uint64_t)document window:(NSWindow *)window;
- (void)schedule;
- (void)observeView:(NSView *)view;
@end
static char TDTitlebarAlignmentKey;
static void chromeRect(TDWindowChromeSnapshot *p,unsigned index,NSRect rect){
    double v[]={rect.origin.x,rect.origin.y,rect.size.width,rect.size.height};
    for(unsigned i=0;i<4;i++)if(!isfinite(v[i])||fabs(v[i])>1e7)return;
    if(v[2]<0||v[3]<0)return;
    memcpy(p->rects[index],v,sizeof(v));p->present|=(1u<<index);
}
static void chromeButtonRect(TDWindowChromeButton *p,unsigned index,NSRect rect){
    double v[]={rect.origin.x,rect.origin.y,rect.size.width,rect.size.height};
    for(unsigned i=0;i<4;i++)if(!isfinite(v[i])||fabs(v[i])>1e7)return;
    if(v[2]<0||v[3]<0)return;
    memcpy(p->rects[index],v,sizeof(v));p->present|=1u<<index;
}
static void chromeButton(TDWindowChromeButton *p,NSButton *button,NSView *view,NSView *closeParent){
    NSView *parent=button.superview,*grandparent=parent.superview;
    if(!button||!parent||button.window!=view.window)return;
    NSRect wk=[view convertRect:button.bounds fromView:button];
    chromeButtonRect(p,0,wk);chromeButtonRect(p,1,parent.bounds);
    chromeButtonRect(p,2,parent.frame);chromeButtonRect(p,5,button.frame);
    if(grandparent){chromeButtonRect(p,3,[view convertRect:grandparent.bounds fromView:grandparent]);chromeButtonRect(p,4,[grandparent convertRect:grandparent.bounds toView:nil]);}
    double center=view.isFlipped?NSMidY(wk)-NSMinY(view.bounds):NSMaxY(view.bounds)-NSMidY(wk);
    if(isfinite(center)&&fabs(center)<=1e7){p->center_top_wk=center;p->present|=1u<<6;}
    if(parent.isFlipped)p->flags|=1u;if(parent==closeParent)p->flags|=1u<<1;
    if(button.translatesAutoresizingMaskIntoConstraints)p->flags|=1u<<6;
    if(button.constraints.count)p->flags|=1u<<7;
    if(parent.constraints.count)p->flags|=1u<<8;
    NSView *layers[]={parent,grandparent};
    for(unsigned i=0;i<2;i++){
        CALayer *layer=layers[i].layer;if(!layer)continue;
        double width=layer.borderWidth;
        if(isfinite(width)&&width>=0&&width<=1e7){p->border_width[i]=width;p->present|=1u<<(7+i);}
        p->flags|=1u<<(2+i);if(layer.masksToBounds)p->flags|=1u<<(4+i);
        if(layer.backgroundColor){double alpha=CGColorGetAlpha(layer.backgroundColor);if(isfinite(alpha)&&alpha>=0&&alpha<=1){p->background_alpha[i]=alpha;p->present|=1u<<(9+i);}}
    }
}
@implementation TDTitlebarAlignment
- (void)diagnostic:(uint32_t)phase ticket:(uint64_t)ticket owner:(uint64_t)owner document:(uint64_t)document window:(NSWindow *)window {
    NSView *view=self.view;
    if(!ticket||!NSThread.isMainThread||!view||!window||view.window!=window||self.diagnosticWindow!=window||self.diagnosticOwner!=owner||self.diagnosticDocument!=document||!self.diagnosticReceive)return;
    TDWindowChromeSnapshot p={0};p.owner_generation=owner;p.document_generation=document;
    chromeRect(&p,0,window.frame);chromeRect(&p,1,window.contentLayoutRect);
    NSView *content=window.contentView;if(content){chromeRect(&p,2,content.frame);chromeRect(&p,3,content.bounds);chromeRect(&p,6,[view convertRect:view.bounds toView:content]);}
    chromeRect(&p,4,view.frame);chromeRect(&p,5,view.bounds);chromeRect(&p,7,[view convertRect:view.bounds toView:nil]);
    NSButton *button=[window standardWindowButton:NSWindowCloseButton];NSView *container=button.superview.superview;
    if(container){chromeRect(&p,8,container.frame);p.role=container==content?1:2;if(container.layer){p.present|=1u<<11;if(container.layer.masksToBounds)p.flags|=1u<<6;}}
    NSWindowButton kinds[]={NSWindowCloseButton,NSWindowMiniaturizeButton,NSWindowZoomButton};
    for(unsigned i=0;i<3;i++)chromeButton(&p.buttons[i],[window standardWindowButton:kinds[i]],view,button.superview);
    double scale=window.backingScaleFactor;if(isfinite(scale)&&scale>=0.5&&scale<=8){p.backing_scale=scale;p.present|=1u<<9;}
    if(window.opaque)p.flags|=1u;if(window.titlebarAppearsTransparent)p.flags|=1u<<1;
    if(window.styleMask&NSWindowStyleMaskFullSizeContentView)p.flags|=1u<<2;if(window.hasShadow)p.flags|=1u<<3;if(view.isFlipped)p.flags|=1u<<4;p.flags|=1u<<5;
    NSEvent *event=NSApp.currentEvent;if(event&&event.type<=1024){p.event_type=(uint32_t)event.type;p.present|=1u<<10;if(event.window==window)p.flags|=1u<<7;}if(NSEvent.pressedMouseButtons&1)p.flags|=1u<<8;
    self.diagnosticReceive(ticket,phase,&p);
}
- (void)count:(unsigned)kind {
    if(!self.diagnosticCounts||!self.diagnosticWindow||self.view.window!=self.diagnosticWindow)return;
    uint32_t value=kind==0?self.scheduleCount:kind==1?self.writeCount:self.rejectCount;
    if(value<65535)value++;else self.countsSaturated=1;
    if(kind==0)self.scheduleCount=value;else if(kind==1)self.writeCount=value;else self.rejectCount=value;
    self.diagnosticCounts(self.diagnosticOwner,self.diagnosticDocument,self.scheduleCount,self.writeCount,self.rejectCount,self.countsSaturated);
}
- (CGFloat)delta {
    NSView *view=self.view;NSWindow *window=view.window;
    if(!window||(window.styleMask&NSWindowStyleMaskFullScreen))return NAN;
    CGFloat maximum=0;NSWindowButton kinds[]={NSWindowCloseButton,NSWindowMiniaturizeButton,NSWindowZoomButton};
    for(unsigned i=0;i<3;i++){
        NSButton *button=[window standardWindowButton:kinds[i]];if(!button.superview||button.window!=window)return NAN;
        NSRect rect=[view convertRect:button.bounds fromView:button];
        CGFloat top=view.isFlipped?NSMidY(rect)-NSMinY(view.bounds):NSMaxY(view.bounds)-NSMidY(rect);
        CGFloat error=self.center-top;if(!isfinite(error))return NAN;maximum=MAX(maximum,fabs(error));
    }
    return maximum;
}
- (void)observeView:(NSView *)view {
    if(!view)return;
    if(!self.observedViews)self.observedViews=[NSHashTable weakObjectsHashTable];
    if([self.observedViews containsObject:view])return;
    [self.observedViews addObject:view];
    view.postsFrameChangedNotifications=YES;view.postsBoundsChangedNotifications=YES;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(changed:) name:NSViewFrameDidChangeNotification object:view];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(changed:) name:NSViewBoundsDidChangeNotification object:view];
}
- (void)changed:(NSNotification *)notification {(void)notification;[self schedule];}
- (void)schedule {
    if(!self.configuredForAlignment||self.aligning)return;
    self.aligning=YES;
    @try {
    NSWindow *observedWindow=self.view.window;
    NSWindowButton observedKinds[]={NSWindowCloseButton,NSWindowMiniaturizeButton,NSWindowZoomButton};
    for(unsigned i=0;i<3;i++){
        NSView *button=[observedWindow standardWindowButton:observedKinds[i]];
        [self observeView:button];[self observeView:button.superview];[self observeView:button.superview.superview];
    }
    // The primary WK view must fill the actual content view throughout zoom,
    // restore and live resize. Never resize the window or titlebar ancestors.
    NSView *view=self.view,*content=view.window.contentView;
    if(content&&view.superview==content&&content.bounds.size.width>0&&content.bounds.size.height>0){
        view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
        if(!NSEqualRects(view.frame,content.bounds))view.frame=content.bounds;
    }
    [self count:0];
    CGFloat delta=[self delta];if(!isfinite(delta)||fabs(delta)<0.25||fabs(delta)>128)return;
    NSWindow *scheduledWindow=self.view.window;
    uint64_t diagnosticOwner=self.diagnosticOwner,diagnosticDocument=self.diagnosticDocument;
    // Run in the geometry notification, before AppKit paints the resize.
    // Deferring this correction by a run-loop turn exposes the system's
    // temporary button frames for one frame on every resize/layout pass.
    {
        CGFloat difference=[self delta];if(!isfinite(difference)||fabs(difference)<0.25||fabs(difference)>128)return;
        NSView *view=self.view;NSWindow *window=view.window;NSWindow *capturedWindow=scheduledWindow;
        if(!window||window!=capturedWindow)return;
        NSWindowButton kinds[]={NSWindowCloseButton,NSWindowMiniaturizeButton,NSWindowZoomButton};
        NSButton *buttons[3];double frames[3][4],bounds[3][4],vectors[3][2],result[3][4];
        for(unsigned i=0;i<3;i++){
            NSButton *button=[window standardWindowButton:kinds[i]];NSView *parent=button.superview;
            if(!parent||button.window!=window)return;buttons[i]=button;
            NSRect wk=[view convertRect:button.bounds fromView:button],frame=button.frame,area=parent.bounds;
            CGFloat top=view.isFlipped?NSMidY(wk)-NSMinY(view.bounds):NSMaxY(view.bounds)-NSMidY(wk);
            CGFloat difference=self.center-top;if(!isfinite(difference)||fabs(difference)>128)return;
            NSPoint actual=NSMakePoint(NSMidX(wk),NSMidY(wk)),target=actual;target.y+=view.isFlipped?difference:-difference;
            NSPoint from=[parent convertPoint:actual fromView:view],to=[parent convertPoint:target fromView:view];
            double f[]={frame.origin.x,frame.origin.y,frame.size.width,frame.size.height},b[]={area.origin.x,area.origin.y,area.size.width,area.size.height};
            memcpy(frames[i],f,sizeof(f));memcpy(bounds[i],b,sizeof(b));vectors[i][0]=to.x-from.x;vectors[i][1]=to.y-from.y;
        }
        if(!td_chrome_button_frames(frames,bounds,vectors,result)){[self count:2];return;}
        uint64_t ticket=0;
        if(capturedWindow&&view.window==capturedWindow&&self.diagnosticWindow==capturedWindow&&self.diagnosticOwner==diagnosticOwner&&self.diagnosticDocument==diagnosticDocument&&self.diagnosticReserve)
            ticket=self.diagnosticReserve(diagnosticOwner,diagnosticDocument,2);
        [self diagnostic:2 ticket:ticket owner:diagnosticOwner document:diagnosticDocument window:capturedWindow];
        [NSAnimationContext beginGrouping];
        NSAnimationContext.currentContext.duration=0;
        NSAnimationContext.currentContext.allowsImplicitAnimation=NO;
        for(unsigned i=0;i<3;i++)buttons[i].frame=NSMakeRect(result[i][0],result[i][1],result[i][2],result[i][3]);
        [NSAnimationContext endGrouping];
        [self count:1];
        [self diagnostic:3 ticket:ticket owner:diagnosticOwner document:diagnosticDocument window:capturedWindow];
    }
    } @finally {self.aligning=NO;}
}
- (void)dealloc {[NSNotificationCenter.defaultCenter removeObserver:self];}
@end
static TDTitlebarAlignment *titlebarAlignment(NSView *view) {
    TDTitlebarAlignment *alignment=objc_getAssociatedObject(view,&TDTitlebarAlignmentKey);
    if(!alignment){alignment=[TDTitlebarAlignment new];alignment.view=view;objc_setAssociatedObject(view,&TDTitlebarAlignmentKey,alignment,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        for(NSString *name in @[NSWindowDidResizeNotification,NSWindowDidExitFullScreenNotification,NSWindowDidChangeBackingPropertiesNotification,NSWindowDidUpdateNotification])
            [NSNotificationCenter.defaultCenter addObserver:alignment selector:@selector(changed:) name:name object:view.window];
        // Wry can apply its own size after the window resize notification.
        // Observe that actual WK frame write too, rather than waiting for the
        // next window update and leaving an uncovered strip during live resize.
        [alignment observeView:view];
        [alignment observeView:view.window.contentView];
    }
    return alignment;
}
void td_preview_window_background(void *wk_view,unsigned char red,unsigned char green,unsigned char blue) {
    if(!NSThread.isMainThread||!wk_view)return;
    WKWebView *view=(__bridge WKWebView *)wk_view;
    if(![view isKindOfClass:WKWebView.class])return;
    NSColor *color=[NSColor colorWithRed:red/255.0 green:green/255.0 blue:blue/255.0 alpha:1];
    view.window.backgroundColor=color;
    if(@available(macOS 12.0,*))view.underPageBackgroundColor=color;
}
void td_preview_align_titlebar(void *wk_view,double center) {
    if(!NSThread.isMainThread||!wk_view||!isfinite(center)||center<8||center>128)return;
    NSView *view=(__bridge NSView *)wk_view;if(!view.window)return;
    TDTitlebarAlignment *alignment=titlebarAlignment(view);
    alignment.center=center;alignment.configuredForAlignment=YES;[alignment schedule];
}

void td_preview_window_chrome(void *wk_view,uint64_t owner,uint64_t document,uint32_t phase,TDChromeReserve reserve,TDChromeReceive receive,TDChromeCounts counts){
    if(!NSThread.isMainThread||!wk_view||!owner||!reserve||!receive)return;
    NSView *view=(__bridge NSView *)wk_view;if(!view.window)return;
    TDTitlebarAlignment *alignment=titlebarAlignment(view);
    if(alignment.diagnosticOwner&&alignment.diagnosticOwner!=owner)return;
    if(alignment.diagnosticWindow&&alignment.diagnosticWindow!=view.window)return;
    alignment.diagnosticOwner=owner;alignment.diagnosticDocument=document;alignment.diagnosticWindow=view.window;alignment.diagnosticReserve=reserve;alignment.diagnosticReceive=receive;alignment.diagnosticCounts=counts;
    if(phase==0||phase==1){uint64_t ticket=reserve(owner,document,1);[alignment diagnostic:phase ticket:ticket owner:owner document:document window:view.window];}
}

typedef void (*TDCallback)(void *, const char *);
static TDCallback clickCallback;
static void *clickContext;
static NSMutableDictionary<NSString *, NSDictionary *> *notificationTargets;
static NSMutableDictionary<NSString *, NSString *> *notificationGenerations;
static NSString *json(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
}
// Notification userInfo is a property list. Optional JSON null fields must
// be omitted so macOS can archive the real target for delivery/cold clicks.
static id propertyList(id value) {
    if (!value || value == [NSNull null]) return nil;
    if ([value isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        for (NSString *key in value) { id clean=propertyList(value[key]); if (clean) result[key]=clean; }
        return result;
    }
    if ([value isKindOfClass:[NSArray class]]) {
        NSMutableArray *result = [NSMutableArray array];
        for (id item in value) {id clean=propertyList(item);if (clean) [result addObject:clean];}
        return result;
    }
    return value;
}
static void result(TDCallback cb, void *ctx, NSDictionary *value) { cb(ctx, json(value).UTF8String); }
@interface TDNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation TDNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    // The Rust process suppresses only notifications from the focused source;
    // other service windows may still need an alert while the app is active.
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *identifier = response.notification.request.identifier;
        NSDictionary *target = notificationTargets[identifier] ?: response.notification.request.content.userInfo;
        if (clickCallback) result(clickCallback, clickContext, target);
        [notificationTargets removeObjectForKey:identifier];
        [notificationGenerations removeObjectForKey:identifier];
        [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
        completion();
    });
}
@end
static TDNotificationDelegate *delegate;
void td_notifications_init(TDCallback cb, void *ctx) {
    clickCallback = cb; clickContext = ctx;
    notificationTargets = [NSMutableDictionary dictionary];
    notificationGenerations = [NSMutableDictionary dictionary];
    delegate = [TDNotificationDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
}
static void confirmDelivery(UNUserNotificationCenter *center, NSString *identifier, NSString *generation, int attempt, TDCallback cb, void *ctx) {
    [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *delivered) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (![notificationGenerations[identifier] isEqualToString:generation]) {
                result(cb, ctx, @{ @"delivered": @NO, @"error": @"Notification replaced before delivery" }); return;
            }
            for (UNNotification *notification in delivered) {
                if ([notification.request.identifier isEqualToString:identifier] && [notification.request.content.userInfo[@"generation"] isEqualToString:generation]) {
                    // The delivered notification retains its own userInfo for
                    // clicks/cold restart; do not keep an unbounded native map.
                    [notificationTargets removeObjectForKey:identifier];
                    [notificationGenerations removeObjectForKey:identifier];
                    result(cb, ctx, @{ @"delivered": @YES, @"identifier": identifier, @"evidence": @"UNUserNotificationCenter.getDeliveredNotifications", @"at": @([[NSDate date] timeIntervalSince1970] * 1000) }); return;
                }
            }
            if (attempt >= 20) {
                [notificationTargets removeObjectForKey:identifier];
                [notificationGenerations removeObjectForKey:identifier];
                [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
                result(cb, ctx, @{ @"delivered": @NO, @"error": @"macOS did not confirm notification delivery" }); return;
            }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ confirmDelivery(center, identifier, generation, attempt + 1, cb, ctx); });
        });
    }];
}
void td_notification_show(const char *raw, TDCallback cb, void *ctx) {
    NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!granted || error) { result(cb, ctx, @{ @"delivered": @NO, @"error": error.localizedDescription ?: @"Notification permission denied" }); return; }
            NSString *identifier = payload[@"identifier"];
            NSString *generation = [NSUUID UUID].UUIDString;
            [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
            [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = payload[@"title"];
            content.body = payload[@"body"] ?: @"";
            if (![payload[@"silent"] boolValue]) content.sound = [UNNotificationSound defaultSound];
            NSMutableDictionary *target = [propertyList(payload) mutableCopy]; target[@"generation"] = generation;
            content.userInfo = target;
            notificationTargets[identifier] = target;
            notificationGenerations[identifier] = generation;
            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
            __weak UNUserNotificationCenter *deliveryCenter = center;
            [center addNotificationRequest:request withCompletionHandler:^(NSError *failure) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    UNUserNotificationCenter *center = deliveryCenter;
                    if (!center) { if ([notificationGenerations[identifier] isEqualToString:generation]) { [notificationTargets removeObjectForKey:identifier]; [notificationGenerations removeObjectForKey:identifier]; } result(cb, ctx, @{ @"delivered": @NO, @"error": @"Notification center unavailable" }); return; }
                    if (failure) { if ([notificationGenerations[identifier] isEqualToString:generation]) { [notificationTargets removeObjectForKey:identifier]; [notificationGenerations removeObjectForKey:identifier]; } result(cb, ctx, @{ @"delivered": @NO, @"error": failure.localizedDescription }); }
                    else confirmDelivery(center, identifier, generation, 0, cb, ctx);
                });
            }];
        });
    }];
}
void td_notification_attention(void) { [NSApp requestUserAttention:NSInformationalRequest]; }
char *td_preview_service_menus(void) {
    if(!NSThread.isMainThread)return NULL;NSMutableArray *menus=[NSMutableArray array];
    for(NSMenuItem *top in NSApp.mainMenu.itemArray)for(NSMenuItem *item in top.submenu.itemArray){
        if(![item.title isEqualToString:@"打开服务"]||!item.submenu)continue;
        if(menus.count==2)return strdup("{\"error\":\"TooManyServiceMenus\"}");
        NSMutableArray *rows=[NSMutableArray array];BOOL truncated=NO;
        for(NSMenuItem *row in item.submenu.itemArray){if(row.separatorItem)continue;if(rows.count==32){truncated=YES;break;}[rows addObject:@{ @"title":row.title?:@"",@"enabled":@(row.enabled) }];}
        [menus addObject:@{ @"items":rows,@"truncated":@(truncated) }];
    }
    NSString *encoded=json(@{ @"mainThread":@YES,@"menus":menus });
    if([encoded lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>16384)return strdup("{\"error\":\"ServiceMenuEvidenceTooLarge\"}");
    return strdup(encoded.UTF8String);
}
bool td_menu_configure(void) {
    // Tauri exposes physical accelerators. Match Electron's logical Cmd+'+'
    // without requiring a numeric keypad or adding Shift to the menu binding.
    for (NSMenuItem *section in NSApp.mainMenu.itemArray) {
        if (![section.title isEqualToString:@"显示"]) continue;
        for (NSMenuItem *item in section.submenu.itemArray) {
            if (![item.title isEqualToString:@"Zoom In"]) continue;
            item.keyEquivalent = @"+";
            item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
            return true;
        }
    }
    return false;
}
void td_panel_configure(void *raw) {
    NSWindow *window = (__bridge NSWindow *)raw;
    window.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
    window.hidesOnDeactivate = NO;
    window.level = NSFloatingWindowLevel;
}
// Fixed diagnostic protocol only; never emit pasteboard text, paths or errors.
static void clipboard_stage(const char *stage) {dprintf(STDERR_FILENO,"TDCP1 stage=%s\n",stage);}
static void clipboard_number(const char *key,uint64_t value) {dprintf(STDERR_FILENO,"TDCP1 %s=%llu\n",key,(unsigned long long)value);}
static bool clipboard_limit_error(void) {clipboard_number("errno",(uint64_t)errno);return false;}
bool td_clipboard_helper_limits(void) {
    // Preserve every existing resource bound; diagnostics only identify failure.
    clipboard_stage("limits-cpu");struct rlimit cpu={8,8};
    if(setrlimit(RLIMIT_CPU,&cpu)!=0)return clipboard_limit_error();clipboard_number("cpu",8);
    clipboard_stage("limits-timer");signal(SIGALRM,SIG_DFL);alarm(10);clipboard_number("alarm",10);
    clipboard_stage("limits-vm");struct mach_task_basic_info info;mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
    if(task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&info,&count)!=KERN_SUCCESS)return false;
    struct rlimit existing;if(getrlimit(RLIMIT_AS,&existing)!=0)return clipboard_limit_error();
    rlim_t limit=info.virtual_size+512ULL*1024*1024;
    if(existing.rlim_max!=RLIM_INFINITY&&existing.rlim_max<limit)limit=existing.rlim_max;
    clipboard_stage("limits-as");struct rlimit addressSpace={limit,limit};
    if(setrlimit(RLIMIT_AS,&addressSpace)!=0)return clipboard_limit_error();
    clipboard_number("as",limit);clipboard_stage("limits-ready");return true;
}
uint64_t td_clipboard_child_rss(int pid) {
    struct proc_taskinfo info;
    int read = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, sizeof(info));
    return read == sizeof(info) ? info.pti_resident_size : 0;
}
static char *clipboard_read_from(NSPasteboard *pasteboard,const char *rawDirectory,bool image) {
    @autoreleasepool {
        NSString *directory = [NSString stringWithUTF8String:rawDirectory];
        if (image) {
            clipboard_stage("types");
            NSData *data = nil;
            for (NSString *type in @[NSPasteboardTypePNG, NSPasteboardTypeTIFF, @"public.jpeg"]) {
                if (![pasteboard.types containsObject:type]) continue;
                clipboard_stage("image-data");data = [pasteboard dataForType:type];
                if (data.length) break;
            }
            CGImageRef decoded = NULL;
            if (data.length) {
                if (data.length > 128 * 1024 * 1024) return strdup(json(@{ @"error": @"Clipboard image input exceeds 128 MiB" }).UTF8String);
                NSDictionary *options = @{ (__bridge NSString *)kCGImageSourceShouldCache: @NO, (__bridge NSString *)kCGImageSourceShouldAllowFloat: @NO };
                CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, (__bridge CFDictionaryRef)options);
                if (!source) return strdup(json(@{ @"error": @"Cannot read clipboard image" }).UTF8String);
                NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
                uint64_t width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedLongLongValue];
                uint64_t height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedLongLongValue];
                // Inspect metadata before decode: preserve the existing 32 MiB RGBA8
                // area limit, with no full RGBA copy or in-memory PNG serialization.
                if (!width || !height || width > (32 * 1024 * 1024 / 4) / height) {
                    CFRelease(source); return strdup(json(@{ @"error": @"Clipboard image exceeds Preview's size limit" }).UTF8String);
                }
                decoded = CGImageSourceCreateImageAtIndex(source, 0, (__bridge CFDictionaryRef)options);
                CFRelease(source);
            } else {
                // NSImage also supports PDF, PICT, and PostScript representations;
                // they have no PNG/TIFF/JPEG bytes for the direct path above.
                NSImage *nativeImage = [[NSImage alloc] initWithPasteboard:pasteboard];
                if (!nativeImage) return strdup(json(@{ @"files": @[] }).UTF8String);
                NSSize size = nativeImage.size;
                uint64_t maxPixels = 32 * 1024 * 1024 / 4;
                if (!(size.width > 0) || !(size.height > 0) || !isfinite(size.width) || !isfinite(size.height)
                    || size.width > (double)maxPixels / size.height) {
                    return strdup(json(@{ @"error": @"Clipboard image exceeds Preview's size limit" }).UTF8String);
                }
                NSRect proposedRect = NSMakeRect(0, 0, size.width, size.height);
                CGImageRef rendered = [nativeImage CGImageForProposedRect:&proposedRect context:nil hints:nil];
                if (rendered) decoded = CGImageRetain(rendered);
            }
            if (!decoded) return strdup(json(@{ @"error": @"Cannot decode clipboard image" }).UTF8String);
            uint64_t decodedWidth = CGImageGetWidth(decoded), decodedHeight = CGImageGetHeight(decoded);
            if (!decodedWidth || !decodedHeight || decodedWidth > (32 * 1024 * 1024 / 4) / decodedHeight) {
                CGImageRelease(decoded);
                return strdup(json(@{ @"error": @"Clipboard image exceeds Preview's size limit" }).UTF8String);
            }
            NSString *name = [NSString stringWithFormat:@"termdock-clipboard-%@.png", [NSUUID UUID].UUIDString];
            NSString *path = [directory stringByAppendingPathComponent:name];
            clipboard_stage("image-destination");
            CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
            BOOL saved = NO;
            clipboard_stage("image-write");
            if (destination) { CGImageDestinationAddImage(destination, decoded, NULL); saved = CGImageDestinationFinalize(destination); CFRelease(destination); }
            CGImageRelease(decoded);
            if (!saved) return strdup(json(@{ @"error": @"Cannot encode clipboard image" }).UTF8String);
            return strdup(json(@{ @"files": @[@{ @"name": name, @"type": @"image/png", @"temporary": path }] }).UTF8String);
        }
        clipboard_stage("files");
        NSMutableArray *files = [NSMutableArray array];
        NSArray<NSURL *> *urls = [pasteboard readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
        if (urls.count > 50) return strdup(json(@{ @"error": @"Choose up to 50 files; none were read" }).UTF8String);
        BOOL movieFile = NO;
        for (NSURL *url in urls) {
            if (!url.isFileURL) continue;
            UTType *type = [UTType typeWithFilenameExtension:url.pathExtension];
            [files addObject:@{ @"path": url.path, @"name": url.lastPathComponent, @"type": type.preferredMIMEType ?: @"application/octet-stream" }];
            movieFile |= [type conformsToType:UTTypeMovie] || [type conformsToType:UTTypeVideo];
        }
        if (!movieFile) {
            int index = 0;
            uint64_t total = 0;
            if (pasteboard.pasteboardItems.count > 50) return strdup(json(@{ @"error": @"Choose up to 50 clipboard items" }).UTF8String);
            for (NSPasteboardItem *item in pasteboard.pasteboardItems) { @autoreleasepool {
                BOOL advertised = NO, saved = NO;
                for (NSString *identifier in item.types) {
                    UTType *type = [identifier hasPrefix:@"video/"] ? [UTType typeWithMIMEType:identifier] : [UTType typeWithIdentifier:identifier];
                    if (![type conformsToType:UTTypeMovie] && ![type conformsToType:UTTypeVideo]) continue;
                    advertised = YES; movieFile = YES;
                    if (files.count >= 50) return strdup(json(@{ @"error": @"TERMDOCK_CLIPBOARD_VIDEO_ERROR:请选择最多50个剪贴板文件" }).UTF8String);
                    NSData *data = [item dataForType:identifier];
                    if (!data.length) continue;
                    if (data.length > 128 * 1024 * 1024 - total) return strdup(json(@{ @"error": @"TERMDOCK_CLIPBOARD_VIDEO_ERROR:剪贴板视频超过128 MiB，请选择文件上传" }).UTF8String);
                    total += data.length;
                    NSString *ext = type.preferredFilenameExtension ?: @"mov";
                    if (ext.length > 16 || [ext rangeOfCharacterFromSet:[NSCharacterSet alphanumericCharacterSet].invertedSet].location != NSNotFound) ext = @"mov";
                    NSString *name = [NSString stringWithFormat:@"termdock-clipboard-%@-%d.%@", [NSUUID UUID].UUIDString, index++, ext];
                    NSString *path = [directory stringByAppendingPathComponent:name];
                    NSError *writeError = nil;
                    if (![data writeToFile:path options:NSDataWritingWithoutOverwriting error:&writeError]) return strdup(json(@{ @"error": @"TERMDOCK_CLIPBOARD_VIDEO_ERROR:无法读取剪贴板视频" }).UTF8String);
                    [files addObject:@{ @"name": name, @"type": type.preferredMIMEType ?: @"video/quicktime", @"temporary": path }];
                    saved = YES; break;
                }
                if (advertised && !saved) return strdup(json(@{ @"error": @"TERMDOCK_CLIPBOARD_VIDEO_ERROR:复制来源未提供可读取的视频数据，请重新复制视频或选择文件上传" }).UTF8String);
            } }
        }
        return strdup(json(@{ @"files": files, @"hasMovie": @(movieFile) }).UTF8String);
    }
}
char *td_clipboard_read(const char *directory,bool image) {
    @autoreleasepool {clipboard_stage("pasteboard");return clipboard_read_from([NSPasteboard generalPasteboard],directory,image);}
}
// CLI fixture helper only. The ordinary bridge never accepts a pasteboard name.
char *td_clipboard_read_owned(const char *directory,bool image,const char *name) {
    if(!name||strlen(name)>96||strncmp(name,"termdock-preview-owned-",23)!=0)return NULL;
    @autoreleasepool {clipboard_stage("pasteboard");return clipboard_read_from([NSPasteboard pasteboardWithName:[NSString stringWithUTF8String:name]],directory,image);}
}
// Fully synthetic, private CLI fixture. Never touches generalPasteboard.
char *td_clipboard_fixture_create(const char *kind) {
    @autoreleasepool {
        if(!NSThread.isMainThread||!kind)return NULL;
        BOOL pdf=strcmp(kind,"pdf")==0||strcmp(kind,"pdf-too-large")==0;
        NSString *type=strcmp(kind,"png")==0?NSPasteboardTypePNG:strcmp(kind,"tiff")==0?NSPasteboardTypeTIFF:strcmp(kind,"jpeg")==0?@"public.jpeg":pdf?NSPasteboardTypePDF:nil;
        if(!type)return NULL;
        if(pdf){
            CGFloat side=strcmp(kind,"pdf-too-large")==0?8192:8;
            NSMutableData *data=[NSMutableData data];CGDataConsumerRef consumer=CGDataConsumerCreateWithCFData((__bridge CFMutableDataRef)data);
            CGRect box=CGRectMake(0,0,side,side);CGContextRef context=consumer?CGPDFContextCreate(consumer,&box,NULL):NULL;if(consumer)CGDataConsumerRelease(consumer);if(!context)return NULL;
            CGPDFContextBeginPage(context,NULL);CGContextSetRGBFillColor(context,0,1,0,1);CGContextFillRect(context,box);CGPDFContextEndPage(context);CGPDFContextClose(context);CGContextRelease(context);
            NSString *name=[@"termdock-preview-owned-" stringByAppendingString:NSUUID.UUID.UUIDString];NSPasteboard *board=[NSPasteboard pasteboardWithName:name];[board clearContents];
            if(![board setData:data forType:NSPasteboardTypePDF]){[board releaseGlobally];return NULL;}
            return strdup(json(@{@"name":name,@"type":type,@"width":@(side),@"height":@(side),@"encodedBytes":@(data.length)}).UTF8String);
        }
        uint8_t pixels[8*8*4];for(size_t i=0;i<64;i++){pixels[i*4]=i%2?255:0;pixels[i*4+1]=i%2?0:255;pixels[i*4+2]=64;pixels[i*4+3]=255;}
        CGColorSpaceRef space=CGColorSpaceCreateDeviceRGB();
        CGContextRef context=CGBitmapContextCreate(pixels,8,8,8,8*4,space,kCGImageAlphaPremultipliedLast);CGColorSpaceRelease(space);if(!context)return NULL;
        CGImageRef image=CGBitmapContextCreateImage(context);CGContextRelease(context);if(!image)return NULL;
        NSMutableData *data=[NSMutableData data];CGImageDestinationRef destination=CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,(__bridge CFStringRef)type,1,NULL);
        BOOL encoded=NO;if(destination){CGImageDestinationAddImage(destination,image,NULL);encoded=CGImageDestinationFinalize(destination);CFRelease(destination);}CGImageRelease(image);if(!encoded)return NULL;
        NSString *name=[@"termdock-preview-owned-" stringByAppendingString:NSUUID.UUID.UUIDString];NSPasteboard *board=[NSPasteboard pasteboardWithName:name];[board clearContents];
        if(![board setData:data forType:type]){[board releaseGlobally];return NULL;}
        return strdup(json(@{@"name":name,@"type":type,@"width":@8,@"height":@8,@"encodedBytes":@(data.length)}).UTF8String);
    }
}
void td_clipboard_fixture_release(const char *name) {
    if(!name||strlen(name)>96||strncmp(name,"termdock-preview-owned-",23)!=0)return;
    @autoreleasepool {[[NSPasteboard pasteboardWithName:[NSString stringWithUTF8String:name]] releaseGlobally];}
}
bool td_clipboard_fixture_verify_png(const char *path,uint64_t values[3]) {
    if(!path||!values||!NSThread.isMainThread)return false;
    @autoreleasepool {
        NSURL *url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        CGImageSourceRef source=CGImageSourceCreateWithURL((__bridge CFURLRef)url,NULL);if(!source)return false;
        CFStringRef type=CGImageSourceGetType(source);bool png=type&&CFEqual(type,(__bridge CFStringRef)NSPasteboardTypePNG);
        NSDictionary *properties=CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source,0,NULL));
        uint64_t width=[properties[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedLongLongValue];
        uint64_t height=[properties[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedLongLongValue];
        values[0]=width;values[1]=height;values[2]=CGImageSourceGetCount(source);
        // Enforce the production RGBA8 budget before forcing a real decode.
        bool withinBudget=width&&height&&width<=(32ULL*1024*1024/4)/height;
        CGImageRef decoded=withinBudget?CGImageSourceCreateImageAtIndex(source,0,NULL):NULL;
        bool decodedMatches=decoded&&CGImageGetWidth(decoded)==width&&CGImageGetHeight(decoded)==height;
        if(decoded)CGImageRelease(decoded);
        CFRelease(source);return png&&withinBudget&&decodedMatches;
    }
}
void td_string_free(char *value) { free(value); }

// Process-only registration of validated bundled SFNTs; no system font install.
#import <CoreText/CoreText.h>
int td_preview_register_font(const char *path) {
    @autoreleasepool {
        NSString *text=[[NSString alloc] initWithUTF8String:path];if(!text)return 0;
        CFErrorRef error=NULL;
        bool result=CTFontManagerRegisterFontsForURL((__bridge CFURLRef)[NSURL fileURLWithPath:text],kCTFontManagerScopeProcess,&error);
        if(error)CFRelease(error);return result?1:0;
    }
}
