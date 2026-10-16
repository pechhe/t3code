import { createFileRoute } from "@tanstack/react-router";

import { SnapShotOverlayStart } from "../components/snapShot/SnapShotOverlay";

// The SnapShot overlay window opens here and moves on to its fresh chat's draft route.
export const Route = createFileRoute("/snap-shot")({
  component: SnapShotOverlayStart,
});
