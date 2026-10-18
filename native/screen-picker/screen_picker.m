#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdlib.h>
#include <string.h>

/* Electron presents macOS's content-sharing picker in this process but tells the
 * page only an opaque source id. Observing the same shared picker is the only way
 * to learn what the user chose. The filter must be read during the callback:
 * nothing else keeps it alive once Electron's stream has copied it. */

static NSDictionary *selection;

API_AVAILABLE(macos(14.0))
static NSDictionary *describe_filter(SCContentFilter *filter) {
    NSString *name = nil;
    if (filter.style == SCShareableContentStyleDisplay)
        return @{@"kind" : @"screen", @"name" : NSNull.null};
    if (filter.style == SCShareableContentStyleApplication) {
        if (@available(macOS 15.2, *)) name = filter.includedApplications.firstObject.applicationName;
        return @{@"kind" : @"app", @"name" : name.length > 0 ? name : NSNull.null};
    }
    if (filter.style == SCShareableContentStyleWindow) {
        if (@available(macOS 15.2, *))
            name = filter.includedWindows.firstObject.owningApplication.applicationName;
        return @{@"kind" : @"window", @"name" : name.length > 0 ? name : NSNull.null};
    }
    return nil;
}

API_AVAILABLE(macos(14.0))
@interface T3ScreenPickerObserver : NSObject <SCContentSharingPickerObserver>
@end

@implementation T3ScreenPickerObserver
- (void)contentSharingPicker:(SCContentSharingPicker *)picker
         didUpdateWithFilter:(SCContentFilter *)filter
                   forStream:(SCStream *)stream {
    /* A filter for a running stream edits an earlier capture, not the one being picked. */
    if (stream != nil) return;
    NSDictionary *picked = describe_filter(filter);
    @synchronized([T3ScreenPickerObserver class]) {
        selection = picked;
    }
}
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
}
@end

/* Readies the picker for the next getDisplayMedia() and forgets the last pick. Electron
 * sets the picker's stream limit before activating it, and ScreenCaptureKit only
 * forwards a limit changed while the picker is active. Once the first recording ends,
 * macOS keeps the limit of 0 Electron set then, and withholds every later pick until
 * the request times out. Activating the picker and lifting the limit first lets
 * Electron's own update reach macOS. */
__attribute__((visibility("default"))) void t3_screen_picker_prepare(void) {
    if (@available(macOS 14.0, *)) {
        static T3ScreenPickerObserver *observer;
        SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
        if (observer == nil) {
            observer = [T3ScreenPickerObserver new];
            [picker addObserver:observer];
        }
        @synchronized([T3ScreenPickerObserver class]) {
            selection = nil;
        }
        picker.active = YES;
        picker.maximumStreamCount = nil;
    }
}

/* The last pick since t3_screen_picker_prepare as JSON, or "" when there is none. The
 * string stays valid until the next call. */
__attribute__((visibility("default"))) const char *t3_screen_picker_selection(void) {
    static char *json;
    free(json);
    json = NULL;
    NSDictionary *picked = nil;
    if (@available(macOS 14.0, *)) {
        @synchronized([T3ScreenPickerObserver class]) {
            picked = selection;
        }
    }
    NSData *data = picked ? [NSJSONSerialization dataWithJSONObject:picked options:0 error:nil] : nil;
    json = strndup(data ? data.bytes : "", data.length);
    return json;
}
