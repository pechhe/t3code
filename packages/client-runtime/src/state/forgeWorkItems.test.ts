import { describe, expect, it } from "vite-plus/test";

import type { ForgeWorkItemView } from "@t3tools/contracts";

import {
  describeForgeWait,
  presentForgeCardKind,
  presentForgeWorkItem,
  presentSpecTickets,
} from "./forgeWorkItems.ts";

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

  it("shows an Arc's own ref, full title and status, never a Spec's", () => {
    const shown = presentForgeWorkItem(
      link({
        kind: "arc",
        ref: "YS-ARC-01",
        title: "Get the most out of our agentic engineering setup",
        status: "achieved",
        holds: [],
        waits: [],
      }),
    );
    expect(shown).toMatchObject({
      label: "YS-ARC-01",
      numberHint: "#4059",
      glyph: "◈",
      title: "Get the most out of our agentic engineering setup",
      statusLabel: "Achieved",
      tone: "landed",
    });
  });

  it("falls back to #number without a ref, from an older HQ or before anything was read", () => {
    for (const item of [summary(), summary(null), null]) {
      const shown = presentForgeWorkItem(link(item));
      expect([shown.label, shown.numberHint]).toEqual(["#4059", undefined]);
    }
  });
});

describe("presentForgeCardKind", () => {
  it("names each kind as itself, an Arc never as a Spec", () => {
    expect(presentForgeCardKind({ kind: "arc" })).toBe("◈ Arc");
    expect(
      presentForgeCardKind({
        kind: "spec",
        specKind: "feature",
        horizon: "now",
        ticketCounts: {},
        tickets: [],
        acceptedAt: null,
        governedBy: [],
        lead: null,
      }),
    ).toBe("◇ Spec · feature · now");
    expect(
      presentForgeCardKind({
        kind: "ticket",
        spec: { number: 4059, ref: "YS-12", title: "Friendly numbers", status: "ready" },
        attempts: 0,
        latestAttempt: null,
        lastFailure: null,
        worker: null,
      }),
    ).toBe("▢ Ticket in ◇ Friendly numbers");
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
