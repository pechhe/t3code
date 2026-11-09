import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskThreadMode,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  chosenThreadId,
  groupScheduledTasks,
  matchesTaskPurpose,
  markGroupFailuresSeen,
  moveDraftToThread,
  planGroupSave,
  scheduledTaskDestinationThreads,
  unbindDraftFromThread,
  scheduleDraftOf,
  scheduledSignal,
  timedScheduleOf,
  webhookDeliveryLabel,
  webhookDraftErrors,
  webhookDraftOf,
  webhookScheduleOf,
  workspaceChoiceOf,
  workspaceStrategyFor,
  type GroupDraftFields,
  type TaskPurposeFilter,
  type ProjectChoice,
} from "./scheduledTasks.logic";

const mac = EnvironmentId.make("env-mac");
const box = EnvironmentId.make("env-box");

const task = (overrides: Omit<Partial<ScheduledTask>, "id"> & { id: string }): ScheduledTask => ({
  title: "Triage",
  prompt: "Triage issues",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00" },
  projectId: ProjectId.make("p-mac"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-15T08:00:00.000Z",
  updatedAt: "2026-10-15T08:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
  id: ScheduledTaskId.make(overrides.id),
});

const t3peach: ProjectChoice = {
  key: "repo:t3code",
  title: "T3 Peach",
  projectIdByEnvironment: new Map([
    [mac, ProjectId.make("p-mac")],
    [box, ProjectId.make("p-box")],
  ]),
};
const macOnly: ProjectChoice = {
  key: "repo:splay",
  title: "Splay",
  projectIdByEnvironment: new Map([[mac, ProjectId.make("p-splay")]]),
};

const draft = (overrides: Partial<GroupDraftFields> = {}): GroupDraftFields => ({
  title: "Triage",
  prompt: "Triage issues",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00" },
  machines: [mac],
  projectKeys: [t3peach.key],
  workspace: "fresh",
  agentRole: "chore-worker",
  threadMode: "continue",
  purpose: "long_running",
  ...overrides,
});

describe("groupScheduledTasks", () => {
  it("shows tasks saved together as one, led by the latest edit", () => {
    const groups = groupScheduledTasks([
      { environmentId: mac, tasks: [task({ id: "a", groupId: "g", title: "Old" })] },
      {
        environmentId: box,
        tasks: [
          task({ id: "b", groupId: "g", title: "New", updatedAt: "2026-10-15T09:00:00.000Z" }),
          task({ id: "c", title: "Alone" }),
        ],
      },
    ]);
    expect(groups.map((group) => [group.lead.title, group.members.length])).toEqual([
      ["Alone", 1],
      ["New", 2],
    ]);
  });

  it("filters by why a task exists, whichever thread it runs in", () => {
    const groups = groupScheduledTasks([
      {
        environmentId: mac,
        tasks: [
          task({
            id: "a",
            title: "Look again",
            threadId: ThreadId.make("t"),
            purpose: "check_back",
          }),
          task({ id: "b", title: "Weekly", threadId: ThreadId.make("t"), purpose: "long_running" }),
          task({ id: "c", title: "Unlabelled", threadId: null }),
        ],
      },
    ]);
    const titles = (filter: TaskPurposeFilter) =>
      groups.filter((group) => matchesTaskPurpose(group, filter)).map((group) => group.lead.title);
    expect(titles("all")).toEqual(["Look again", "Unlabelled", "Weekly"]);
    expect(titles("check_back")).toEqual(["Look again"]);
    expect(titles("long_running")).toEqual(["Unlabelled", "Weekly"]);
  });
});

describe("scheduledSignal", () => {
  it("counts failures until the task is opened, and a newer failure counts again", () => {
    const failed = task({
      id: "a",
      lastRunStatus: "failed",
      lastRunAt: "2026-10-15T09:00:00.000Z",
    });
    const groups = groupScheduledTasks([
      {
        environmentId: mac,
        tasks: [failed, task({ id: "b", nextRunAt: "2026-10-16T09:00:00.000Z" })],
      },
    ]);
    const before = scheduledSignal(groups, {});
    expect(before).toEqual({
      nextRunAt: "2026-10-16T09:00:00.000Z",
      running: false,
      unseenFailures: 1,
    });

    const seen = markGroupFailuresSeen(
      groups.find((group) => group.lead.id === failed.id)!,
      {},
    );
    expect(scheduledSignal(groups, seen).unseenFailures).toBe(0);

    const again = groupScheduledTasks([
      { environmentId: mac, tasks: [{ ...failed, lastRunAt: "2026-10-16T09:00:00.000Z" }] },
    ]);
    expect(scheduledSignal(again, seen).unseenFailures).toBe(1);
  });
});

describe("planGroupSave", () => {
  it("keeps existing pairs, adds new ones, deletes dropped ones and skips missing projects", () => {
    const existing = [
      { environmentId: mac, task: task({ id: "keep", projectId: ProjectId.make("p-mac") }) },
      { environmentId: mac, task: task({ id: "drop", projectId: ProjectId.make("p-splay") }) },
    ];
    const plan = planGroupSave({
      draft: draft({ machines: [mac, box], projectKeys: [t3peach.key] }),
      groupId: "g",
      existing,
      projects: [t3peach, macOnly],
    });
    expect(
      plan.upserts.map((entry) => [
        entry.environmentId,
        entry.input.id ?? "new",
        entry.input.projectId,
      ]),
    ).toEqual([
      [mac, "keep", "p-mac"],
      [box, "new", "p-box"],
    ]);
    expect(plan.upserts.every((entry) => entry.input.groupId === "g")).toBe(true);
    expect(plan.deletes).toEqual([{ environmentId: mac, id: "drop" }]);

    const skipped = planGroupSave({
      draft: draft({ machines: [box], projectKeys: [macOnly.key] }),
      groupId: "g",
      existing: [],
      projects: [t3peach, macOnly],
    });
    expect(skipped.upserts).toEqual([]);
    expect(skipped.skipped).toEqual([{ environmentId: box, projectKey: macOnly.key }]);
  });

  it("names a role on every machine so one policy edit reaches every task", () => {
    const existing = [{ environmentId: mac, task: task({ id: "keep" }) }];
    const plan = planGroupSave({
      draft: draft({ machines: [mac, box] }),
      groupId: "g",
      existing,
      projects: [t3peach],
    });
    expect(plan.upserts.map((entry) => entry.input.agentRole)).toEqual([
      "chore-worker",
      "chore-worker",
    ]);
    // The role picks the model, so the save never pins one.
    expect(plan.upserts.every((entry) => entry.input.modelSelection === undefined)).toBe(true);
  });

  it("carries the thread mode the editor chose and drops the binding for a new thread", () => {
    const bound = task({ id: "bound", threadId: ThreadId.make("thread-1") });
    const plan = (threadMode: ScheduledTaskThreadMode) =>
      planGroupSave({
        draft: draft({ threadMode }),
        groupId: "g",
        existing: [{ environmentId: mac, task: bound }],
        projects: [t3peach],
      });
    expect(plan("continue").upserts[0]?.input).toMatchObject({
      threadId: "thread-1",
      threadMode: "continue",
    });
    expect(plan("fresh_session").upserts[0]?.input).toMatchObject({
      threadId: "thread-1",
      threadMode: "fresh_session",
    });
    expect(plan("new_thread").upserts[0]?.input).toMatchObject({
      threadId: null,
      threadMode: "new_thread",
    });
  });

  it("leaves the thread to the first run when no run has bound one yet", () => {
    const plan = planGroupSave({
      draft: draft({ threadMode: "fresh_session" }),
      groupId: "g",
      existing: [],
      projects: [t3peach],
    });
    expect(plan.upserts[0]?.input).toMatchObject({ threadId: null, threadMode: "fresh_session" });
  });
});

describe("workspace choice", () => {
  it("starts a fresh run where a new thread does, with no branch to exist", () => {
    assert.deepEqual(workspaceStrategyFor("fresh", null), { type: "root", rootIsDefault: true });
    assert.equal(workspaceChoiceOf({ type: "root", rootIsDefault: true }), "fresh");
  });

  it("keeps an explicit worktree choice a fresh run was given", () => {
    const worktree = { type: "worktree", baseRef: "origin/release" } as const;
    assert.deepEqual(workspaceStrategyFor("fresh", worktree), worktree);
  });

  it("shows an agent's default workspace as fresh and drops the default when checkout is chosen", () => {
    const agentDefault = { type: "root", rootIsDefault: true } as const;
    expect(workspaceChoiceOf(agentDefault)).toBe("fresh");
    expect(workspaceStrategyFor("fresh", agentDefault)).toEqual(agentDefault);
    expect(workspaceStrategyFor("checkout", agentDefault)).toEqual({
      type: "root",
      rootIsDefault: false,
    });
    expect(workspaceChoiceOf({ type: "root" })).toBe("checkout");
  });
});

describe("schedule drafts", () => {
  it("round-trips weekday, chosen-day and interval triggers", () => {
    for (const schedule of [
      { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 2, 3, 4, 5] },
      { type: "fixed_time", timeOfDay: "18:00", weekdays: [0, 6] },
      { type: "fixed_time", timeOfDay: "07:00" },
      { type: "interval", everyMs: 15 * 60_000 },
      { type: "once", runAt: "2026-11-04T09:00:00.000Z" },
    ] as const) {
      expect(timedScheduleOf(scheduleDraftOf(schedule))).toEqual(schedule);
    }
  });

  it("pads a stored single-digit hour so the time input shows it", () => {
    expect(scheduleDraftOf({ type: "fixed_time", timeOfDay: "9:05" }).timeOfDay).toBe("09:05");
  });

  it("refuses an interval that is not whole minutes", () => {
    expect(
      timedScheduleOf({
        ...scheduleDraftOf({ type: "interval", everyMs: 60_000 }),
        intervalMinutes: "1.5",
      }),
    ).toBeNull();
  });
});

