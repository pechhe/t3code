/**
 * The JXA helper that reads the frontmost app's first on-screen, layer-0 window
 * and writes it as a PNG at its point size. Shared by the desktop SnapShot
 * service and the voice bridge so both read the same window.
 *
 * One helper run answers one request: it prints "ready", reads a single output
 * path from stdin, prints one JSON reply, and exits. Window titles need Screen
 * Recording. The CoreGraphics query registers osascript as a foreground app, so
 * it goes background-only first. JXA cannot release the image, so each helper
 * serves one capture.
 */
export const MAC_WINDOW_CAPTURE_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
const skipEnv = $.NSProcessInfo.processInfo.environment.objectForKey("T3_CAPTURE_SKIP_BUNDLE_IDS");
const skipBundleIds = skipEnv.isNil()
  ? []
  : String(skipEnv.js)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
function appForPid(pid) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  return app.isNil() ? undefined : app;
}
function frontWindow() {
  const frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (frontmost.isNil()) return undefined;
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  const count = $.CFArrayGetCount(list);
  for (let i = 0; i < count; i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
    const pid = w.objectForKey("kCGWindowOwnerPID").js;
    if (skipBundleIds.length === 0 && pid !== frontmost.processIdentifier) continue;
    const app = appForPid(pid);
    const bundleId = app === undefined ? "" : String(app.bundleIdentifier.js || "");
    // A caller that opened its own window over the app being captured names that
    // window's app here, so the capture falls through to the window behind it.
    if (skipBundleIds.indexOf(bundleId) !== -1) continue;
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    return {
      id: w.objectForKey("kCGWindowNumber").js,
      title: String(ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""),
      bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
      owner: {
        name:
          app === undefined
            ? String(ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || "")
            : String(app.localizedName.js || ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || ""),
        processId: pid,
        path: app === undefined ? "" : String(app.bundleURL.path.js || ""),
        bundleId,
      },
    };
  }
  return undefined;
}
function captureWindow(id, outputPath) {
  const image = $.CGWindowListCreateImage(
    $.CGRectNull,
    $.kCGWindowListOptionIncludingWindow,
    id,
    $.kCGWindowImageBoundsIgnoreFraming | $.kCGWindowImageNominalResolution,
  );
  if (!image || $.CGImageGetWidth(image) === 0) return false;
  const png = $.NSBitmapImageRep.alloc
    .initWithCGImage(image)
    .representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return png.writeToFileAtomically(outputPath, true);
}
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let request = "";
  console.log("ready");
  while (!request.includes("\\n")) {
    const data = input.availableData;
    // JXA bridges NSData.length as a string. Without the coercion EOF never
    // matches, and a helper orphaned by quitting T3 spins forever, still
    // registered as the app, so a relaunch only activates it.
    if (Number(data.length) === 0) return "";
    request += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  }
  const outputPath = request.slice(0, request.indexOf("\\n"));
  const window = frontWindow();
  console.log(JSON.stringify(window ? { window, captured: captureWindow(window.id, outputPath) } : {}));
  return "";
}`;
