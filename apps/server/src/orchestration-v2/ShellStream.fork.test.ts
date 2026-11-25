import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ShellSnapshot, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

import { withoutChampionThreads } from "./ChampionThreadVisibility.ts";

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

describe("withoutChampionThreads", () => {
  const champion = { id: "c", attention: false };
  const quiet = {
    pendingRuntimeRequest: null,
    pendingReleaseApprovals: [],
    hasActionableProposedPlan: false,
    pendingGuestMessageCount: 0,
  };
  const check = shellFixture({ id: ThreadId.make("check"), champion, ...quiet });
  const waiting = shellFixture({
    id: ThreadId.make("waiting"),
    champion,
    ...quiet,
    hasActionableProposedPlan: true,
  });
  const ordinary = shellFixture({ id: ThreadId.make("ordinary"), ...quiet });
  const withKind = (id: string, kind: "owner" | "setup" | "escalation") =>
    shellFixture({ id: ThreadId.make(id), champion: { ...champion, kind }, ...quiet });

  it("lists escalation threads for shipped clients while owner and setup threads stay hidden", () => {
    const item = withoutChampionThreads({
      kind: "snapshot",
      snapshot: {
        ...emptyShellSnapshot,
        threads: [withKind("o", "owner"), withKind("s", "setup"), withKind("e", "escalation")],
      },
    });
    expect(item.kind === "snapshot" && item.snapshot.threads.map((thread) => thread.id)).toEqual([
      "e",
    ]);
  });

  it("keeps a quiet Champion thread out of a snapshot, and one that waits on the person in", () => {
    const item = withoutChampionThreads({
      kind: "snapshot",
      snapshot: { ...emptyShellSnapshot, threads: [check, waiting, ordinary] },
    });
    expect(item.kind === "snapshot" && item.snapshot.threads.map((thread) => thread.id)).toEqual([
      "waiting",
      "ordinary",
    ]);
  });

  it("turns a quiet Champion thread's update into a removal and passes other updates through", () => {
    const update = (thread: OrchestrationV2ThreadShell) =>
      ({ kind: "thread.updated", sequence: 4, location: "active", thread }) as const;
    expect(withoutChampionThreads(update(check))).toEqual({
      kind: "thread.removed",
      sequence: 4,
      location: "active",
      threadId: "check",
    });
    expect(withoutChampionThreads(update(waiting))).toEqual(update(waiting));
    expect(withoutChampionThreads(update(ordinary))).toEqual(update(ordinary));
  });
});
