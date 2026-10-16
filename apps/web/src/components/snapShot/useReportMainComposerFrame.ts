import { useEffect } from "react";

import { observeResize } from "../../lib/observeResize";

/**
 * Tells the desktop app where the main window's composer rests: its column, whose bottom edge
 * is where the composer sits once docked, and the composer's width. The SnapShot overlay puts
 * its composer in the same place.
 */
export function useReportMainComposerFrame(
  composerOverlayElement: HTMLElement | null,
  enabled: boolean,
): void {
  useEffect(() => {
    const setFrame = window.desktopBridge?.setMainComposerFrame;
    const stack = composerOverlayElement?.querySelector<HTMLElement>("[data-chat-composer-stack]");
    if (!enabled || !composerOverlayElement || !stack || !setFrame) return;
    let reported = "";
    const report = () => {
      const column = composerOverlayElement.getBoundingClientRect();
      const composer = stack.getBoundingClientRect();
      if (composer.width <= 0 || column.height <= 0) return;
      const frame = {
        x: composer.left,
        y: column.top,
        width: composer.width,
        height: column.height,
      };
      const key = `${frame.x},${frame.y},${frame.width},${frame.height}`;
      if (key === reported) return;
      reported = key;
      void setFrame(frame).catch(() => undefined);
    };
    report();
    const stopObserving = observeResize([composerOverlayElement, stack], report);
    window.addEventListener("resize", report);
    return () => {
      stopObserving();
      window.removeEventListener("resize", report);
    };
  }, [composerOverlayElement, enabled]);
}
