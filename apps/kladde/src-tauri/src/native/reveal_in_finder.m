#import <AppKit/AppKit.h>

void kladde_reveal_in_finder(const char *path) {
    @autoreleasepool {
        NSString *text = [NSString stringWithUTF8String:path];
        if (text == nil) return;
        NSURL *url = [NSURL fileURLWithPath:text];
        dispatch_async(dispatch_get_main_queue(), ^{
            [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[url]];
        });
    }
}
