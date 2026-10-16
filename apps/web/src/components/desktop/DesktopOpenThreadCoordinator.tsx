import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";

/** Opens the thread the desktop app asks for, such as one sent from the SnapShot overlay. */
export function DesktopOpenThreadCoordinator() {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.onOpenThread?.((threadRef) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }),
    [navigate],
  );
  return null;
}
