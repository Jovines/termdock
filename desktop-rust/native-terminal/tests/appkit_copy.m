// Exercise the production Cmd-C path and real AppKit menu dispatch.
// Only Ghostty selection presence is stubbed; no user clipboard or PTY is read.
#import <AppKit/AppKit.h>
#import <ghostty.h>
static bool ownedHasSelection(ghostty_surface_t surface){(void)surface;return false;}
#define ghostty_surface_has_selection ownedHasSelection
#import "../native/TDGhostty.m"
#include <assert.h>
static unsigned copies,wakeups;
static int observeCopy(void *ctx,uint32_t kind,const uint8_t *data,size_t n,uint64_t a,uint64_t b){(void)ctx;(void)data;(void)n;(void)a;(void)b;if(kind==11)copies++;if(kind==16)wakeups++;return 1;}
int main(void){@autoreleasepool{
 [NSApplication sharedApplication];
 NSWindow *w=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,400,200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];w.releasedWhenClosed=NO;
 TDHandle h={0};h.callback=observeCopy;h.surface=(ghostty_surface_t)1;h.tmux_scroll=true;
 TDGhosttyView *v=[[TDGhosttyView alloc]initWithFrame:w.contentView.bounds];v.host=&h;v.pending=[NSMutableArray array];v.marked=[[NSMutableAttributedString alloc]init];[w.contentView addSubview:v];[w makeFirstResponder:v];
 NSMenu *menu=[[NSMenu alloc]initWithTitle:@"owned"];NSMenuItem *edit=[[NSMenuItem alloc]initWithTitle:@"Edit" action:nil keyEquivalent:@""];NSMenu *sub=[[NSMenu alloc]initWithTitle:@"Edit"];NSMenuItem *copy=[[NSMenuItem alloc]initWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];[sub addItem:copy];edit.submenu=sub;[menu addItem:edit];NSApp.mainMenu=menu;
 NSEvent *e=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:0 windowNumber:w.windowNumber context:nil characters:@"c" charactersIgnoringModifiers:@"c" isARepeat:NO keyCode:8];
 BOOL handled=[v performKeyEquivalent:e];printf("handled=%d copies=%u queued=%lu responder=%d\n",handled,copies,(unsigned long)v.pending.count,w.firstResponder==v);
 assert(handled&&copies==0&&v.pending.count==1);
 NSEvent *queued=v.pending.firstObject;[v.pending removeObjectAtIndex:0];[v dispatchEvent:queued];
 printf("copyAfterDispatch=%u\n",copies);assert(copies==1);
 h.surface=NULL;v.host=NULL;[w close];return 0;
}}
