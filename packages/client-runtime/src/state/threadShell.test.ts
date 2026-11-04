import {
  type AgentRole,
  EnvironmentId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
import {
  childThreadInputsTitle,
  createEnvironmentThreadShellAtoms,
  deriveSubagentLiveState,
  directSubagentUnder,
  subagentPanelChildIds,
  subagentActivityLabel,
} from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

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
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("v2 thread shell lists", () => {
  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("keeps side chats out of every list and finds a thread's newest side chat", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const sideChat = (id: string, createdAt: string) => ({
      ...root,
      id: ThreadId.make(id),
      sideChat: true,
      createdAt: DateTime.makeUnsafe(createdAt),
      lineage: { ...root.lineage, parentThreadId: root.id, relationshipToParent: "fork" as const },
    });
    const older = sideChat("side-older", "2026-01-01T00:00:00.000Z");
    const newer = sideChat("side-newer", "2026-01-02T00:00:00.000Z");
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, newer, older],
    });
    const sideChatId = threads.sideChatThreadIdAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const disposeSideChat = registry.mount(sideChatId);
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      root.id,
    ]);
    expect(registry.get(sideChatId)).toBe(newer.id);
    // Every list leaves side chats out; they stay reachable by id.
    expect(registry.get(threads.threadShellsAtom).map((thread) => thread.id)).toEqual([root.id]);
    expect(registry.get(threads.threadRefsAtom).map((ref) => ref.threadId)).toEqual([root.id]);
    expect(registry.get(threads.threadShellAtom({ environmentId, threadId: newer.id }))?.id).toBe(
      newer.id,
    );

    // Keeping the side chat turns it into an ordinary, listed fork.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...newer, sideChat: false }, older],
    });
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      root.id,
      newer.id,
    ]);
    expect(registry.get(sideChatId)).toBe(older.id);

    // Once its parent is gone, a side chat is listed so it can be found and deleted.
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [older] });
    expect(registry.get(threads.threadShellsAtom).map((thread) => thread.id)).toEqual([older.id]);
    disposeSideChat();
    dispose();
    registry.dispose();
  });

  it("counts a subagent question on its parent only while the subagent runs", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "queued" as const }],
    });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "completed" as const, activityRunStatus: null }],
    });
    expect(registry.get(inputs)).toEqual([]);
    const { activityRunStatus: _omitted, ...legacyChild } = child;
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...legacyChild, status: "completed" as const }],
    });
    expect(registry.get(inputs)).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("brings a parent back from Working while a nested subagent waits for approval", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("review"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const grandchild = {
      ...child,
      id: ThreadId.make("review-helper"),
      lineage: { ...child.lineage, parentThreadId: child.id },
    };
    const root = {
      ...v2ThreadShell,
      latestRunId: RunId.make("root-run"),
      status: "completed" as const,
      pendingBackgroundTasks: [
        { taskId: "review", kind: "subagent" as const, childThreadId: child.id },
      ],
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    const parent = threads.threadShellAtom({ environmentId, threadId: root.id });
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const disposeParent = registry.mount(parent);
    const disposeInputs = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, { ...grandchild, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(isThreadWorking(registry.get(parent)!)).toBe(false);
    const asking = registry.get(inputs);
    expect(asking.map((thread) => thread.id)).toEqual([grandchild.id]);
    expect(childThreadInputsTitle(asking)).toBe("Subagent needs approval");

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);
    disposeInputs();
    disposeParent();
    registry.dispose();
  });

  it.each([
    { reason: "switched-off", state: { enabled: false } },
    {
      reason: "unsupported",
      state: { enabled: true, unsupportedReason: "Use a compatible client." },
    },
  ])("leaves $reason environments out of navigation until restored", ({ state }) => {
    const { registry, threads, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const environmentsOf = () =>
      new Set(registry.get(threads.navigationThreadShellsAtom).map((t) => t.environmentId));
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));

    const setRemotePaused = (paused: boolean) => {
      const catalog = registry.get(catalogValueAtom);
      const entries = new Map(catalog.entries);
      entries.set(remoteEnvironmentId, {
        ...entries.get(remoteEnvironmentId)!,
        ...(paused ? state : { enabled: true, unsupportedReason: undefined }),
      });
      registry.set(catalogValueAtom, { ...catalog, entries });
    };
    setRemotePaused(true);
    expect(environmentsOf()).toEqual(new Set([environmentId]));
    setRemotePaused(false);
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));
    dispose();
    registry.dispose();
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });

  it("keeps the quiet shell through streaming ticks and follows every change once the run stops", () => {
    const harness = makeHarness();
    const runId = RunId.make("streaming-run");
    const running: OrchestrationV2ThreadShell = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      itemCount: 1,
      visibleItemCount: 1,
    };
    const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: sequence,
        threads: [thread],
      });
    const at = (seconds: number) => DateTime.add(v2Now, { seconds });
    setThread(running, 1);
    const ref = { environmentId, threadId: v2ThreadShell.id };
    const quietAtom = harness.threads.quietThreadShellAtom(ref);
    const dispose = harness.registry.mount(quietAtom);
    try {
      const first = harness.registry.get(quietAtom);
      setThread({ ...running, updatedAt: at(1), itemCount: 4, visibleItemCount: 3 }, 2);
      expect(harness.registry.get(quietAtom)).toBe(first);
      expect(harness.registry.get(harness.threads.threadShellAtom(ref))?.itemCount).toBe(4);

      setThread({ ...running, updatedAt: at(2), itemCount: 5, title: "Renamed" }, 3);
      const renamed = harness.registry.get(quietAtom);
      expect(renamed?.title).toBe("Renamed");

      const stopped: OrchestrationV2ThreadShell = {
        ...running,
        activeRunId: null,
        status: "completed",
      };
      setThread({ ...stopped, title: "Renamed", updatedAt: at(3) }, 4);
      const completed = harness.registry.get(quietAtom);
      expect(completed).not.toBe(renamed);
      setThread({ ...stopped, title: "Renamed", updatedAt: at(4) }, 5);
      expect(harness.registry.get(quietAtom)?.updatedAt).toBe(DateTime.formatIso(at(4)));
      expect(harness.registry.get(quietAtom)).not.toBe(completed);
    } finally {
      dispose();
      harness.registry.dispose();
    }
  });

  it("keeps the quiet shell list through streaming ticks", () => {
    const harness = makeHarness();
    const runId = RunId.make("streaming-list-run");
    const running: OrchestrationV2ThreadShell = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      itemCount: 1,
      visibleItemCount: 1,
    };
    const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: sequence,
        threads: [thread],
      });
    setThread(running, 1);
    const listAtom = harness.threads.quietThreadShellsAtom;
    const dispose = harness.registry.mount(listAtom);
    try {
      const first = harness.registry.get(listAtom);
      expect(first).toHaveLength(1);
      setThread({ ...running, updatedAt: DateTime.add(v2Now, { seconds: 1 }), itemCount: 4 }, 2);
      expect(harness.registry.get(listAtom)).toBe(first);

      setThread({ ...running, title: "Renamed" }, 3);
      expect(harness.registry.get(listAtom)).not.toBe(first);
      expect(harness.registry.get(listAtom)[0]?.title).toBe("Renamed");
    } finally {
      dispose();
      harness.registry.dispose();
    }
  });
});

