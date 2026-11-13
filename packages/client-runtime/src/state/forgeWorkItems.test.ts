import { describe, expect, it } from "vite-plus/test";

import type {
  ForgeArcRunDetail,
  ForgeArcRunSpec,
  ForgeWorkItemView,
  OrchestrationV2ThreadArcRun,
} from "@t3tools/contracts";

import {
  arcRunChip,
  describeForgeWait,
  presentArcRun,
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
    url: "https://weave.example/build/4059",
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

  it("falls back to #number without a ref, from an older Weave or before anything was read", () => {
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

describe("presentArcRun", () => {
  const spec = (number: number, status: ForgeArcRunSpec["status"], inArc = true) =>
    ({
      number,
      ref: `T3-${number}`,
      title: `Spec ${number}`,
      status,
      url: `https://weave.example/forge/${number}`,
      holds: [],
      waits: [],
      inArc,
      thread: null,
    }) satisfies ForgeArcRunSpec;
  const run = (fields: Partial<OrchestrationV2ThreadArcRun>): OrchestrationV2ThreadArcRun => ({
    arc: { number: 50, ref: "T3-ARC-05" },
    state: "active",
    startedAt: "2026-11-13T10:00:00.000Z",
    progressAt: "2026-11-13T10:00:00.000Z",
    ceilingSince: "2026-11-13T10:00:00.000Z",
    ...fields,
  });
  const detail = (specs: ReadonlyArray<ForgeArcRunSpec>): ForgeArcRunDetail => ({
    arc: { number: 50, ref: "T3-ARC-05", title: "Arc", url: "https://weave.example/forge/50" },
    goal: null,
    specs,
    complete: true,
    readAt: "2026-11-13T10:00:00.000Z",
  });

  it("numbers a named run in plan order and lists the rest of the Arc apart", () => {
    const shown = presentArcRun(
      run({ specs: [3, 2, 4], plan: [2, 3, 4], current: 3 }),
      detail([
        spec(1, "accepted"),
        spec(2, "landed"),
        spec(3, "in_progress"),
        spec(4, "ready"),
        spec(5, "shaping"),
      ]),
    );
    expect(shown.run.map((r) => [r.number, r.position, r.current])).toEqual([
      [2, 1, false],
      [3, 2, true],
      [4, 3, false],
    ]);
    expect(shown.elsewhere.map((r) => r.number)).toEqual([1, 5]);
    expect(shown.notPlanned).toEqual([]);
    expect(shown.bar.map((r) => [r.number, r.outsideRun])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
  });

  it("lists a whole-Arc run's unplanned members apart and keeps a planned Spec that left the Arc", () => {
    const shown = presentArcRun(
      run({ plan: [2, 9] }),
      detail([spec(1, "accepted"), spec(2, "ready"), spec(9, "ready", false)]),
    );
    expect(shown.run.map((r) => [r.number, r.position, r.spec?.inArc])).toEqual([
      [2, 1, true],
      [9, 2, false],
    ]);
    expect(shown.notPlanned.map((r) => r.number)).toEqual([1]);
    expect(shown.elsewhere).toEqual([]);
    expect(shown.bar.map((r) => r.number)).toEqual([2, 1]);
  });

  it("shows a run with no plan unnumbered, from the run alone before Forge is read", () => {
    const shown = presentArcRun(run({ specs: [7, 6], state: "attention" }), null);
    expect(shown.planned).toBe(false);
    expect(shown.state).toBe("attention");
    expect(shown.run.map((r) => [r.number, r.label, r.position])).toEqual([
      [7, "#7", null],
      [6, "#6", null],
    ]);
    expect(arcRunChip(run({ state: "paused" }), null)).toEqual({
      label: "T3-ARC-05",
      state: "paused",
      progress: null,
      complete: true,
    });
  });
});
