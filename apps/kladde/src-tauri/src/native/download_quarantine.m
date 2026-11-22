#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#include <stdbool.h>

bool kladde_quarantine(const char *path) {
    @autoreleasepool {
        @try {
            NSString *text = [NSString stringWithUTF8String:path];
            if (text == nil) return false;
            NSURL *url = [NSURL fileURLWithPath:text];
            NSDictionary *properties = @{
                (__bridge NSString *)kLSQuarantineTypeKey: (__bridge NSString *)kLSQuarantineTypeOtherDownload,
                (__bridge NSString *)kLSQuarantineAgentNameKey: @"Kladde",
            };
            return [url setResourceValue:properties forKey:NSURLQuarantinePropertiesKey error:nil];
        } @catch (NSException *problem) {
            return false;
        }
    }
}
