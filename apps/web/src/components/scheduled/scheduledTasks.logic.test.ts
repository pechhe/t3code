import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupScheduledTasks,
  markGroupFailuresSeen,
  planGroupSave,
  scheduleDraftOf,
  scheduledSignal,
  timedScheduleOf,
  type GroupDraftFields,
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

  it("lets a role pick the model, and keeps a fixed model on added machines", () => {
    const existing = [{ environmentId: mac, task: task({ id: "keep" }) }];
    const withRole = planGroupSave({ draft: draft(), groupId: "g", existing, projects: [t3peach] });
    expect(withRole.upserts[0]?.input.modelSelection).toBeUndefined();
    expect(withRole.upserts[0]?.input.agentRole).toBe("chore-worker");

    const fixed = planGroupSave({
      draft: draft({ agentRole: null, machines: [mac, box] }),
      groupId: "g",
      existing,
      projects: [t3peach],
    });
    expect(fixed.upserts.map((entry) => entry.input.modelSelection?.model)).toEqual([
      "gpt-5",
      "gpt-5",
    ]);
  });

  it("keeps an agent's thread binding", () => {
    const bound = task({ id: "bound", threadId: ThreadId.make("thread-1") });
    const plan = planGroupSave({
      draft: draft(),
      groupId: "g",
      existing: [{ environmentId: mac, task: bound }],
      projects: [t3peach],
    });
    expect(plan.upserts[0]?.input.threadId).toBe("thread-1");
  });
});

describe("schedule drafts", () => {
  it("round-trips weekday, chosen-day and interval triggers", () => {
    for (const schedule of [
      { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 2, 3, 4, 5] },
      { type: "fixed_time", timeOfDay: "18:00", weekdays: [0, 6] },
      { type: "fixed_time", timeOfDay: "07:00" },
      { type: "interval", everyMs: 15 * 60_000 },
    ] as const) {
      expect(timedScheduleOf(scheduleDraftOf(schedule))).toEqual(schedule);
    }
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
