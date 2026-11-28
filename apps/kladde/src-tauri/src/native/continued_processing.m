#import <Foundation/Foundation.h>
#include <TargetConditionals.h>
#if TARGET_OS_IOS
#import <BackgroundTasks/BackgroundTasks.h>
#endif

static dispatch_queue_t work_queue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("kladde.continued", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

static NSString *utf8_text(const char *value) {
    return value == NULL ? nil : [NSString stringWithUTF8String:value];
}

#if TARGET_OS_IOS
static const int64_t percent_scale = 100;
static NSMutableSet<NSString *> *registered;
static NSMutableSet<NSString *> *wanted;
static NSMutableSet<NSString *> *expired;
static NSMutableDictionary<NSString *, BGContinuedProcessingTask *> *running;
static NSMutableDictionary<NSString *, NSNumber *> *shown;

static void prepare(void) {
    if (registered) {
        return;
    }
    registered = [NSMutableSet set];
    wanted = [NSMutableSet set];
    expired = [NSMutableSet set];
    running = [NSMutableDictionary dictionary];
    shown = [NSMutableDictionary dictionary];
}

static NSString *task_identifier(NSString *name) {
    return [NSString stringWithFormat:@"%@.continued.%@", NSBundle.mainBundle.bundleIdentifier, name];
}

static NSString *percent_text(double fraction) {
    return [NSNumberFormatter localizedStringFromNumber:@(fraction) numberStyle:NSNumberFormatterPercentStyle];
}

static void finish(NSString *identifier, BOOL success) {
    BGContinuedProcessingTask *task = running[identifier];
    [running removeObjectForKey:identifier];
    [shown removeObjectForKey:identifier];
    [task setTaskCompletedWithSuccess:success];
}

static void adopt(BGContinuedProcessingTask *task) {
    NSString *identifier = task.identifier;
    if (![wanted containsObject:identifier]) {
        [task setTaskCompletedWithSuccess:YES];
        return;
    }
    task.expirationHandler = ^{
        dispatch_async(work_queue(), ^{
            [expired addObject:identifier];
            finish(identifier, NO);
        });
    };
    running[identifier] = task;
}

static void submit(BGContinuedProcessingTaskRequest *request) {
    BGTaskScheduler *scheduler = BGTaskScheduler.sharedScheduler;
    if (@available(iOS 27.0, *)) {
        [scheduler submitTaskRequest:request completionHandler:^(__unused NSError *error) {}];
        return;
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [scheduler submitTaskRequest:request error:nil];
#pragma clang diagnostic pop
}

static BOOL register_once(NSString *identifier) {
    if ([registered containsObject:identifier]) {
        return YES;
    }
    BOOL accepted = [BGTaskScheduler.sharedScheduler
        registerForTaskWithIdentifier:identifier
                           usingQueue:nil
                        launchHandler:^(__kindof BGTask *task) {
                            if (![task isKindOfClass:BGContinuedProcessingTask.class]) {
                                [task setTaskCompletedWithSuccess:NO];
                                return;
                            }
                            dispatch_async(work_queue(), ^{
                                adopt((BGContinuedProcessingTask *)task);
                            });
                        }];
    if (accepted) {
        [registered addObject:identifier];
    }
    return accepted;
}

void kladde_continued_begin(const char *name, const char *title) {
    NSString *label = utf8_text(name);
    NSString *heading = utf8_text(title);
    if (label == nil || heading == nil) {
        return;
    }
    dispatch_async(work_queue(), ^{
        prepare();
        NSString *identifier = task_identifier(label);
        [wanted addObject:identifier];
        [expired removeObject:identifier];
        if (!register_once(identifier)) {
            return;
        }
        BGContinuedProcessingTaskRequest *request =
            [[BGContinuedProcessingTaskRequest alloc] initWithIdentifier:identifier
                                                                   title:heading
                                                                subtitle:percent_text(0)];
        request.strategy = BGContinuedProcessingTaskRequestSubmissionStrategyFail;
        submit(request);
    });
}

static void show_progress(NSString *identifier, int64_t done, int64_t total) {
    BGContinuedProcessingTask *task = running[identifier];
    if (task == nil) {
        return;
    }
    task.progress.totalUnitCount = total;
    task.progress.completedUnitCount = done;
    NSNumber *percent = @(done * percent_scale / total);
    if ([shown[identifier] isEqualToNumber:percent]) {
        return;
    }
    shown[identifier] = percent;
    [task updateTitle:task.title subtitle:percent_text((double)done / (double)total)];
}

bool kladde_continued_progress(const char *name, int64_t done, int64_t total) {
    NSString *label = utf8_text(name);
    if (label == nil || total <= 0 || done < 0 || done > total) {
        return true;
    }
    __block BOOL still_wanted = YES;
    dispatch_sync(work_queue(), ^{
        prepare();
        NSString *identifier = task_identifier(label);
        still_wanted = ![expired containsObject:identifier];
        show_progress(identifier, done, total);
    });
    return still_wanted;
}

void kladde_continued_end(const char *name, bool success) {
    NSString *label = utf8_text(name);
    if (label == nil) {
        return;
    }
    dispatch_async(work_queue(), ^{
        prepare();
        NSString *identifier = task_identifier(label);
        [wanted removeObject:identifier];
        [expired removeObject:identifier];
        if (running[identifier] == nil) {
            [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:identifier];
            return;
        }
        finish(identifier, success);
    });
}
#else
static NSMutableDictionary<NSString *, id<NSObject>> *activities;

void kladde_continued_begin(const char *name, const char *title) {
    NSString *label = utf8_text(name);
    NSString *reason = utf8_text(title);
    if (label == nil || reason == nil) {
        return;
    }
    dispatch_async(work_queue(), ^{
        if (!activities) {
            activities = [NSMutableDictionary dictionary];
        }
        if (activities[label]) {
            return;
        }
        activities[label] = [NSProcessInfo.processInfo
            beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
                              reason:reason];
    });
}

bool kladde_continued_progress(__unused const char *name, __unused int64_t done, __unused int64_t total) {
    return true;
}

void kladde_continued_end(const char *name, __unused bool success) {
    NSString *label = utf8_text(name);
    if (label == nil) {
        return;
    }
    dispatch_async(work_queue(), ^{
        id<NSObject> activity = activities[label];
        if (activity == nil) {
            return;
        }
        [NSProcessInfo.processInfo endActivity:activity];
        [activities removeObjectForKey:label];
    });
}
#endif
