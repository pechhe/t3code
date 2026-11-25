import type { ChampionId, ChampionSummary, EnvironmentId, ScheduledTask } from "@t3tools/contracts";

import type { ScheduledTaskGroup } from "./scheduledTasks.logic";

type NamedChampion = Pick<ChampionSummary, "id" | "name" | "lifecycle">;

export interface EnvironmentChampionList {
  readonly environmentId: EnvironmentId;
  readonly champions: ReadonlyArray<NamedChampion> | null;
}

export interface ChampionChoice {
  readonly id: ChampionId;
  readonly name: string;
  /** The task names a Champion none of the machines lists. */
  readonly missing: boolean;
}

/**
 * The Champions a task may join: those the chosen machines list, retired ones only while
 * selected. A selected id nobody lists stays choosable so a save cannot clear it unseen.
 */
export function championChoices(
  lists: ReadonlyArray<EnvironmentChampionList>,
  machines: ReadonlyArray<EnvironmentId>,
  selected: ChampionId | null,
): ChampionChoice[] {
  const byId = new Map<ChampionId, ChampionChoice>();
  for (const list of lists) {
    if (!machines.includes(list.environmentId)) continue;
    for (const champion of list.champions ?? []) {
      if (champion.lifecycle === "retired" && champion.id !== selected) continue;
      if (!byId.has(champion.id))
        byId.set(champion.id, { id: champion.id, name: champion.name, missing: false });
    }
  }
  if (selected !== null && !byId.has(selected))
    byId.set(selected, { id: selected, name: selected, missing: true });
  return [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Champion a task belongs to, read from the Champions of its own machine. A dangling
 * id (deleted, or defined on another machine) is no Champion: the task shows ungrouped.
 */
function championOfTask(
  environmentId: EnvironmentId,
  task: Pick<ScheduledTask, "championId">,
  lists: ReadonlyArray<EnvironmentChampionList>,
): NamedChampion | null {
  if (task.championId == null) return null;
  return (
    lists
      .find((list) => list.environmentId === environmentId)
      ?.champions?.find((champion) => champion.id === task.championId) ?? null
  );
}

/** A group's Champion: its lead's, since the editor saves one Champion across the group. */
export function championOfGroup(
  group: ScheduledTaskGroup,
  lists: ReadonlyArray<EnvironmentChampionList>,
): NamedChampion | null {
  const lead = group.members.find((member) => member.task === group.lead) ?? group.members[0];
  return lead === undefined ? null : championOfTask(lead.environmentId, lead.task, lists);
}

/** Keeps each Champion's automations together, Champions by name, then the ungrouped. */
export function groupsByChampion(
  groups: ReadonlyArray<ScheduledTaskGroup>,
  lists: ReadonlyArray<EnvironmentChampionList>,
): ScheduledTaskGroup[] {
  const keyed = groups.map((group, index) => ({
    group,
    index,
    name: championOfGroup(group, lists)?.name ?? null,
  }));
  return keyed
    .toSorted((a, b) =>
      a.name === null || b.name === null
        ? a.name === b.name
          ? a.index - b.index
          : a.name === null
            ? 1
            : -1
        : a.name.localeCompare(b.name) || a.index - b.index,
    )
    .map((entry) => entry.group);
}

/** The tasks on one machine that belong to a Champion, in the list's order. */
export function tasksOfChampion(
  tasks: ReadonlyArray<ScheduledTask>,
  championId: ChampionId,
): ScheduledTask[] {
  return tasks.filter((task) => task.championId === championId);
}