describe("webhook drafts", () => {
  const signature = { header: "x-sig", encoding: "hex", prefix: "sha256=" } as const;
  const blank = webhookDraftOf({ type: "webhook", signature: null });

  it("round-trips dedupe settings, clears them, and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 10,
    };
    const draft = webhookDraftOf({ type: "webhook", signature: null, dedupe });
    expect(webhookScheduleOf(draft)).toMatchObject({ dedupe });
    expect(
      webhookScheduleOf({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      webhookScheduleOf({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(webhookScheduleOf({ ...draft, coalesceWindowSeconds: "" })).toMatchObject({
      dedupe: { replayKey: dedupe.replayKey, coalesceKey: dedupe.coalesceKey },
    });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(webhookScheduleOf({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("sends filters only when the form changed them", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "reopened"] },
    ] as const;
    const draft = webhookDraftOf({ type: "webhook", signature, filters });
    expect(draft.filters.map((filter) => filter.op)).toEqual(["equals", "in"]);
    expect(webhookScheduleOf({ ...draft, signatureSecret: "s" })).not.toHaveProperty("filters");
    expect(webhookScheduleOf({ ...draft, filters: draft.filters.slice(0, 1) })).toMatchObject({
      filters: filters.slice(0, 1),
    });
    // Removing every row is a change, so it clears the stored filters.
    expect(webhookScheduleOf({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(
      webhookScheduleOf({
        ...draft,
        filters: [{ id: "f1", path: "body.action", op: "in", value: " , " }],
      }),
    ).toBeNull();
  });

  it("rejects dedupe templates without a request placeholder", () => {
    expect(webhookScheduleOf({ ...blank, replayKey: "literal" })).toBeNull();
    expect(webhookScheduleOf({ ...blank, coalesceKey: "{{body.bad" })).toBeNull();
  });

  it("keeps the signature secret write-only", () => {
    const draft = webhookDraftOf({ type: "webhook", signature });
    expect(draft.signatureSecret).toBe("");
    expect(webhookScheduleOf(draft)?.signature).toEqual(signature);
    expect(webhookScheduleOf({ ...draft, signatureSecret: " s " })?.signature).toMatchObject({
      secret: "s",
    });
  });
});

describe("webhook delivery labels and validation messages", () => {
  it("preserves Ran for dispatched deliveries and distinguishes pending windows", () => {
    expect(webhookDeliveryLabel({ outcome: "accepted" })).toBe("Ran");
    expect(webhookDeliveryLabel({ outcome: "accepted", pendingWindow: false })).toBe("Ran");
    expect(webhookDeliveryLabel({ outcome: "accepted", pendingWindow: true })).toBe(
      "Opened window",
    );
    expect(webhookDeliveryLabel({ outcome: "filtered" })).toBe("Filtered");
    expect(webhookDeliveryLabel({ outcome: "some_new_outcome" })).toBe("some new outcome");
  });

  it("keeps the age-limit title and body", () => {
    const draft = webhookDraftOf({ type: "webhook", signature: null });
    expect(
      webhookDraftErrors({ ...draft, maxDeliveryAgeMinutes: "0", replayKey: "literal" }),
    ).toEqual([
      {
        title: "Invalid age limit",
        description: "Enter whole minutes from 1 to 1440, or leave it blank.",
      },
    ]);
  });

  it("reports separate short errors when several dedupe fields fail", () => {
    const draft = webhookDraftOf({ type: "webhook", signature: null });
    expect(
      webhookDraftErrors({
        ...draft,
        replayKey: "bad",
        coalesceKey: "bad",
        coalesceWindowSeconds: "0",
      }).map((error) => error.description),
    ).toEqual([
      "Replay key must contain a valid request placeholder.",
      "Coalesce key must contain a valid request placeholder.",
      "Coalesce window must be whole seconds from 10 to 3600.",
    ]);
  });
});

const shell = (
  id: string,
  overrides: Partial<{
    environmentId: EnvironmentId;
    projectId: string;
    title: string;
    updatedAt: string;
    archivedAt: string | null;
    lineage: unknown;
  }> = {},
) =>
  ({
    id: ThreadId.make(id),
    environmentId: mac,
    projectId: ProjectId.make("p-mac"),
    title: id,
    updatedAt: "2026-10-15T08:00:00.000Z",
    archivedAt: null,
    lineage: {},
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

describe("choosing the thread a task posts into", () => {
  const bound = task({ id: "bound", threadId: ThreadId.make("thread-1") });
  const destination = {
    environmentId: mac,
    projectId: ProjectId.make("p-mac"),
    threadId: ThreadId.make("thread-2"),
  };
  const planWith = (fields: Partial<GroupDraftFields>) =>
    planGroupSave({
      draft: draft(fields),
      groupId: "g",
      existing: [{ environmentId: mac, task: bound }],
      projects: [t3peach],
    }).upserts[0]?.input;

  it("saves the picked thread in place of the stored one", () => {
    expect(planWith({ destination })).toMatchObject({ threadId: "thread-2" });
    expect(planWith({ destination: null })).toMatchObject({ threadId: "thread-1" });
  });

  it("binds a task that had no thread yet", () => {
    const plan = planGroupSave({
      draft: draft({ destination }),
      groupId: "g",
      existing: [],
      projects: [t3peach],
    });
    expect(plan.upserts[0]?.input).toMatchObject({ threadId: "thread-2", threadMode: "continue" });
  });

  it("moves a task that started a thread per run into the picked one", () => {
    const moved = moveDraftToThread(
      { threadMode: "new_thread" as ScheduledTaskThreadMode, destination: null },
      { environmentId: mac, projectId: ProjectId.make("p-mac"), id: ThreadId.make("thread-2") },
    );
    expect(moved.threadMode).toBe("continue");
    expect(planWith(moved)).toMatchObject({ threadId: "thread-2", threadMode: "continue" });
    const kept = moveDraftToThread(
      { threadMode: "fresh_session" as ScheduledTaskThreadMode, destination: null },
      { environmentId: mac, projectId: ProjectId.make("p-mac"), id: ThreadId.make("thread-2") },
    );
    expect(kept.threadMode).toBe("fresh_session");
  });

  it("unbinding clears the thread and the pick", () => {
    const unbound = unbindDraftFromThread({
      threadMode: "continue" as ScheduledTaskThreadMode,
      destination,
    });
    expect(planWith(unbound)).toMatchObject({ threadId: null, threadMode: "new_thread" });
  });

  it("drops the pick when the machine or project changes", () => {
    const other = ProjectId.make("p-box");
    expect(chosenThreadId(destination, null, { environmentId: mac, projectId: other })).toBeNull();
    expect(
      chosenThreadId(destination, null, { environmentId: box, projectId: destination.projectId }),
    ).toBeNull();
    const plan = planGroupSave({
      draft: draft({ machines: [box], destination }),
      groupId: "g",
      existing: [],
      projects: [t3peach],
    });
    expect(plan.upserts[0]?.input.threadId).toBeNull();
  });
});

describe("scheduledTaskDestinationThreads", () => {
  const target = {
    environmentId: mac,
    projectId: ProjectId.make("p-mac"),
    currentThreadId: ThreadId.make("current"),
    query: "",
  };

  it("lists open threads of the same machine and project, newest first", () => {
    const threads = [
      shell("old", { updatedAt: "2026-10-01T00:00:00.000Z" }),
      shell("new", { updatedAt: "2026-10-20T00:00:00.000Z" }),
      shell("current"),
      shell("archived", { archivedAt: "2026-10-02T00:00:00.000Z" }),
      shell("elsewhere", { projectId: "p-splay" }),
      shell("other-machine", { environmentId: box }),
      shell("subagent", { lineage: { relationshipToParent: "subagent" } }),
      shell("side-chat", { lineage: { sideChat: true } }),
    ];
    const ids = scheduledTaskDestinationThreads(threads, target).map((thread) => thread.id);
    expect(ids).toEqual(["new", "old"]);
  });

  it("filters by title ignoring case", () => {
    const threads = [shell("a", { title: "Fix Login" }), shell("b", { title: "Deploy" })];
    expect(
      scheduledTaskDestinationThreads(threads, { ...target, query: " login " }).map((t) => t.id),
    ).toEqual(["a"]);
  });
});
