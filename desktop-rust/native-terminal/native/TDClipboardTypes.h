#ifndef TD_CLIPBOARD_TYPES_H
#define TD_CLIPBOARD_TYPES_H
#include <stdbool.h>

// Some producers advertise a MIME type rather than a registered UTI.
static inline bool td_clipboard_video_mime(const char *identifier) {
    if (!identifier) return false;
    const char *prefix = "video/";
    for (unsigned i = 0; i < 6; i++) {
        unsigned char c = (unsigned char)identifier[i];
        if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        if (!c || c != (unsigned char)prefix[i]) return false;
    }
    return identifier[6] != '\0';
}

#ifdef __OBJC__
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
static inline bool td_clipboard_types_have_movie(NSArray<NSString *> *types) {
    for (NSString *identifier in types) {
        if (td_clipboard_video_mime(identifier.UTF8String)) return true;
        UTType *type = [UTType typeWithIdentifier:identifier];
        if ([type conformsToType:UTTypeMovie] || [type conformsToType:UTTypeVideo]) return true;
    }
    return false;
}
#endif
#endif
