import type { SnapShotKeyChord } from "./settings.ts";

// Shows or hides the SnapShot overlay's conversation without taking a snapshot.
export const DEFAULT_SNAP_SHOT_OVERLAY_SHORTCUT: SnapShotKeyChord = {
  key: " ",
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: true,
  modKey: false,
};
