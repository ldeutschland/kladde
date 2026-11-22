#import <AppKit/AppKit.h>

static const NSInteger KladdeBackButton = 3;
static const NSInteger KladdeForwardButton = 4;
static const int32_t KladdeBack = -1;
static const int32_t KladdeForward = 1;
static const int32_t KladdeStay = 0;
static id navigationMonitor = nil;

static int32_t buttonDirection(NSEvent *event) {
    if (event.buttonNumber == KladdeBackButton) return KladdeBack;
    if (event.buttonNumber == KladdeForwardButton) return KladdeForward;
    return KladdeStay;
}

static int32_t swipeDirection(NSEvent *event) {
    if (fabs(event.deltaX) <= fabs(event.deltaY)) return KladdeStay;
    if (event.deltaX > 0) return KladdeBack;
    if (event.deltaX < 0) return KladdeForward;
    return KladdeStay;
}

static int32_t directionOf(NSEvent *event) {
    if (event.type == NSEventTypeOtherMouseDown) return buttonDirection(event);
    if (event.type == NSEventTypeOtherMouseUp) return KladdeStay;
    if (event.type == NSEventTypeSwipe) return swipeDirection(event);
    return KladdeStay;
}

static bool swallowed(NSEvent *event) {
    return event.type == NSEventTypeOtherMouseUp && buttonDirection(event) != KladdeStay;
}

bool kladde_watch_navigation(void (*notify)(int32_t)) {
    if (notify == NULL || navigationMonitor != nil) return false;
    NSEventMask mask = NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp | NSEventMaskSwipe;
    navigationMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
        int32_t direction = directionOf(event);
        if (direction != KladdeStay) {
            notify(direction);
            return nil;
        }
        return swallowed(event) ? nil : event;
    }];
    return navigationMonitor != nil;
}
