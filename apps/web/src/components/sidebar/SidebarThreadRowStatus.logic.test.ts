import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadRowStatus } from "./SidebarThreadRowStatus.logic";

const waitingOnAcceptance = (waitsOnPerson: { ref?: string; number?: number }) =>
  resolveSidebarThreadRowStatus({
    thread: {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      standing: { state: "needs_you", waitsOnPerson: { need: "acceptance", ...waitsOnPerson } },
    } as unknown as SidebarThreadSummary,
    status: "waiting",
    isUnread: false,
    isWoke: false,
    isActive: false,
    isSelected: false,
    variantAction: "settle",
    subagentActivity: null,
    resolve: m,
  }).topStatus?.label;

describe("resolveSidebarThreadRowStatus", () => {
  it("names the item a thread waits on its owner to accept", () => {
    expect(waitingOnAcceptance({ ref: "T3-789", number: 8335 })).toBe("Needs you · accept T3-789");
    expect(waitingOnAcceptance({ number: 8335 })).toBe("Needs you · accept #8335");
  });
});
