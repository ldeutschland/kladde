#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>

static OSStatus capturePressed(EventHandlerCallRef next, EventRef event, void *context) {
    (void)next;
    EventHotKeyID key;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(key), NULL, &key) != noErr ||
        key.signature != 'Klde' || key.id != 1) return eventNotHandledErr;
    void (*notify)(void) = context;
    notify();
    return noErr;
}

bool kladde_register_capture(void (*notify)(void)) {
    EventTypeSpec type = { kEventClassKeyboard, kEventHotKeyPressed };
    EventHotKeyID key = { 'Klde', 1 };
    EventHotKeyRef ref = NULL;
    EventHandlerRef handler = NULL;
    if (InstallApplicationEventHandler(capturePressed, 1, &type, notify, &handler) != noErr) return false;
    if (RegisterEventHotKey(kVK_ANSI_N, cmdKey | shiftKey | optionKey, key, GetApplicationEventTarget(), 0, &ref) == noErr) return true;
    RemoveEventHandler(handler);
    return false;
}
