#import <Foundation/Foundation.h>
#import <Network/Network.h>
#include <TargetConditionals.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

typedef void (*kladde_signal)(void);

static nw_path_monitor_t monitor;

static NSString *path_signature(nw_path_t path) {
    if (nw_path_get_status(path) != nw_path_status_satisfied) {
        return @"offline";
    }
    NSMutableString *signature = [NSMutableString stringWithString:@"online"];
    nw_interface_type_t types[] = {
        nw_interface_type_wifi,
        nw_interface_type_cellular,
        nw_interface_type_wired,
        nw_interface_type_other,
    };
    for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
        if (nw_path_uses_interface_type(path, types[i])) {
            [signature appendFormat:@":%d", (int)types[i]];
        }
    }
    return signature;
}

bool kladde_watch_network(kladde_signal changed) {
    if (monitor) {
        return true;
    }
    monitor = nw_path_monitor_create();
    if (!monitor) {
        return false;
    }
    __block NSString *last = nil;
    nw_path_monitor_set_queue(monitor, dispatch_queue_create("kladde.network", DISPATCH_QUEUE_SERIAL));
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
        NSString *current = path_signature(path);
        BOOL first = last == nil;
        BOOL same = [current isEqualToString:last];
        last = current;
        if (!first && !same && nw_path_get_status(path) == nw_path_status_satisfied) {
            changed();
        }
    });
    nw_path_monitor_start(monitor);
    return true;
}

#if TARGET_OS_IOS
static const uint64_t leaving_hold = 0;
static UIBackgroundTaskIdentifier task;
static BOOL holding = NO;
static NSMutableSet<NSNumber *> *holds;

static void end_task(void) {
    if (!holding) {
        return;
    }
    holding = NO;
    [UIApplication.sharedApplication endBackgroundTask:task];
}

static void hold_on_main(uint64_t hold) {
    if (!holds) {
        holds = [NSMutableSet set];
    }
    [holds addObject:@(hold)];
    if (holding) {
        return;
    }
    task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Kladde sync"
                                                      expirationHandler:^{
                                                          [holds removeAllObjects];
                                                          end_task();
                                                      }];
    holding = task != UIBackgroundTaskInvalid;
}

static void release_on_main(uint64_t hold) {
    [holds removeObject:@(hold)];
    if (holds.count == 0) {
        end_task();
    }
}

void kladde_background_hold(uint64_t hold) {
    dispatch_async(dispatch_get_main_queue(), ^{
        hold_on_main(hold);
    });
}

void kladde_background_release(uint64_t hold) {
    dispatch_async(dispatch_get_main_queue(), ^{
        release_on_main(hold);
    });
}

bool kladde_watch_lifecycle(kladde_signal leaving, kladde_signal returning) {
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(__unused NSNotification *note) {
                        hold_on_main(leaving_hold);
                        leaving();
                    }];
    [center addObserverForName:UIApplicationWillEnterForegroundNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(__unused NSNotification *note) {
                        returning();
                    }];
    return true;
}
#endif
