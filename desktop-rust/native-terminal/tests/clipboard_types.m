#import "../native/TDClipboardTypes.h"
#include <assert.h>
int main(void) {
    @autoreleasepool {
        assert(td_clipboard_types_have_movie(@[UTTypeMovie.identifier]));
        assert(td_clipboard_types_have_movie(@[UTTypeVideo.identifier]));
        assert(td_clipboard_types_have_movie(@[@"public.mpeg-4"]));
        assert(td_clipboard_types_have_movie(@[@"com.apple.quicktime-movie"]));
        assert(td_clipboard_types_have_movie(@[@"video/mp4"]));
        assert(td_clipboard_types_have_movie(@[UTTypePNG.identifier, @"VIDEO/MP4"]));
        assert(!td_clipboard_types_have_movie(@[UTTypePNG.identifier]));
        assert(!td_clipboard_types_have_movie(@[UTTypePlainText.identifier]));
        assert(!td_clipboard_types_have_movie(@[UTTypeFileURL.identifier]));
        assert(!td_clipboard_types_have_movie(@[]));
    }
    return 0;
}
