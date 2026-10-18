#ifndef TD_WINDOW_CHROME_H
#define TD_WINDOW_CHROME_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>
// Per standard button (close/minimize/zoom), no variable hierarchy or text.
typedef struct {
    uint32_t present, flags;
    // button in WK, parent bounds, parent frame(in its parent),
    // grandparent in WK, grandparent in window, button frame(in parent).
    double rects[6][4];
    double center_top_wk, border_width[2], background_alpha[2];
} TDWindowChromeButton;
_Static_assert(sizeof(TDWindowChromeButton)==240,"window chrome button POD size");
typedef struct {
    uint32_t present, role, flags, event_type;
    uint64_t owner_generation, document_generation;
    double backing_scale;
    // All rects are logical AppKit points, in order:
    // window(screen bottom-left), contentLayout(window), content(frame parent),
    // content(bounds), WK(frame parent), WK(bounds), WK(in content), WK(in window),
    // moved button grandparent(frame parent). Physical backing scale is separate.
    double rects[9][4];
    TDWindowChromeButton buttons[3];
} TDWindowChromeSnapshot;
_Static_assert(sizeof(TDWindowChromeSnapshot)==1048,"window chrome POD size");
_Static_assert(_Alignof(TDWindowChromeSnapshot)==8,"window chrome POD alignment");
_Static_assert(offsetof(TDWindowChromeSnapshot,rects)==40,"window chrome POD rect offset");
_Static_assert(offsetof(TDWindowChromeSnapshot,buttons)==328,"window chrome button offset");
// Pure parent-local batch preflight. No output changes until all three pass.
static inline bool td_chrome_button_frames(const double frames[3][4],const double bounds[3][4],const double vectors[3][2],double result[3][4]) {
    double candidates[3][4];
    for(unsigned i=0;i<3;i++){
        for(unsigned j=0;j<4;j++)if(!isfinite(frames[i][j])||!isfinite(bounds[i][j])||fabs(frames[i][j])>1e7||fabs(bounds[i][j])>1e7)return false;
        if(!isfinite(vectors[i][0])||!isfinite(vectors[i][1])||fabs(vectors[i][0])>=0.25||fabs(vectors[i][1])>128)return false;
        if(frames[i][2]<=0||frames[i][3]<=0||bounds[i][2]<=0||bounds[i][3]<=0)return false;
        memcpy(candidates[i],frames[i],sizeof(candidates[i]));candidates[i][1]+=vectors[i][1];
        if(candidates[i][0]<bounds[i][0]||candidates[i][1]<bounds[i][1]||candidates[i][0]+candidates[i][2]>bounds[i][0]+bounds[i][2]||candidates[i][1]+candidates[i][3]>bounds[i][1]+bounds[i][3])return false;
    }
    memcpy(result,candidates,sizeof(candidates));return true;
}
// Owned-only cumulative counters, saturated at65535. No extra geometry samples.
typedef void (*TDChromeCounts)(uint64_t,uint64_t,uint32_t,uint32_t,uint32_t,uint32_t);
typedef uint64_t (*TDChromeReserve)(uint64_t,uint64_t,uint32_t);
typedef void (*TDChromeReceive)(uint64_t,uint32_t,const TDWindowChromeSnapshot *);
#endif
