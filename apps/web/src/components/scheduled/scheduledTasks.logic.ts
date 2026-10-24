import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  EnvironmentId,
  isWebhookDedupeTemplate,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  ScheduledTaskId,
  type AgentPolicyManifest,
  type AgentRole,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderDriverKind,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

/** `/scheduled?environmentId=…&taskId=…` opens that task. */
export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

/** One stored task: it runs on one machine, in one project. */
export interface ScheduledTaskMember {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

/**
 * What the page shows as one task: tasks saved together share a groupId, one per
 * machine and project. A task saved alone (or by an agent) is a group of one.
 */
export interface ScheduledTaskGroup {
  readonly key: string;
  readonly members: ReadonlyArray<ScheduledTaskMember>;
  /** The most recently edited member, whose title, prompt and trigger the group shows. */
  readonly lead: ScheduledTask;
}

const memberKey = (environmentId: EnvironmentId, id: ScheduledTaskId | string) =>
  `${environmentId}:${id}`;

export function groupScheduledTasks(
  sources: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<ScheduledTask>;
  }>,
): ScheduledTaskGroup[] {
  const groups = new Map<string, ScheduledTaskMember[]>();
  for (const { environmentId, tasks } of sources) {
    for (const task of tasks) {
      const key = task.groupId ?? memberKey(environmentId, task.id);
      const members = groups.get(key) ?? [];
      members.push({ environmentId, task });
      groups.set(key, members);
    }
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const lead = members.reduce((latest, member) =>
        member.task.updatedAt > latest.task.updatedAt ? member : latest,
      ).task;
      return { key, members, lead };
    })
    .toSorted((a, b) => a.lead.title.localeCompare(b.lead.title) || a.key.localeCompare(b.key));
}

export type GroupStatus = "running" | "failed" | "paused" | "ready";

export function groupStatus(group: ScheduledTaskGroup): GroupStatus {
  const tasks = group.members.map((member) => member.task);
  if (tasks.some((task) => task.lastRunStatus === "running")) return "running";
  if (tasks.some((task) => task.lastRunStatus === "failed")) return "failed";
  if (tasks.every((task) => !task.enabled)) return "paused";
  return "ready";
}

/** The soonest upcoming run across enabled tasks; webhook and paused tasks have none. */
export function soonestRunAt(tasks: ReadonlyArray<ScheduledTask>): string | null {
  let soonest: string | null = null;
  for (const task of tasks) {
    if (!task.enabled || task.nextRunAt === null) continue;
    if (soonest === null || task.nextRunAt < soonest) soonest = task.nextRunAt;
  }
  return soonest;
}

/** Last-run time of each failed task the user has opened, keyed by `memberKey`. */
export type SeenFailures = Readonly<Record<string, string>>;

const isUnseenFailure = (member: ScheduledTaskMember, seen: SeenFailures) =>
  member.task.lastRunStatus === "failed" &&
  member.task.lastRunAt !== null &&
  seen[memberKey(member.environmentId, member.task.id)] !== member.task.lastRunAt;

/**
 * The sidebar's Scheduled signal: the next run time normally, a running dot while a
 * task runs, and a count only of failures the user has not opened.
 */
export function scheduledSignal(groups: ReadonlyArray<ScheduledTaskGroup>, seen: SeenFailures) {
  const members = groups.flatMap((group) => group.members);
  return {
    nextRunAt: soonestRunAt(members.map((member) => member.task)),
    running: members.some((member) => member.task.lastRunStatus === "running"),
    unseenFailures: groups.filter((group) =>
      group.members.some((member) => isUnseenFailure(member, seen)),
    ).length,
  };
}

/** Records the group's current failures as seen; keeps entries for other tasks. */
export function markGroupFailuresSeen(group: ScheduledTaskGroup, seen: SeenFailures): SeenFailures {
  const unseen = group.members.filter((member) => isUnseenFailure(member, seen));
  if (unseen.length === 0) return seen;
  const next: Record<string, string> = { ...seen };
  for (const member of unseen) {
    next[memberKey(member.environmentId, member.task.id)] = member.task.lastRunAt ?? "";
  }
  return next;
}

/** The model and effort a role prefers in a policy; the server resolves the final choice. */
export function roleModelSummary(
  manifest: AgentPolicyManifest,
  role: AgentRole,
): {
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly effort: string | null;
} | null {
  const policy = manifest.roles[role];
  if (policy === undefined) return null;
  const first = manifest.lists[policy.list]?.[0];
  if (first === undefined) return null;
  const binding = manifest.models[first.model];
  if (binding === undefined) return null;
  return { driverKind: binding.driverKind, model: binding.model, effort: first.effort ?? null };
}

export type WorkspaceChoice = "fresh" | "checkout";

/**
 * Where a run works. "fresh" gives each run its own checkout: a SlipJay workspace from
 * the integration branch in a SlipJay project, a Git worktree from the checkout's
 * current commit otherwise; a task created by an agent runs where a new thread does,
 * which also counts as "fresh". "checkout" runs in the project folder itself, in a
 * SlipJay project too.
 */
