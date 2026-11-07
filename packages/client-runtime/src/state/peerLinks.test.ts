import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { threadHandoffNotice } from "./peerLinks.ts";

describe("threadHandoffNotice", () => {
  const base = {
    handoffId: "h",
    environmentId: EnvironmentId.make("environment-box"),
    label: "Box",
  };
  it("tells the user a waiting move can still be cancelled", () => {
    expect(threadHandoffNotice({ ...base, state: "pending" })?.detail).toBe(
      "Send a message to keep it here instead.",
    );
  });
  it("marks the copy left behind as read-only, and a failure with its reason", () => {
    expect(
      threadHandoffNotice({ ...base, state: "departed", threadId: "thread:x" as never }),
    ).toMatchObject({ title: "This thread continues on Box", detail: "This copy is read-only." });
    expect(
      threadHandoffNotice({ ...base, state: "failed", lastError: "Push the branch." }),
    ).toEqual({
      tone: "error",
      title: "Could not move to Box",
      detail: "Push the branch.",
    });
    expect(threadHandoffNotice(null)).toBeNull();
  });
  it("says a move whose answer was lost is still being checked", () => {
    expect(
      threadHandoffNotice({ ...base, state: "departing", lastError: "It stopped answering." }),
    ).toEqual({
      tone: "warning",
      title: "Checking whether it reached Box",
      detail:
        "It stopped answering. It stays read-only here until Box answers, or until you unlink Box.",
    });
  });
});
