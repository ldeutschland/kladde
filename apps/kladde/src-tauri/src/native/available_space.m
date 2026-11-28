#import <Foundation/Foundation.h>

int64_t kladde_available_space(const char *path) {
    if (path == NULL) return -1;
    NSString *text = [NSString stringWithUTF8String:path];
    if (text == nil) return -1;
    NSNumber *space = nil;
    NSURL *url = [NSURL fileURLWithPath:text];
    BOOL found = [url getResourceValue:&space forKey:NSURLVolumeAvailableCapacityForImportantUsageKey error:nil];
    return found && space != nil ? space.longLongValue : -1;
}
