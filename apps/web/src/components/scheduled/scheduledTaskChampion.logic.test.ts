import {
  ChampionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  championChoices,
  groupsByChampion,
  tasksOfChampion,
  type EnvironmentChampionList,
} from "./scheduledTaskChampion.logic";
import { groupScheduledTasks, planGroupSave } from "./scheduledTasks.logic";

const mac = EnvironmentId.make("env-mac");
const box = EnvironmentId.make("env-box");
const watch = ChampionId.make("watch");
const guard = ChampionId.make("guard");

const task = (id: string, championId?: ChampionId | null): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: "Do it",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00" },
  projectId: ProjectId.make("p-1"),
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
  ...(championId === undefined ? {} : { championId }),
});

const lists: ReadonlyArray<EnvironmentChampionList> = [
  {
    environmentId: mac,
    champions: [
      { id: watch, name: "Watch", lifecycle: "active" },
      { id: guard, name: "Guard", lifecycle: "retired" },
    ],
  },
  { environmentId: box, champions: null },
];

describe("championChoices", () => {
  it("lists the chosen machines' Champions, keeping a retired or unknown one only while selected", () => {
    expect(championChoices(lists, [mac], null).map((choice) => choice.id)).toEqual([watch]);
    expect(championChoices(lists, [box], null)).toEqual([]);
    expect(championChoices(lists, [mac], guard).map((choice) => choice.id)).toEqual([guard, watch]);
    expect(championChoices(lists, [mac], ChampionId.make("gone"))).toContainEqual({
      id: "gone",
      name: "gone",
      missing: true,
    });
  });
});

describe("groupsByChampion", () => {
  it("keeps each Champion's tasks together and shows a dangling id ungrouped", () => {
    const groups = groupScheduledTasks([
      {
        environmentId: mac,
        tasks: [task("a"), task("b", watch), task("c", ChampionId.make("gone")), task("d", watch)],
      },
    ]);
    expect(groupsByChampion(groups, lists).map((group) => group.lead.title)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });
});

describe("tasksOfChampion", () => {
  it("selects the tasks naming the Champion", () => {
    expect(
      tasksOfChampion([task("a"), task("b", watch), task("c", guard)], watch).map((t) => t.title),
    ).toEqual(["b"]);
  });
});

describe("planGroupSave championId", () => {
  const draft = {
    title: "T",
    prompt: "P",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 } as const,
    machines: [mac],
    projectKeys: ["k"],
    workspace: "fresh" as const,
    agentRole: null,
    threadMode: "new_thread" as const,
    purpose: "long_running" as const,
  };
  const projects = [
    { key: "k", title: "K", projectIdByEnvironment: new Map([[mac, ProjectId.make("p-1")]]) },
  ];
  const plan = (championId?: ChampionId | null) =>
    planGroupSave({
      draft: { ...draft, ...(championId === undefined ? {} : { championId }) },
      groupId: "g",
      existing: [],
      projects,
    }).upserts[0]?.input;

  it("sends the Champion, sends null to clear, and omits it when the draft has none", () => {
    expect(plan(watch)?.championId).toBe(watch);
    expect(plan(null)?.championId).toBeNull();
    expect(plan() !== undefined && "championId" in plan()!).toBe(false);
  });
});