describe("thread watchers", () => {
  it("follows watches as they start and end, and ignores other shell updates", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const watched = v2ThreadShell;
    const watcher = {
      ...v2ThreadShell,
      id: ThreadId.make("watcher"),
      title: "Watcher",
      threadWatches: [
        {
          id: "thread-watch:watcher:0",
          target: { kind: "thread" as const, threadId: watched.id },
          title: watched.title,
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    };
    const watchers = threads.threadWatchersAtom({ environmentId, threadId: watched.id });
    const dispose = registry.mount(watchers);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [watched, watcher] });
    const before = registry.get(watchers);
    expect(before).toEqual([{ id: watcher.id, title: "Watcher" }]);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [
        { ...watched, title: "Renamed" },
        { ...watcher, status: "running" as const },
      ],
    });
    expect(registry.get(watchers)).toBe(before);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [watched, { ...watcher, threadWatches: [] }],
    });
    expect(registry.get(watchers)).toEqual([]);
    dispose();
    registry.dispose();
  });
});

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
      shell("one", parent, "implementation-worker"),
      shell("two", parent, "implementation-worker"),
    );
    expect(subagentActivityLabel(activity!)).toBe("2 implementers");
  });

  it("orders the panel by role and leaves provider-native subagents out", () => {
    const threads = [
      shell("advisor", parent, "advisor"),
      shell("implementer", parent, "implementation-worker"),
      shell("native", parent, null, { creationSource: "provider" }),
      shell("lead", parent, "lead"),
      shell("unroled", parent, null),
      shell("below", ThreadId.make("lead"), "implementation-worker"),
    ];
    expect(subagentPanelChildIds(threads, parent)).toEqual([
      "lead",
      "implementer",
      "unroled",
      "advisor",
    ]);
  });

  it("finds the direct child a descendant's request came through", () => {
    const lead = ThreadId.make("lead");
    const below = ThreadId.make("below");
    const { parents } = deriveSubagentLiveState([
      shell("lead", parent, "lead"),
      shell("below", lead, "implementation-worker", question),
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
    const working = activityOf(lead, shell("reviewer", lead.id, "spec-reviewer"));
    expect(subagentActivityLabel(working!)).toBe("Lead");
    const asking = activityOf(lead, shell("reviewer", lead.id, "spec-reviewer", question));
    expect(subagentActivityLabel(asking!)).toBe("Lead input");
  });

  it("reports nothing once its subagents have stopped", () => {
    expect(
      activityOf(shell("lead", parent, "lead", { activityRunStatus: null, status: "completed" })),
    ).toBeUndefined();
  });
});
