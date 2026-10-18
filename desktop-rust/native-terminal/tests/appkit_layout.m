// Owned AppKit geometry only: no service, PTY, screen or user input.
#import "../native/TDGhostty.m"
#include <assert.h>
int main(void){@autoreleasepool{
 [NSApplication sharedApplication];
 NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,900,600) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
 window.releasedWhenClosed=NO;
 NSView *parent=window.contentView;
 TDHandle host={0};atomic_init(&host.busy,true);atomic_init(&host.replaying,false);host.has_rect=true;
 TDGhosttyView *view=[[TDGhosttyView alloc]initWithFrame:NSMakeRect(200,30,600,500)];view.wantsLayer=YES;view.host=&host;
 [parent addSubview:view];host.retained_view=(__bridge void *)view;
 double hole[]={20,20,80,40};
 for(unsigned i=0;i<80;i++){
  double w=300+(i%20)*10,h=200+(i%12)*10;
  assert(td_native_present_layout(&host,200,40,w,h,hole,1,true)==1);
  assert(view.frame.size.width==w&&view.frame.size.height==h);
  assert(view.frame.origin.x==200&&NSMaxY(view.frame)==NSMaxY(parent.bounds)-40);
  assert(!view.hidden&&view.layer.mask&&view.clipHoles.count==1);
  // Overlay hit testing remains cut out while the engine is busy.
  NSPoint point=[view convertPoint:NSMakePoint(30,30) toView:parent];assert([view hitTest:point]==nil);
 }
 NSRect previous=view.frame;
 assert(!td_native_present_layout(&host,NAN,40,400,300,NULL,0,true));assert(NSEqualRects(previous,view.frame));
 atomic_store(&host.replaying,true);assert(!td_native_present_layout(&host,200,40,400,300,NULL,0,true));assert(NSEqualRects(previous,view.frame));
 atomic_store(&host.replaying,false);
 assert(td_native_present_layout(&host,200,40,600,500,NULL,0,true));assert(!view.layer.mask&&view.clipHoles.count==0);
 // Returning to the last committed grid still restores the visual frame.
 uint16_t cols=0,rows=0;
 assert(td_native_layout(&host,200,40,300,200,2,NULL,0,false,true,&cols,&rows));assert(view.frame.size.width==300&&view.frame.size.height==200);
 assert(td_native_present_layout(&host,200,40,320,200,NULL,0,false));assert(view.hidden);
 host.retained_view=NULL;view.host=NULL;[view removeFromSuperview];[window close];
 puts("PASS busy presentation: 80 resize frames, overlay cutouts, invalid/replay rejection, return-to-grid, hide");
}return 0;}
