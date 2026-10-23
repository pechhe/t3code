import { describe, expect, it } from "vite-plus/test";

import type { ForgeWorkItemView } from "@t3tools/contracts";

import { describeForgeWait, presentForgeWorkItem, presentSpecTickets } from "./forgeWorkItems.ts";

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

describe("describeForgeWait", () => {
  it("says what the blocker must reach before the item starts", () => {
    expect(
      describeForgeWait({
        number: 1_000_079,
        title: "Link",
        status: "landed",
        required: "accepted",
      }),
    ).toEqual({
      blocker: "#1000079 Link",
      status: "Landed",
      startsWhen: "Starts when it is accepted.",
    });
  });
});

describe("presentForgeWorkItem", () => {
  const link = (item: ForgeWorkItemView["item"]): ForgeWorkItemView => ({
    itemId: "item-1",
    number: 4059,
    url: "https://hq.example/build/4059",
    item,
    unavailable: false,
    readAt: null,
  });
  const summary = (ref?: string | null) => ({
    kind: "spec" as const,
    ...(ref === undefined ? {} : { ref }),
    title: "Friendly numbers",
    status: "ready" as const,
    holds: [],
    waits: [],
  });

  it("labels an item by its ref, with the canonical number as the hint", () => {
    const shown = presentForgeWorkItem(link(summary("YS-12")));
    expect([shown.label, shown.numberHint]).toEqual(["YS-12", "#4059"]);
  });

  it("falls back to #number without a ref, from an older HQ or before anything was read", () => {
    for (const item of [summary(), summary(null), null]) {
      const shown = presentForgeWorkItem(link(item));
      expect([shown.label, shown.numberHint]).toEqual(["#4059", undefined]);
    }
  });
});

describe("describeForgeWait with a ref", () => {
  it("names the blocker by its ref", () => {
    expect(
      describeForgeWait({
        number: 3751,
        ref: "YS-9",
        title: "Projects",
        status: "ready",
        required: "landed",
      }).blocker,
    ).toBe("YS-9 Projects");
  });
});
