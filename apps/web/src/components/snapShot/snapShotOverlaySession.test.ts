import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SNAP_SHOT_RESUME_WINDOW_MS, useSnapShotOverlaySession } from "./snapShotOverlaySession";

describe("useSnapShotOverlaySession", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("ended-thread"));
  afterEach(() => useSnapShotOverlaySession.getState().forgetEnded());

  it("offers an ended conversation until the resume window passes", () => {
    const session = useSnapShotOverlaySession.getState();
    session.endConversation(threadRef, 1_000);

    session.forgetStaleEnded(1_000 + SNAP_SHOT_RESUME_WINDOW_MS - 1);
    expect(useSnapShotOverlaySession.getState().ended?.threadRef).toEqual(threadRef);

    session.forgetStaleEnded(1_000 + SNAP_SHOT_RESUME_WINDOW_MS);
    expect(useSnapShotOverlaySession.getState().ended).toBeNull();
  });
});
