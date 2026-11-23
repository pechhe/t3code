import {
  type AgentRole,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

import {
  createEnvironmentThreadShellAtoms,
  deriveSubagentLiveState,
  directSubagentUnder,
  finishedPanelSubagents,
  liveSubagentPanelChildIds,
  subagentPanelChildIds,
  subagentActivityLabel,
} from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom,
      hiddenThreadTagsAtom: () => Atom.make(null),
    }),
  };
}

describe("subagent live state", () => {
  const startedAt = DateTime.makeUnsafe("2026-11-04T12:00:00.000Z");
  const parent = ThreadId.make("parent");
  const shell = (
    id: string,
    parentThreadId: ThreadId,
    role: AgentRole | null,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    lineage: { ...v2ThreadShell.lineage, parentThreadId, relationshipToParent: "subagent" },
    ...(role === null ? {} : { agentTask: { role } as OrchestrationV2ThreadShell["agentTask"] }),
    activityRunStatus: "running",
    activityRunStartedAt: startedAt,
    ...overrides,
  });
  const activityOf = (...threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    deriveSubagentLiveState(threads).activity.get(parent);
  const question = {
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind: "user_input",
      createdAt: startedAt,
    },
  } as const;

  it("names an implementer briefly in a row's status", () => {
    const activity = activityOf(
      shell("one", parent, "implementer"),
      shell("two", parent, "implementer"),
    );
    expect(subagentActivityLabel(activity!)).toBe("2 implementers");
  });

  describe("finished panel subagents", () => {
    const record = (
      childThreadId: string,
      status: OrchestrationV2Subagent["status"],
      completedAt: string | null,
      origin: OrchestrationV2Subagent["origin"] = "app_owned",
    ) =>
      ({
        childThreadId: ThreadId.make(childThreadId),
        status,
        origin,
        completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
      }) as OrchestrationV2Subagent;
    const since = DateTime.makeUnsafe("2026-11-04T12:00:00.000Z");
    const live = [ThreadId.make("live")];
    const ids = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
      subagents.map((subagent) => subagent.childThreadId);
    const seenIds = (seen: ReadonlySet<ThreadId>) => [...seen].toSorted();

    it("lists every finished child newest first, seen if it finished before the user last wrote", () => {
      const { finished, seen } = finishedPanelSubagents({
        subagents: [
          record("before", "completed", "2026-11-04T11:00:00.000Z"),
          record("older", "completed", "2026-11-04T12:01:00.000Z"),
          record("newer", "failed", "2026-11-04T12:02:00.000Z"),
          record("native", "completed", "2026-11-04T12:03:00.000Z", "provider_native"),
          record("live", "completed", "2026-11-04T12:04:00.000Z"),
          record("running", "running", null),
        ],
        liveIds: live,
        since,
      });
      expect(ids(finished)).toEqual(["newer", "older", "before"]);
      expect(seenIds(seen)).toEqual(["before"]);
    });

    it("drops what finished before the user last had the thread open", () => {
      const subagents = [
        record("seen", "completed", "2026-11-04T12:01:00.000Z"),
        record("unseen", "completed", "2026-11-04T12:10:00.000Z"),
      ];
      const input = { subagents, liveIds: live, since };
      const seenAt = (at: string | undefined) =>
        seenIds(finishedPanelSubagents({ ...input, seenAt: at }).seen);
      expect(seenAt("2026-11-04T12:05:00.000Z")).toEqual(["seen"]);
      expect(seenAt("2026-11-04T11:00:00.000Z")).toEqual([]);
      expect(seenAt(undefined)).toEqual([]);
    });

    it("judges a child by its latest record", () => {
      const { finished } = finishedPanelSubagents({
        subagents: [
          record("again", "completed", "2026-11-04T12:01:00.000Z"),
          record("again", "running", null),
        ],
        liveIds: live,
        since,
      });
      expect(finished).toEqual([]);
    });

    it("keeps a settled thread's finished children once nothing runs", () => {
      const subagents = [record("done", "completed", "2026-11-04T12:01:00.000Z")];
      expect(ids(finishedPanelSubagents({ subagents, liveIds: [], since }).finished)).toEqual([
        "done",
      ]);
    });
  });

  it("orders the panel by role and leaves provider-native subagents and side chats out", () => {
    const threads = [
      shell("advisor", parent, "advisor"),
      shell("implementer", parent, "implementer"),
      shell("native", parent, null, { creationSource: "provider" }),
      shell("side-chat", parent, null, {
        lineage: {
          ...v2ThreadShell.lineage,
          parentThreadId: parent,
          relationshipToParent: "fork",
          sideChat: true,
        },
      }),
      shell("lead", parent, "lead"),
      shell("unroled", parent, null),
      shell("below", ThreadId.make("lead"), "implementer"),
    ];
    expect(subagentPanelChildIds(threads, parent)).toEqual([
      "lead",
      "implementer",
      "unroled",
      "advisor",
    ]);
  });

  it("keeps a revived child in the panel though its task record is finished", () => {
    const task = (child: string, status: OrchestrationV2Subagent["status"]) =>
      ({
        childThreadId: ThreadId.make(child),
        status,
        origin: "app_owned",
      }) as OrchestrationV2Subagent;
    const thread = (id: string) => shell(id, parent, "lead");
    const threads = ["revived", "foreground", "idle", "pending"].map(thread);
    const childIds = subagentPanelChildIds(threads, parent);
    const { statuses } = deriveSubagentLiveState(
      ["revived", "foreground", "pending"]
        .map(thread)
        .concat(shell("idle", parent, "lead", { activityRunStatus: null })),
    );
    expect(
      liveSubagentPanelChildIds({
        childIds,
        pendingChildIds: new Set([ThreadId.make("pending")]),
        liveChildIds: childIds.filter((id) => statuses.has(id)),
        subagents: [
          task("revived", "failed"),
          task("foreground", "running"),
          task("idle", "failed"),
          task("pending", "completed"),
        ],
      }),
    ).toEqual(["revived", "pending"]);
  });

  it("finds the direct child a descendant's request came through", () => {
    const lead = ThreadId.make("lead");
    const below = ThreadId.make("below");
    const { parents } = deriveSubagentLiveState([
      shell("lead", parent, "lead"),
      shell("below", lead, "implementer", question),
    ]);
    expect(directSubagentUnder(parents, parent, below)).toBe(lead);
    expect(directSubagentUnder(parents, parent, lead)).toBe(lead);
    expect(directSubagentUnder(parents, ThreadId.make("elsewhere"), below)).toBeNull();
  });

  it("speaks for a working lead over a working advisor, with the lead's timer", () => {
    const activity = activityOf(shell("advisor", parent, "advisor"), shell("lead", parent, "lead"));
    expect(activity).toEqual({
      status: "working",
      role: "lead",
      count: 1,
      startedAt: DateTime.formatIso(startedAt),
    });
    expect(subagentActivityLabel(activity!)).toBe("Lead");
  });

  it("does not let a waiting lead hide an advisor that is working", () => {
    const activity = activityOf(
      shell("lead", parent, "lead", { blockedOnThreadWait: true }),
      shell("advisor", parent, "advisor"),
    );
    expect(subagentActivityLabel(activity!)).toBe("Advisor");
  });

  it("counts several working leads and drops the timer they do not share", () => {
    const activity = activityOf(
      shell("a", parent, "lead"),
      shell("b", parent, "lead"),
      shell("c", parent, "lead", { blockedOnThreadWait: true }),
    );
    expect(activity?.startedAt).toBeNull();
    expect(subagentActivityLabel(activity!)).toBe("2 leads");
  });

  it("lets a question outrank work and names who asks", () => {
    const activity = activityOf(
      shell("lead", parent, "lead"),
      shell("advisor", parent, "advisor", question),
    );
    expect(subagentActivityLabel(activity!)).toBe("Advisor input");
  });

  it("raises a lead by what the helpers under it are doing", () => {
    const lead = shell("lead", parent, "lead", { blockedOnThreadWait: true });
    const working = activityOf(lead, shell("reviewer", lead.id, "reviewer"));
    expect(subagentActivityLabel(working!)).toBe("Lead");
    const asking = activityOf(lead, shell("reviewer", lead.id, "reviewer", question));
    expect(subagentActivityLabel(asking!)).toBe("Lead input");
  });

  it("reports nothing once its subagents have stopped", () => {
    expect(
      activityOf(shell("lead", parent, "lead", { activityRunStatus: null, status: "completed" })),
    ).toBeUndefined();
    expect(
      activityOf(
        shell("lead", parent, "lead", {
          activityRunStatus: null,
          status: "completed",
          parkedWaits: [
            {
              id: "wait:time",
              title: "quota reset",
              startedAt: "2026-11-19T01:00:00.000Z",
              target: { kind: "time", at: "2026-11-19T02:26:00.000Z" },
            },
          ],
        }),
      ),
    ).toMatchObject({ status: "waiting", role: "lead", count: 1 });
  });
});

