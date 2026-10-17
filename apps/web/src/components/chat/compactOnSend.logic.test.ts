import { describe, expect, it } from "vite-plus/test";

import { compactOnSendTokens } from "./compactOnSend.logic";

const plainSend = {
  resumeCompactionTokens: 319_000,
  answeringQuestion: false,
  showingPlanFollowUp: false,
  showingResume: false,
  editingQueuedMessage: false,
};

describe("compactOnSendTokens", () => {
  it("offers compaction on a plain send", () => {
    expect(compactOnSendTokens(plainSend)).toBe(319_000);
  });

  it("offers nothing when the thread has nothing to compact", () => {
    expect(compactOnSendTokens({ ...plainSend, resumeCompactionTokens: null })).toBeNull();
  });

  it.each([
    "answeringQuestion",
    "showingPlanFollowUp",
    "showingResume",
    "editingQueuedMessage",
  ] as const)("offers nothing while %s, since that action never compacts", (state) => {
    expect(compactOnSendTokens({ ...plainSend, [state]: true })).toBeNull();
  });
});
