import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  groupScheduledTasks,
  markGroupFailuresSeen,
  planGroupSave,
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
  keepThread: true,
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

  it("keeps an agent's thread binding until the editor lets it go", () => {
    const bound = task({ id: "bound", threadId: ThreadId.make("thread-1") });
    const plan = (keepThread: boolean) =>
      planGroupSave({
        draft: draft({ keepThread }),
        groupId: "g",
        existing: [{ environmentId: mac, task: bound }],
        projects: [t3peach],
      });
    expect(plan(true).upserts[0]?.input.threadId).toBe("thread-1");
    expect(plan(false).upserts[0]?.input.threadId).toBeNull();
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
