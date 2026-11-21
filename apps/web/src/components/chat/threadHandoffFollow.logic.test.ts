import { describe, expect, it } from "vite-plus/test";

import { followMovedThread } from "./threadHandoffFollow.logic";

const there = { environmentId: "environment:box", threadId: "thread:there" };

describe("followMovedThread", () => {
  it("opens the thread there once the open thread is seen moving and then moved", () => {
    const moving = followMovedThread(null, { threadId: "thread:a", moving: true, there: null });
    expect(moving.open).toBeNull();
    expect(
      followMovedThread(moving.seenMoving, { threadId: "thread:a", moving: false, there }),
    ).toEqual({ seenMoving: null, open: there });
  });

  it("shows a thread that had already moved before it was opened", () => {
    expect(followMovedThread(null, { threadId: "thread:a", moving: false, there }).open).toBeNull();
  });

  it("does not carry a move seen on one thread to another", () => {
    expect(
      followMovedThread("thread:a", { threadId: "thread:b", moving: false, there }).open,
    ).toBeNull();
  });
});
