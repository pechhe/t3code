/**
 * The SnapShot overlay is a second desktop window running this app. It shares
 * the main window's saved state but never writes it back, so the two windows
 * cannot overwrite each other's drafts and layout. Set by the desktop app in
 * the overlay window's URL and fixed for the life of the page.
 */
export const isSnapShotOverlaySurface =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("surface") === "snap-shot-overlay";
