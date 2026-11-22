#import <UIKit/UIKit.h>
extern "C" void kladde_haptic() {
    dispatch_async(dispatch_get_main_queue(), ^{ [[[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight] impactOccurred]; });
}
