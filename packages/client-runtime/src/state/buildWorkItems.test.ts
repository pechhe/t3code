import { describe, expect, it } from "vite-plus/test";

import { describeBuildWait, presentSpecTickets } from "./buildWorkItems.ts";

describe("presentSpecTickets", () => {
  it("fills the bar landed first, skips empty statuses and counts the Tickets not listed", () => {
    const shown = presentSpecTickets({
      kind: "spec",
      specKind: "feature",
      horizon: "now",
      ticketCounts: { ready: 3, landed: 2, dropped: 1 },
      tickets: [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `T${n}`, status: "ready" })),
      acceptedAt: null,
      governedBy: [],
      lead: null,
    });
    expect(shown.total).toBe(6);
    expect(shown.more).toBe(1);
    expect(shown.segments.map(({ status, count, tone }) => [status, count, tone])).toEqual([
      ["landed", 2, "landed"],
      ["ready", 3, "not-started"],
      ["dropped", 1, "dropped"],
    ]);
  });
});

describe("describeBuildWait", () => {
  it("says what the blocker must reach before the item starts", () => {
    expect(
      describeBuildWait({ number: 1_000_079, title: "Link", status: "landed", required: "accepted" }),
    ).toEqual({
      blocker: "#1000079 Link",
      status: "Landed",
      startsWhen: "Starts when it is accepted.",
    });
  });
});
