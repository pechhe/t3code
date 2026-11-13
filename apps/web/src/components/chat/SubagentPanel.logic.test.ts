import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  panelRowThreadIds,
  panelSummaryParts,
  panelWaitKind,
  panelWaitsOnYou,
  stalledChildWithoutRow,
  waitsOnYouText,
} from "./SubagentPanel.logic";

const counts = { subagents: 0, working: 0, stalled: 0, watches: 0, commands: 0, hasStanding: true };
const words = (input: Parameters<typeof panelSummaryParts>[0]) =>
  panelSummaryParts(input)
    .map((part) => part.text)
    .join(" · ");

describe("panel header", () => {
  it("counts what the thread waits on, with a stall apart from the working", () => {
    expect(
      panelSummaryParts({
        ...counts,
        subagents: 4,
        working: 2,
        stalled: 1,
        watches: 1,
        commands: 1,
      }),
    ).toEqual([
      { text: "2 subagents working", tone: "default" },
      { text: "1 stalled", tone: "stalled" },
      { text: "1 watch", tone: "quiet" },
      { text: "1 command", tone: "quiet" },
    ]);
    expect(words({ ...counts, watches: 2, commands: 1 })).toBe("2 watches · 1 command");
  });

  it("ends a lone stalled child's header in the amber stall, not a second subagent", () => {
    expect(panelSummaryParts({ ...counts, subagents: 1, stalled: 1 })).toEqual([
      { text: "1 stalled", tone: "stalled" },
    ]);
    expect(words({ ...counts, subagents: 3, working: 1, stalled: 1 })).toBe(
      "1 subagent working · 1 stalled",
    );
  });

  it("counts parked waits quietly, never as the thread working", () => {
    expect(panelSummaryParts({ ...counts, parked: 2 })).toEqual([
      { text: "2 parked", tone: "parked" },
    ]);
    expect(words({ ...counts, subagents: 1, working: 1, commands: 1, parked: 1 })).toBe(
      "1 subagent working · 1 command · 1 parked",
    );
  });

  it("keeps today's wording when the server sends no standing", () => {
    expect(words({ ...counts, hasStanding: false, subagents: 3, working: 2, watches: 1 })).toBe(
      "3 subagents · 2 working · 1 watch",
    );
  });
});

describe("what waits on the person", () => {
  const watch = (waitsOnPerson?: { need: "acceptance" | "hold"; ref?: string }) =>
    ({
      id: "w",
      title: "t",
      startedAt: "2026-11-10T00:00:00.000Z",
      target: { kind: "build_item", number: 949, until: "landed" },
      ...(waitsOnPerson ? { waitsOnPerson } : {}),
    }) as never;

  it("reads the standing, and an older server's watch only when there is no standing", () => {
    const standing = {
      state: "needs_you",
      waitsOnPerson: { kind: "build_item", number: 949, ref: "YS-949", need: "acceptance" },
    } as const;
    const you = panelWaitsOnYou({ standing, threadWatches: undefined });
    expect(you && waitsOnYouText(you)).toBe("YS-949 awaits your acceptance");
    expect(
      panelWaitsOnYou({ standing: { state: "waiting" }, threadWatches: [watch({ need: "hold" })] }),
    ).toBeNull();
    expect(
      panelWaitsOnYou({ standing: undefined, threadWatches: [watch({ need: "hold" })] }),
    ).toBeNull();
  });
});

describe("panel rows", () => {
  it("files every kind of wait under a section", () => {
    expect(
      (
        [
          "thread",
          "pull_request",
          "build_item",
          "landing",
          "subagent",
          "command",
          "monitor",
          "background_task",
        ] as const
      ).map(panelWaitKind),
    ).toEqual(["watch", "watch", "watch", "watch", "agent", "command", "command", "command"]);
  });

  it("adds a row for a stalled child the panel does not list", () => {
    const stalled = {
      childThreadId: ThreadId.make("deep"),
      title: "Review",
      since: "2026-11-10T00:00:00.000Z",
    };
    expect(stalledChildWithoutRow(stalled, [ThreadId.make("a")])).toBe(stalled);
    expect(stalledChildWithoutRow(stalled, [ThreadId.make("deep")])).toBeNull();
  });
});

describe("a stalled child shown as an agent wait", () => {
  const stalled = {
    childThreadId: ThreadId.make("child"),
    title: "Review",
    since: "2026-11-10T00:00:00.000Z",
  };
  const wait = (childThreadId: string | undefined) =>
    ({ item: { childThreadId: childThreadId as never } }) as never;

  it("is one row: the wait that names the child is its row", () => {
    const ids = panelRowThreadIds([ThreadId.make("a")], [wait("child"), wait(undefined)]);
    expect(ids).toEqual(["a", "child"]);
    expect(stalledChildWithoutRow(stalled, ids)).toBeNull();
    expect(stalledChildWithoutRow(stalled, panelRowThreadIds([], []))).toBe(stalled);
  });
});
