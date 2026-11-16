/**
 * Set by the desktop app in the SnapShot overlay window's URL and fixed for the page's life: the
 * overlay is a second window running this app, reading the main window's saved layout without
 * writing it back. Read defensively, because upstream's storage tests stub a bare `window`.
 */
export const isSnapShotOverlaySurface =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location?.search ?? "").get("surface") === "snap-shot-overlay";