export function workspaceStrategyFor(
  choice: WorkspaceChoice,
  previous: OrchestrationV2ThreadLaunchWorkspaceStrategy | null,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (choice === "checkout") {
    if (isDefaultWorkspace(previous)) return { type: "root", rootIsDefault: false };
    return previous?.type === "root" || previous?.type === "existing_worktree"
      ? previous
      : { type: "root" };
  }
  if (
    previous?.type === "worktree" ||
    (previous?.type === "root" && previous.rootIsDefault === true)
  ) {
    return previous;
  }
  return { type: "worktree", baseRef: "HEAD" };
}

const isDefaultWorkspace = (
  strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | null,
): boolean => strategy?.type === "root" && strategy.rootIsDefault === true;

export const workspaceChoiceOf = (
  strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
): WorkspaceChoice =>
  strategy.type === "worktree" || isDefaultWorkspace(strategy) ? "fresh" : "checkout";

/** A project as the page offers it: one chip per repository, present on some machines. */
export interface ProjectChoice {
  readonly key: string;
  readonly title: string;
  readonly projectIdByEnvironment: ReadonlyMap<EnvironmentId, ProjectId>;
}

export interface GroupSavePlan {
  readonly upserts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly input: ScheduledTaskUpsertInput;
  }>;
  readonly deletes: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ScheduledTaskId;
  }>;
  /** Selected projects that a selected machine does not have; nothing runs there. */
  readonly skipped: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectKey: string;
  }>;
}

export interface GroupDraftFields {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule: ScheduledTaskUpsertSchedule;
  readonly machines: ReadonlyArray<EnvironmentId>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly workspace: WorkspaceChoice;
  readonly agentRole: AgentRole;
  /** Keeps posting into the thread a task was bound to; false starts a new thread each run. */
  readonly keepThread: boolean;
}

/**
 * Turns the editor's selection into one stored task per machine and project. A pair
 * that already has a task keeps it (its id, run history and webhook URL); new pairs
 * are created and pairs no longer selected are deleted.
 */
export function planGroupSave(input: {
  readonly draft: GroupDraftFields;
  readonly groupId: string;
  readonly existing: ReadonlyArray<ScheduledTaskMember>;
  readonly projects: ReadonlyArray<ProjectChoice>;
}): GroupSavePlan {
  const { draft } = input;
  const upserts: Array<GroupSavePlan["upserts"][number]> = [];
  const skipped: Array<GroupSavePlan["skipped"][number]> = [];
  const kept = new Set<string>();
  for (const environmentId of draft.machines) {
    for (const projectKey of draft.projectKeys) {
      const projectId = input.projects
        .find((project) => project.key === projectKey)
        ?.projectIdByEnvironment.get(environmentId);
      if (projectId === undefined) {
        skipped.push({ environmentId, projectKey });
        continue;
      }
      const previous = input.existing.find(
        (member) => member.environmentId === environmentId && member.task.projectId === projectId,
      )?.task;
      if (previous) kept.add(memberKey(environmentId, previous.id));
      upserts.push({
        environmentId,
        input: {
          ...(previous ? { id: previous.id, requireExisting: true } : {}),
          title: draft.title.trim(),
          prompt: draft.prompt.trim(),
          enabled: draft.enabled,
          schedule: draft.schedule,
          projectId,
          threadId: draft.keepThread ? (previous?.threadId ?? null) : null,
          workspaceStrategy: workspaceStrategyFor(
            draft.workspace,
            previous?.workspaceStrategy ?? null,
          ),
          // Every task names a role, so one policy edit reaches every task on every machine.
          // The stored model is only the fallback for a machine whose policy cannot resolve it.
          agentRole: draft.agentRole,
          runtimeMode: previous?.runtimeMode ?? "full-access",
          interactionMode: previous?.interactionMode ?? "default",
          groupId: input.groupId,
          creationSource: "web",
        },
      });
    }
  }
  const deletes = input.existing
    .filter((member) => !kept.has(memberKey(member.environmentId, member.task.id)))
    .map((member) => ({ environmentId: member.environmentId, id: member.task.id }));
  return { upserts, deletes, skipped };
}

export type ScheduleKind = "interval" | "daily" | "weekdays" | "days" | "webhook";

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export interface ScheduleDraft {
  readonly kind: ScheduleKind;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  /** JS weekdays (0 = Sunday) for "days". */
  readonly weekdays: ReadonlyArray<number>;
}

export function scheduleDraftOf(schedule: ScheduledTask["schedule"]): ScheduleDraft {
  const base = { intervalMinutes: "60", timeOfDay: "09:00", weekdays: [...WEEKDAYS] };
  if (schedule.type === "webhook") return { ...base, kind: "webhook" };
  if (schedule.type === "interval") {
    return {
      ...base,
      kind: "interval",
      intervalMinutes: String(Math.max(1, schedule.everyMs / 60_000)),
    };
  }
  const days = schedule.weekdays ?? [];
  const kind: ScheduleKind =
    days.length === 0 || days.length === 7
      ? "daily"
      : days.length === 5 && WEEKDAYS.every((day) => days.includes(day))
        ? "weekdays"
        : "days";
  return {
    ...base,
    kind,
    timeOfDay: schedule.timeOfDay,
    weekdays: days.length > 0 ? days : base.weekdays,
  };
}

