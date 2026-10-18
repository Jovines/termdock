#ifndef TD_CLIPBOARD_COPY_H
#define TD_CLIPBOARD_COPY_H
#import <AppKit/AppKit.h>
// Fixed copy result codes shared by Command-C and AppKit's Copy action.
// Empty, oversized and unreadable selections leave the pasteboard untouched.
static inline int td_write_clipboard_selection(NSPasteboard *board,const uint8_t *bytes,size_t length) {
    if(length>262144)return 1;
    if(!length)return 4;
    if(!bytes)return 2;
    NSString *value=[[NSString alloc]initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
    if(!value)return 2;
    NSPasteboardItem *item=[NSPasteboardItem new];
    if(![item setString:value forType:NSPasteboardTypeString])return 3;
    [board clearContents];
    return [board writeObjects:@[item]]?0:3;
}
#endif
