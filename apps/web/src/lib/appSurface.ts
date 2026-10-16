/**
 * The SnapShot overlay is a second desktop window running this app. It reads
 * the main window's saved layout but never writes it back, and saves its
 * composer drafts under their own key, so the two windows cannot overwrite each
 * other's. Set by the desktop app in the overlay window's URL and fixed for the
 * life of the page.
 */
export const isSnapShotOverlaySurface =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("surface") === "snap-shot-overlay";
