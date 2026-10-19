import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SNAP_SHOT_RESUME_WINDOW_MS,
  isSnapShotOverlayDocked,
  useSnapShotOverlaySession,
} from "./snapShotOverlaySession";

describe("useSnapShotOverlaySession", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("ended-thread"));
  afterEach(() =>
    useSnapShotOverlaySession.setState({
      ended: null,
      hidden: false,
      raisedTurn: null,
      workingTurn: null,
    }),
  );

  it("offers an ended conversation until the resume window passes", () => {
    const session = useSnapShotOverlaySession.getState();
    session.endConversation(threadRef, 1_000);

    session.forgetStaleEnded(1_000 + SNAP_SHOT_RESUME_WINDOW_MS - 1);
    expect(useSnapShotOverlaySession.getState().ended?.threadRef).toEqual(threadRef);

    session.forgetStaleEnded(1_000 + SNAP_SHOT_RESUME_WINDOW_MS);
    expect(useSnapShotOverlaySession.getState().ended).toBeNull();
  });

  it("keeps the composer up for the turn the user brought it up for", () => {
    const session = useSnapShotOverlaySession.getState();
    session.setWorkingTurn("turn-1");
    session.hide();
    expect(isSnapShotOverlayDocked(useSnapShotOverlaySession.getState(), "turn-1")).toBe(true);

    session.show();
    expect(isSnapShotOverlayDocked(useSnapShotOverlaySession.getState(), "turn-1")).toBe(false);
    expect(isSnapShotOverlayDocked(useSnapShotOverlaySession.getState(), "turn-2")).toBe(true);
  });

  it("brings the composer back up when the conversation ends", () => {
    const session = useSnapShotOverlaySession.getState();
    session.hide();
    session.endConversation(threadRef, 1_000);
    expect(isSnapShotOverlayDocked(useSnapShotOverlaySession.getState(), null)).toBe(false);
  });
});
