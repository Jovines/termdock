// Owned AppKit callbacks against the production input host. No system input
// source selection, OS key posting, general clipboard, network or user PTY.
#import "../native/TDGhostty.m"
#include <assert.h>
static unsigned wakeups;
static unsigned menuCalls;
@interface TDFontTestMenu : NSMenu
@end
@implementation TDFontTestMenu
- (BOOL)performKeyEquivalent:(NSEvent *)event {(void)event;menuCalls++;return YES;}
@end
static int observe(void *ctx,uint32_t kind,const uint8_t *data,size_t n,uint64_t a,uint64_t b){
    (void)ctx;(void)data;(void)n;(void)a;(void)b;if(kind==16)wakeups++;return 1;
}
@interface TDInputTestView : TDGhosttyView
@property(nonatomic) BOOL insideKeyDown;
@property(nonatomic) BOOL interpretedSynchronously;
@end
@implementation TDInputTestView
- (void)keyDown:(NSEvent *)event {
    self.insideKeyDown=YES;[super keyDown:event];self.insideKeyDown=NO;
}
- (void)interpretKeyEvents:(NSArray<NSEvent *> *)events {
    self.interpretedSynchronously=self.insideKeyDown;
    NSString *key=events.firstObject.characters;
    if([key isEqualToString:@"n"]){
        [self setMarkedText:@"ni" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];
    }else if([key isEqualToString:@" "]||[key isEqualToString:@"1"]){
        [self insertText:@"你" replacementRange:NSMakeRange(NSNotFound,0)];
    }else if([key isEqualToString:@"\x1b"]){
        [self unmarkText];
    }else [self insertText:key replacementRange:NSMakeRange(NSNotFound,0)];
}
@end
static NSEvent *key(NSString *text,unsigned short code){
    return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];
}
int main(void){@autoreleasepool{
    [NSApplication sharedApplication];
    TDHandle host={0};atomic_init(&host.busy,true);host.callback=observe;
    TDInputTestView *view=[[TDInputTestView alloc]initWithFrame:NSMakeRect(0,0,400,200)];
    view.host=&host;view.marked=[[NSMutableAttributedString alloc]init];view.pending=[NSMutableArray array];
    for(NSString *commit in @[@" ",@"1"]){
        [view.pending removeAllObjects];view.pendingBytes=0;
        [view keyDown:key(@"n",45)];
        assert(view.interpretedSynchronously&&view.hasMarkedText);
        assert([view.marked.string isEqualToString:@"ni"]);
        assert(view.pending.count==1);
        TDInterpretedKey *preedit=view.pending.firstObject;
        assert(preedit.composing); // never submit the n/ni as committed input
        [view keyDown:key(commit,[commit isEqualToString:@" "]?49:18)];
        assert(view.interpretedSynchronously&&!view.hasMarkedText);
        assert(view.pending.count==2);
        TDInterpretedKey *result=view.pending.lastObject;
        assert(!result.composing&&result.text.count==1&&[result.text.firstObject isEqualToString:@"你"]);
    }
    [view.pending removeAllObjects];view.pendingBytes=0;
    [view keyDown:key(@"n",45)];[view keyDown:key(@"\x1b",53)];
    assert(!view.hasMarkedText&&((TDInterpretedKey *)view.pending.lastObject).composing);
    [view.pending removeAllObjects];view.pendingBytes=0;wakeups=0;host.preedit_state=0;
    [view setMarkedText:@"语音" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];
    assert(view.hasMarkedText&&host.preedit_state!=0&&wakeups>0&&view.pending.count==0);
    [view setMarkedText:@"语音输入" selectedRange:NSMakeRange(4,0) replacementRange:NSMakeRange(NSNotFound,0)];
    assert([view.marked.string isEqualToString:@"语音输入"]&&view.pending.count==0);
    [view insertText:@"语音输入" replacementRange:NSMakeRange(NSNotFound,0)];
    assert(!view.hasMarkedText&&view.pending.count==1&&[view.pending.firstObject isEqualToString:@"语音输入"]);
    assert(NSEqualRanges(view.selectedRange,NSMakeRange(0,0)));
    // Input methods may reuse mutable storage immediately after callbacks.
    assert(td_native_keyboard_commit_snapshot_fixture()==7);
    // An owned, hidden window exercises real responder/menu arbitration without
    // posting OS key events or touching the user's windows or input source.
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,400,200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.contentView=view;assert([window makeFirstResponder:view]);
    NSMenu *oldMenu=NSApp.mainMenu;NSApp.mainMenu=[[TDFontTestMenu alloc]initWithTitle:@"Owned font menu"];
    for(NSArray *spec in @[@[@"=",@24,@(NSEventModifierFlagCommand)],@[@"+",@24,@(NSEventModifierFlagCommand|NSEventModifierFlagShift)],@[@"-",@27,@(NSEventModifierFlagCommand)],@[@"0",@29,@(NSEventModifierFlagCommand)]]){
        [view.pending removeAllObjects];view.pendingBytes=0;menuCalls=0;
        NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:[spec[2] unsignedLongLongValue] timestamp:0 windowNumber:window.windowNumber context:nil characters:spec[0] charactersIgnoringModifiers:spec[0] isARepeat:NO keyCode:[spec[1] unsignedShortValue]];
        assert([view performKeyEquivalent:event]);assert(menuCalls==0&&view.pending.count==1&&view.pending.firstObject==event);
    }
    menuCalls=0;
    NSEvent *normal=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:0 windowNumber:window.windowNumber context:nil characters:@"n" charactersIgnoringModifiers:@"n" isARepeat:NO keyCode:45];
    assert([view performKeyEquivalent:normal]&&menuCalls==1);
    NSApp.mainMenu=oldMenu;view.host=NULL;[window close];
    puts("spaceCandidate=pass numberCandidate=pass cancel=pass dictationPreedit=pass orderedCommit=pass mutableCommit=pass busyEngineUntouched=pass sessionFontMenuRouting=pass; physicalIME=false");
    return 0;
}}
