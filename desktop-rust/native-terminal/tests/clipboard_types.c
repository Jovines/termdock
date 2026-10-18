#include "../native/TDClipboardTypes.h"
#include <assert.h>
int main(void) {
    assert(td_clipboard_video_mime("video/mp4"));
    assert(td_clipboard_video_mime("VIDEO/QUICKTIME"));
    assert(!td_clipboard_video_mime("video/"));
    assert(!td_clipboard_video_mime("video"));
    assert(!td_clipboard_video_mime("text/plain"));
    assert(!td_clipboard_video_mime("application/octet-stream"));
    assert(!td_clipboard_video_mime("xvideo/mp4"));
    assert(!td_clipboard_video_mime(""));
    assert(!td_clipboard_video_mime(0));
    return 0;
}
