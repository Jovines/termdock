// Real Ghostty/AppKit mouse-mode regression. Fixed owned text and window only.
// generalPasteboard is redirected inside this test process to a unique named
// pasteboard; the user clipboard, services and PTYs are never read or changed.
#import "../native/TDGhostty.m"
#include <assert.h>
static NSPasteboard *ownedBoard;
static NSPasteboard *ownedGeneral(id obj,SEL sel){(void)obj;(void)sel;return ownedBoard;}
static unsigned pathCount;static bool plainPath;
static unsigned shortcutCount,selectionCount,failureCount,inputCount,wheelCount;
static int observe(void *ctx,uint32_t kind,const uint8_t *data,size_t len,uint64_t a,uint64_t b){(void)ctx;(void)data;if(kind==19){pathCount++;plainPath=a==1;}(void)a;(void)b;if(kind==0)inputCount+=(unsigned)len;if(kind==2)selectionCount++;if(kind==11)shortcutCount++;if(kind==21)failureCount++;if(kind==14)wheelCount++;return 1;}
static void settle(TDHandle *h,const char *text){
 __block atomic_bool done;atomic_init(&done,false);__block bool ok=false;td_native_worker_busy(h,true);
 dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{if(text)ok=td_native_feed(h,(const uint8_t *)text,strlen(text));else ok=true;if(ok)ok=td_native_drain_app(h)&&td_native_barrier(h);atomic_store(&done,true);});
 NSDate *end=[NSDate dateWithTimeIntervalSinceNow:10];while(!atomic_load(&done)&&end.timeIntervalSinceNow>0){td_native_pump_io(h);[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.001]];}
 assert(atomic_load(&done)&&ok);td_native_worker_busy(h,false);
}
static void drain(TDHandle *h,TDGhosttyView *v){while(v.pending.count){td_native_pump(h);settle(h,NULL);}td_native_pump(h);settle(h,NULL);}
int main(void){@autoreleasepool{
 setbuf(stdout,NULL);[NSApplication sharedApplication];void *window=td_native_demo_window();NSWindow *w=(__bridge NSWindow *)window;
 TDHandle *h=td_native_create((__bridge void *)w.contentView,NULL,observe,"font-family = Menlo\nfont-size = 13\nwindow-vsync = false\nwindow-padding-x = 0\nwindow-padding-y = 0\nwindow-padding-balance = false\nscrollback-limit = 1048576\nimage-storage-limit = 33554432\ncustom-shader-animation = false\nclipboard-read = deny\nclipboard-write = deny\nkeybind = clear\n",13,80,24,100);assert(h);
 TDGhosttyView *v=(__bridge TDGhosttyView *)h->retained_view;uint16_t cols=0,rows=0;assert(td_native_rect(h,0,0,800,400,w.backingScaleFactor,&cols,&rows));settle(h,NULL);td_native_visible(h,true);h->desired_focus=true;h->focus_dirty=true;td_native_pump(h);settle(h,"\033[2J\033[HOWNED-COPY-ASCII");
 ghostty_surface_size_s size=ghostty_surface_size(h->surface);double cw=(double)size.cell_width_px/w.backingScaleFactor,ch=(double)size.cell_height_px/w.backingScaleFactor;
 NSEventType types[]={NSEventTypeLeftMouseDown,NSEventTypeLeftMouseDragged,NSEventTypeLeftMouseUp};
 for(int i=0;i<3;i++){NSPoint p=[v convertPoint:NSMakePoint((i?10.5:.5)*cw,.5*ch) toView:nil];NSEvent *event=[NSEvent mouseEventWithType:types[i] location:p modifierFlags:0 timestamp:(double)i/10 windowNumber:w.windowNumber context:nil eventNumber:i+1 clickCount:1 pressure:1];if(i==0)[v mouseDown:event];else if(i==1)[v mouseDragged:event];else[v mouseUp:event];drain(h,v);}
 ghostty_text_s text={0};bool selected=ghostty_surface_has_selection(h->surface),read=ghostty_surface_read_selection(h->surface,&text);printf("selected=%d read=%d bytes=%lu selectionEvents=%u inputBytes=%u cw=%.1f ch=%.1f\n",selected,read,(unsigned long)text.text_len,selectionCount,inputCount,cw,ch);
 NSString *expected=read?[[NSString alloc]initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding]:nil;if(read)ghostty_surface_free_text(h->surface,&text);
 ownedBoard=[NSPasteboard pasteboardWithUniqueName];Method method=class_getClassMethod(NSPasteboard.class,@selector(generalPasteboard));IMP original=method_setImplementation(method,(IMP)ownedGeneral);
 NSEvent *copy=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:1 windowNumber:w.windowNumber context:nil characters:@"c" charactersIgnoringModifiers:@"c" isARepeat:NO keyCode:8];BOOL handled=[v performKeyEquivalent:copy];drain(h,v);
 NSString *actual=[ownedBoard stringForType:NSPasteboardTypeString];printf("handled=%d clipboardMatches=%d clipboardBytes=%lu shortcutCount=%u failures=%u\n",handled,expected.length>0&&[actual isEqualToString:expected],(unsigned long)[actual lengthOfBytesUsingEncoding:NSUTF8StringEncoding],shortcutCount,failureCount);
 assert(expected.length>0&&[actual isEqualToString:expected]);
 td_native_policy(h,true);settle(h,"\033c\033[HOWNED-TMUX-MOUSE\033[?1002h\033[?1006h");
 [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.6]];
 unsigned oldInput=inputCount,oldShortcut=shortcutCount;
 for(int i=0;i<3;i++){NSPoint p=[v convertPoint:NSMakePoint((i?10.5:.5)*cw,.5*ch) toView:nil];NSEvent *event=[NSEvent mouseEventWithType:types[i] location:p modifierFlags:0 timestamp:2+(double)i/10 windowNumber:w.windowNumber context:nil eventNumber:i+11 clickCount:1 pressure:1];if(i==0)[v mouseDown:event];else if(i==1)[v mouseDragged:event];else[v mouseUp:event];drain(h,v);}
 assert(ghostty_surface_has_selection(h->surface));[v performKeyEquivalent:copy];drain(h,v);
 printf("tmuxPlainDragMouseBytes=%u tmuxCopyRequests=%u clipboardBytes=%lu\n",inputCount-oldInput,shortcutCount-oldShortcut,(unsigned long)[[ownedBoard stringForType:NSPasteboardTypeString] length]);assert(inputCount==oldInput&&shortcutCount==oldShortcut&&[[ownedBoard stringForType:NSPasteboardTypeString] isEqualToString:@"OWNED-TMUX"]);
 settle(h,"\033c\033[HCOPY中文←→\033[?1002h\033[?1006h");[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.6]];oldInput=inputCount;
 for(int i=0;i<3;i++){NSPoint p=[v convertPoint:NSMakePoint((i?10.5:.5)*cw,.5*ch) toView:nil];NSEvent *event=[NSEvent mouseEventWithType:types[i] location:p modifierFlags:0 timestamp:3+(double)i/10 windowNumber:w.windowNumber context:nil eventNumber:i+16 clickCount:1 pressure:1];if(i==0)[v mouseDown:event];else if(i==1)[v mouseDragged:event];else[v mouseUp:event];drain(h,v);}
 [v performKeyEquivalent:copy];drain(h,v);NSString *unicode=[ownedBoard stringForType:NSPasteboardTypeString];printf("unicodeCopy=%d unicodeBytes=%lu\n",[unicode isEqualToString:@"COPY中文←→"],(unsigned long)[unicode lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);assert(inputCount==oldInput&&[unicode isEqualToString:@"COPY中文←→"]);
 settle(h,"\033c\033[HOWNED-TMUX-OPTION\033[?1002h\033[?1006h");oldInput=inputCount;oldShortcut=shortcutCount;
 for(int i=0;i<3;i++){NSPoint p=[v convertPoint:NSMakePoint((i?10.5:.5)*cw,.5*ch) toView:nil];NSEvent *event=[NSEvent mouseEventWithType:types[i] location:p modifierFlags:(i==0?NSEventModifierFlagOption:0) timestamp:4+(double)i/10 windowNumber:w.windowNumber context:nil eventNumber:i+21 clickCount:1 pressure:1];if(i==0)[v mouseDown:event];else if(i==1)[v mouseDragged:event];else[v mouseUp:event];drain(h,v);}
 assert(!ghostty_surface_has_selection(h->surface));[v performKeyEquivalent:copy];drain(h,v);
 printf("optionDragMouseBytes=%u tmuxCopyRequests=%u\n",inputCount-oldInput,shortcutCount-oldShortcut);assert(inputCount>oldInput&&shortcutCount==oldShortcut+1);

 settle(h,"\033c\033[HOWNEDCOPY other\033[?1002h\033[?1006h");[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.6]];
 oldInput=inputCount;for(int count=1;count<=2;count++){for(int up=0;up<=1;up++){NSPoint p=[v convertPoint:NSMakePoint(2.5*cw,.5*ch) toView:nil];NSEvent *event=[NSEvent mouseEventWithType:up?NSEventTypeLeftMouseUp:NSEventTypeLeftMouseDown location:p modifierFlags:0 timestamp:6+.05*(count*2+up) windowNumber:w.windowNumber context:nil eventNumber:40+count*2+up clickCount:count pressure:up?0:1];if(up)[v mouseUp:event];else[v mouseDown:event];drain(h,v);}}
 printf("applicationClickBytes=%u\n",inputCount-oldInput);assert(inputCount>oldInput&&!ghostty_surface_has_selection(h->surface));
 CGEventRef scroll=CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitLine,1,1);NSEvent *wheel=[NSEvent eventWithCGEvent:scroll];CFRelease(scroll);unsigned oldWheel=wheelCount;[v scrollWheel:wheel];drain(h,v);printf("pageWheel=%u\n",wheelCount-oldWheel);assert(wheelCount==oldWheel+1);
 // Actual gesture dispatch must activate only clicks, including under app mouse capture.
 settle(h,"\033c\033[H/tmp/termdock-owned.ts:7 https://example.test/owned\033[?1002h\033[?1006h");
 for(int mode=0;mode<5;mode++){
  unsigned before=pathCount;
  for(int i=0;i<(mode==2?3:2);i++){
   bool up=i==(mode==2?2:1);NSEventType type=i==0?NSEventTypeLeftMouseDown:up?NSEventTypeLeftMouseUp:NSEventTypeLeftMouseDragged;
   double column=mode==1?35.5:5.5;if(mode==2&&i)column=12.5;
   NSPoint point=[v convertPoint:NSMakePoint(column*cw,.5*ch) toView:nil];
   NSEvent *event=[NSEvent mouseEventWithType:type location:point modifierFlags:mode==3?NSEventModifierFlagShift:mode==4?NSEventModifierFlagCommand:0 timestamp:10+mode+.1*i windowNumber:w.windowNumber context:nil eventNumber:100+mode*3+i clickCount:1 pressure:up?0:1];
   if(i==0)[v mouseDown:event];else if(up)[v mouseUp:event];else[v mouseDragged:event];drain(h,v);
  }
  if(mode==2||mode==3)assert(pathCount==before);else{assert(pathCount==before+1);assert(plainPath==(mode!=4));}
 }
 printf("plainPathClick=pass plainURLClick=pass dragDoesNotActivate=pass shiftDoesNotActivate=pass commandPathClick=pass\n");
 method_setImplementation(method,original);[ownedBoard releaseGlobally];ownedBoard=nil;td_native_destroy(h);td_native_demo_close(window);assert(expected.length>0&&[actual isEqualToString:expected]);return 0;
}}
