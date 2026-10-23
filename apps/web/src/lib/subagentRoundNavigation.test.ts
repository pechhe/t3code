import { describe, expect, it } from "vite-plus/test";

import { subagentRoundHash, subagentRoundTaskIdFromLocation } from "./subagentRoundNavigation";

describe("subagent round anchors", () => {
  it("round-trips a delegated task id through a thread URL hash", () => {
    const href = `http://localhost/thread#${subagentRoundHash("node:delegated-task:command%3Amcp%3Areview-2")}`;
    expect(subagentRoundTaskIdFromLocation(href)).toBe(
      "node:delegated-task:command%3Amcp%3Areview-2",
    );
  });

  it("ignores a thread URL without a round anchor", () => {
    expect(subagentRoundTaskIdFromLocation("http://localhost/env/thread")).toBeNull();
    expect(subagentRoundTaskIdFromLocation("http://localhost/env/thread#other=1")).toBeNull();
    expect(
      subagentRoundTaskIdFromLocation("http://localhost/env/thread#subagent-round="),
    ).toBeNull();
  });

  it("ignores a malformed anchor instead of throwing", () => {
    expect(
      subagentRoundTaskIdFromLocation("http://localhost/env/thread#subagent-round=%E0%A4%A"),
    ).toBeNull();
  });
});
