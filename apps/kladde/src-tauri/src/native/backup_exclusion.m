#import <Foundation/Foundation.h>

bool kladde_exclude_from_backup(const char *path) {
    if (path == NULL) return false;
    NSString *text = [NSString stringWithUTF8String:path];
    if (text == nil) return false;
    NSURL *url = [NSURL fileURLWithPath:text];
    return [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}
