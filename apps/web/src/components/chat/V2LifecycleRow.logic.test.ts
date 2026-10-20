import { describe, expect, it } from "vite-plus/test";

import { subagentReturnStatus, subagentReturnVerb } from "./V2LifecycleRow.logic";

describe("subagent return outcomes", () => {
  it.each([
    { outcome: "completed", verb: "returned", status: "completed" },
    { outcome: "failed", verb: "failed", status: "failed" },
    { outcome: "cancelled", verb: "stopped", status: "cancelled" },
    { outcome: "updated", verb: "sent an update", status: null },
    { outcome: "unknown", verb: "returned", status: null },
  ] as const)(
    "describes a $outcome return with its verb and status",
    ({ outcome, verb, status }) => {
      expect(subagentReturnVerb(outcome)).toBe(verb);
      expect(subagentReturnStatus(outcome)).toBe(status);
    },
  );
});