it("hides champion owners from shared lists until the thread itself waits on someone", () => {
  const harness = makeHarness();
  const champion = { ...v2ThreadShell, champion: { id: "quality", attention: false } };
  const list = harness.threads.quietThreadShellsAtom;
  const projectList = harness.threads.threadShellsForProjectRefsAtom([
    { environmentId, projectId: champion.projectId },
  ]);
  const direct = harness.threads.threadShellAtom({ environmentId, threadId: champion.id });
  const disposeList = harness.registry.mount(list);
  const disposeProject = harness.registry.mount(projectList);
  const disposeDirect = harness.registry.mount(direct);
  try {
    harness.registry.set(harness.snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [champion],
    });
    expect(harness.registry.get(list)).toEqual([]);
    expect(harness.registry.get(projectList)).toEqual([]);
    expect(harness.registry.get(direct)?.id).toBe(champion.id);
    harness.registry.set(harness.snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...champion, champion: { id: "quality", attention: true } }],
    });
    // Champion attention shows on the Champion page, not as a listed thread.
    expect(harness.registry.get(list)).toEqual([]);
    harness.registry.set(harness.snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [
        {
          ...champion,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input" as const,
            createdAt: v2Now,
          },
        },
      ],
    });
    expect(harness.registry.get(list).map((t) => t.id)).toEqual([champion.id]);
    expect(harness.registry.get(projectList).map((t) => t.id)).toEqual([champion.id]);
  } finally {
    disposeList();
    disposeProject();
    disposeDirect();
    harness.registry.dispose();
  }
});
