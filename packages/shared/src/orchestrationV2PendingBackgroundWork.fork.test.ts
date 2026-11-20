import { describe, expect, it } from "vite-plus/test";
import { abandonedBackgroundWork, delegatedCompletionHold } from "./delegatedBackgroundWork.ts";

describe("delegatedCompletionHold", () => {
  it.each([
    ["nothing pending", false, []],
    ["a dev server", false, [{ taskId: "dev", kind: "command" }]],
    ["an awaited poll loop", true, [{ taskId: "poll", kind: "command", awaited: true }]],
    ["a monitor", false, [{ taskId: "watch", kind: "monitor" }]],
    ["an awaited monitor", true, [{ taskId: "watch", kind: "monitor", awaited: true }]],
    ["a subagent", true, [{ taskId: "review", kind: "subagent" }]],
    ["work the provider cannot name", true, [{ taskId: "opaque", kind: "background_task" }]],
    ["a pull request watch", true, [{ taskId: "pull-request-watch:a/b#1", kind: "monitor" }]],
  ] as const)("with %s pending, holds: %s", (_case, holds, tasks) => {
    expect(delegatedCompletionHold(tasks)).toBe(holds);
  });
});

describe("abandonedBackgroundWork", () => {
  it("names only the own commands and monitors a result leaves running", () => {
    expect(
      abandonedBackgroundWork([
        { taskId: "bmtw1af16", kind: "command" },
        { taskId: "watch", kind: "monitor" },
        { taskId: "review", kind: "subagent" },
        { taskId: "opaque", kind: "background_task" },
        { taskId: "pull-request-watch:a/b#1", kind: "monitor" },
      ]),
    ).toEqual([
      { taskId: "bmtw1af16", kind: "command" },
      { taskId: "watch", kind: "monitor" },
    ]);
  });
});
