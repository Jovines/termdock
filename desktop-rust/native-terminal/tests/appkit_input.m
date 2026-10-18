// Owned AppKit callbacks against the production input host. No system input
// source selection, OS key posting, general clipboard, network or user PTY.
#import "../native/TDGhostty.m"
#include <assert.h>
static unsigned wakeups;
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
    view.host=NULL;
    puts("spaceCandidate=pass numberCandidate=pass cancel=pass dictationPreedit=pass orderedCommit=pass mutableCommit=pass busyEngineUntouched=pass; physicalIME=false");
    return 0;
}}
