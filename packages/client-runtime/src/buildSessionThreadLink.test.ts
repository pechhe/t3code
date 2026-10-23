import type { ForgeWorkItemSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSessionThreadLink } from "./buildSessionThreadLink.ts";

const session = (sessionRef: string, harness = "t3"): ForgeWorkItemSession => ({
  harness,
  sessionRef,
  activity: "active",
  lastActivityAt: "2026-10-17T10:00:00.000Z",
});

describe("Build session thread links", () => {
  it("resolves a T3 environment/thread reference, including ended sessions", () => {
    const expected = { environmentId: "env-1", threadId: "thread-1" };
    expect(buildSessionThreadLink(session("env-1/thread-1"))).toEqual(expected);
    expect(buildSessionThreadLink({ ...session("env-1/thread-1"), activity: "ended" })).toEqual(
      expected,
    );
  });

  it("preserves percent escapes in a thread id like the existing thread-link parser", () => {
    expect(buildSessionThreadLink(session("env-1/thread%20one"))).toEqual({
      environmentId: "env-1",
      threadId: "thread%20one",
    });
  });

  it.each([
    "",
    "thread-1",
    "/thread-1",
    "env-1/",
    "env/thread/extra",
    "env/ thread",
    "env/thread?x",
    "env/thread#x",
  ])("leaves malformed reference %j as plain text", (ref) =>
    expect(buildSessionThreadLink(session(ref))).toBeNull(),
  );

  it("leaves other harnesses and missing sessions as plain text", () => {
    expect(buildSessionThreadLink(session("env-1/thread-1", "codex"))).toBeNull();
    expect(buildSessionThreadLink(null)).toBeNull();
  });
});