/**
 * The trigger to save, without webhook settings (the caller adds those). Null when the
 * interval is not a whole number of minutes of at least one.
 */
export function timedScheduleOf(
  draft: ScheduleDraft,
): Exclude<ScheduledTaskUpsertSchedule, { type: "webhook" }> | null {
  if (draft.kind === "interval") {
    const minutes = Number(draft.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) return null;
    return { type: "interval", everyMs: minutes * 60_000 };
  }
  const timeOfDay = draft.timeOfDay || "09:00";
  if (draft.kind === "weekdays") return { type: "fixed_time", timeOfDay, weekdays: [...WEEKDAYS] };
  if (draft.kind === "days" && draft.weekdays.length > 0 && draft.weekdays.length < 7) {
    return { type: "fixed_time", timeOfDay, weekdays: [...draft.weekdays].toSorted() };
  }
  return { type: "fixed_time", timeOfDay };
}

/** The webhook trigger's fields as the editor holds them. */
export interface WebhookDraft {
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on each machine. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
}

export function webhookDraftOf(schedule: ScheduledTask["schedule"] | null): WebhookDraft {
  const webhook = schedule?.type === "webhook" ? schedule : null;
  const signature = webhook?.signature ?? null;
  const filters = webhookFilterDrafts(webhook?.filters);
  return {
    signatureEnabled: signature != null,
    signatureHeader: signature?.header ?? "x-hub-signature-256",
    signatureEncoding: signature?.encoding ?? "hex",
    signaturePrefix: signature?.prefix ?? "sha256=",
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      webhook?.maxDeliveryAgeMinutes != null ? String(webhook.maxDeliveryAgeMinutes) : "",
    replayKey: webhook?.dedupe?.replayKey ?? "",
    coalesceKey: webhook?.dedupe?.coalesceKey ?? "",
    coalesceWindowSeconds:
      webhook?.dedupe?.coalesceWindowSeconds !== undefined
        ? String(webhook.dedupe.coalesceWindowSeconds)
        : "",
    filters,
    savedFilters: filters,
  };
}

/** What is wrong with the webhook fields, one toast each; empty when they can be saved. */
export function webhookDraftErrors(draft: WebhookDraft) {
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined) {
    return [
      {
        title: "Invalid age limit",
        description: `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      },
    ];
  }
  const errors: Array<{ title: string; description: string }> = [];
  for (const [label, value] of [
    ["Replay key", draft.replayKey],
    ["Coalesce key", draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim())) {
      errors.push({
        title: "Invalid webhook settings",
        description: `${label} must contain a valid request placeholder.`,
      });
    }
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (
    window &&
    (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600)
  ) {
    errors.push({
      title: "Invalid webhook settings",
      description: "Coalesce window must be whole seconds from 10 to 3600.",
    });
  }
  return errors;
}

/** The webhook trigger to save; null when the fields are invalid (see `webhookDraftErrors`). */
export function webhookScheduleOf(
  draft: WebhookDraft,
): Extract<ScheduledTaskUpsertSchedule, { type: "webhook" }> | null {
  if (webhookDraftErrors(draft).length > 0) return null;
  const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
  if (maxDeliveryAgeMinutes === undefined) return null;
  const parsedFilters = parseWebhookFilterDrafts(draft.filters);
  if (!("filters" in parsedFilters)) return null;
  const secret = draft.signatureSecret.trim();
  const replayKey = draft.replayKey.trim();
  const coalesceKey = draft.coalesceKey.trim();
  const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
    ? Number(draft.coalesceWindowSeconds)
    : undefined;
  return {
    type: "webhook",
    signature: draft.signatureEnabled
      ? {
          header: draft.signatureHeader.trim(),
          encoding: draft.signatureEncoding,
          prefix: draft.signaturePrefix,
          ...(secret ? { secret } : {}),
        }
      : null,
    maxDeliveryAgeMinutes,
    dedupe: {
      ...(replayKey ? { replayKey } : {}),
      ...(coalesceKey ? { coalesceKey } : {}),
      ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
    },
    // Only edited filters are sent; the server keeps the stored ones otherwise.
    ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
      ? { filters: parsedFilters.filters }
      : {}),
  };
}

export function webhookDeliveryLabel(delivery: {
  readonly outcome: string;
  readonly pendingWindow?: boolean | undefined;
}) {
  if (delivery.outcome === "accepted") return delivery.pendingWindow ? "Opened window" : "Ran";
  const labels: Record<string, string> = {
    dispatch_failed: "Run failed",
    duplicate: "Duplicate",
    coalesced: "Coalesced",
    filtered: "Filtered",
    rejected_signature: "Bad signature",
    disabled: "Task paused",
    rate_limited: "Rate limited",
    expired: "Too old",
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}
