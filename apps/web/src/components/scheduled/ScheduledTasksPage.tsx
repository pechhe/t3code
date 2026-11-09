import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentRole,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskPurpose,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  resolveEnvironmentMachineKind,
  scheduledTaskPurpose,
  scheduledTaskThreadMode,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InboxIcon,
  LinkIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useProjects, useThreadShells, useVisibleThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAllScheduledTasks, useSeenScheduledFailures } from "../../state/scheduledTasks";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { AgentRoleChip } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
import { ProjectChip } from "../ProjectChip";
import { TintChip } from "../TintChip";
import { ROLE_DESCRIPTIONS } from "../settings/DelegationSettings.logic";
import {
  WebhookDeliveriesDialog,
  WebhookEndpointField,
  relativeLabel,
  scheduleLabel,
  statusVariant,
} from "./scheduledTaskParts";
import {
  type ProjectChoice,
  type ScheduleDraft,
  type ScheduleKind,
  type ScheduledTaskDestination,
  type ScheduledTaskGroup,
  type WorkspaceChoice,
  chosenThreadId,
  groupScheduledTasks,
  groupStatus,
  markGroupFailuresSeen,
  moveDraftToThread,
  planGroupSave,
  roleModelSummary,
  scheduleDraftOf,
  scheduledTaskDestinationThreads,
  matchesTaskPurpose,
  soonestRunAt,
  timedScheduleOf,
  unbindDraftFromThread,
  webhookDraftErrors,
  webhookDraftOf,
  webhookScheduleOf,
  type TaskPurposeFilter,
  type WebhookDraft,
  workspaceChoiceOf,
} from "./scheduledTasks.logic";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  once: "Once",
  interval: "Every few minutes",
  daily: "Every day",
  weekdays: "Every weekday",
  days: "On chosen days",
  webhook: "When a webhook arrives",
};
const WORKSPACE_LABELS: Record<WorkspaceChoice, string> = {
  fresh: "a fresh workspace",
  checkout: "the project checkout",
};
const PURPOSE_LABELS: Record<ScheduledTaskPurpose, string> = {
  check_back: "Check-back",
  long_running: "Long-running",
};

const PURPOSE_FILTERS = [
  { value: "all", label: "All" },
  { value: "check_back", label: "Check-backs" },
  { value: "long_running", label: "Long-running" },
] as const satisfies readonly { value: TaskPurposeFilter; label: string }[];

const THREAD_MODE_LABELS: Record<ScheduledTaskThreadMode, string> = {
  new_thread: "a new thread each run",
  continue: "one thread, carrying on",
  fresh_session: "one thread, a fresh session each run",
};
/** How a run uses the thread a task is linked to. */
const LINKED_THREAD_MODE_LABELS: Record<Exclude<ScheduledTaskThreadMode, "new_thread">, string> = {
  continue: "carries on the conversation",
  fresh_session: "starts a fresh session",
};
const ROLE_OPTIONS = AgentRole.literals;
const DEFAULT_ROLE: AgentRole = "implementation-worker";

const scheduledTaskCreatePermissionsAtom = environmentAtomList(
  "web-scheduled-task-create-permissions",
  serverEnvironment.upsertScheduledTask.permissionAtom,
);

/** The connected machine a new task may be created on, or null when none may. */
function useCreationEnvironment(): EnvironmentId | null {
  const { environments } = useEnvironments();
  const machines = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const permissions = useAtomValue(
    scheduledTaskCreatePermissionsAtom(
      environmentIdsKey(machines.map((machine) => machine.environmentId)),
    ),
  );
  return machines.find((_machine, index) => permissions[index])?.environmentId ?? null;
}

interface EditorDraft extends ScheduleDraft, WebhookDraft {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly machines: ReadonlyArray<EnvironmentId>;
  /** Null until edited: the task's own projects, read once the project list has loaded. */
  readonly projectKeys: ReadonlyArray<string> | null;
  readonly workspace: WorkspaceChoice;
  readonly agentRole: AgentRole;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly purpose: ScheduledTaskPurpose;
  /** The thread picked in this editor; null keeps the one the task is stored with. */
  readonly destination: ScheduledTaskDestination | null;
}

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

const effortOf = (selection: ModelSelection) => {
  const effort = selection.options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  )?.value;
  return typeof effort === "string" ? effort : null;
};

/** The model a run used, as the model picker names it. */
function FixedModelLabel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly selection: ModelSelection;
}) {
  return (
    <ModelLabel
      environmentId={props.environmentId}
      instanceId={props.selection.instanceId}
      model={props.selection.model}
      effort={effortOf(props.selection)}
    />
  );
}

/** Projects across connected machines, one entry per repository, with a record for its chip. */
function useProjectChoices(): ReadonlyArray<
  ProjectChoice & { readonly project: ReturnType<typeof useProjects>[number] }
> {
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const byKey = new Map<
    string,
    {
      title: string;
      project: (typeof projects)[number];
      ids: Map<EnvironmentId, (typeof projects)[number]["id"]>;
    }
  >();
  for (const project of projects) {
    if (project.isScratch) continue;
    const key = deriveLogicalProjectKeyFromSettings(project, grouping);
    const entry = byKey.get(key) ?? { title: project.title, project, ids: new Map() };
    entry.ids.set(project.environmentId, project.id);
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([key, entry]) => ({
      key,
      title: entry.title,
      project: entry.project,
      projectIdByEnvironment: entry.ids,
    }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

function isSameGroup(left: ScheduledTaskGroup, right: ScheduledTaskGroup): boolean {
  return (
    left.key === right.key &&
    left.members.length === right.members.length &&
    left.members.every((member, index) => member.task === right.members[index]?.task)
  );
}

/**
 * Scheduled tasks across every connected machine: the list on the left, the selected
 * task on the right. Creating a task opens the same detail view, empty.
 */
export function ScheduledTasksPage(props: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly taskId?: string | undefined;
}) {
  const sources = useAllScheduledTasks();
  const [purposeFilter, setPurposeFilter] = useState<TaskPurposeFilter>("all");
  const allGroups = groupScheduledTasks(
    sources.flatMap((source) =>
      source.tasks === null ? [] : [{ environmentId: source.environmentId, tasks: source.tasks }],
    ),
  );
  const groups = allGroups.filter((group) => matchesTaskPurpose(group, purposeFilter));
  const linkedKey = allGroups.find((group) =>
    group.members.some(
      (member) =>
        member.task.id === props.taskId &&
        (props.environmentId === undefined || member.environmentId === props.environmentId),
    ),
  )?.key;
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const resolvedKey = selected ?? linkedKey ?? groups[0]?.key ?? null;
  const liveGroup = allGroups.find((group) => group.key === resolvedKey) ?? null;
  // While the list is unknown (a disconnect or a reload), the open editor keeps its task, so its
  // draft survives and a save still updates that task instead of creating another. Once the list
  // is known, a missing task was deleted, and the editor lets it go.
  const [shown, setShown] = useState<ScheduledTaskGroup | null>(liveGroup);
  if (liveGroup !== null && (shown === null || !isSameGroup(shown, liveGroup))) {
    setShown(liveGroup);
  }
  const listKnown = sources.length > 0 && sources.every((source) => source.tasks !== null);
  const retainedGroup = listKnown ? null : shown;
  const activeKey = resolvedKey ?? retainedGroup?.key ?? "new";
  const activeGroup =
    activeKey === "new"
      ? null
      : (liveGroup ?? (retainedGroup?.key === activeKey ? retainedGroup : null));
  const creationEnvironment = useCreationEnvironment();
  const [seen, setSeen] = useSeenScheduledFailures();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the visible scheduler group seen in its persisted failure-notification registry
  useEffect(() => {
    if (activeGroup === null) return;
    const next = markGroupFailuresSeen(activeGroup, seen);
    if (next !== seen) setSeen(next);
  }, [activeGroup, seen, setSeen]);
  useNowMinute();
  const loading =
    sources.length > 0 && sources.every((source) => source.tasks === null && !source.error);
  const errors = sources.filter((source) => source.error !== null);

  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Scheduled breadcrumb" className="min-w-0 py-2">
          <WorkspaceBreadcrumbItem>
            <h1>Scheduled</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <Button
          className="ms-auto"
          size="xs"
          variant="ghost-muted"
          disabled={creationEnvironment === null}
          onClick={() => setSelected("new")}
        >
          <PlusIcon className="size-3" />
          New task
        </Button>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-84 shrink-0 flex-col border-e">
          <ToggleGroup
            aria-label="Filter tasks"
            className="mx-3 mt-3 mb-2"
            value={[purposeFilter]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "all" || value === "check_back" || value === "long_running") {
                setPurposeFilter(value);
              }
            }}
          >
            {PURPOSE_FILTERS.map((filter) => (
              <Toggle key={filter.value} value={filter.value}>
                {filter.label}
                {loading ? null : (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {allGroups.filter((group) => matchesTaskPurpose(group, filter.value)).length}
                  </span>
                )}
              </Toggle>
            ))}
          </ToggleGroup>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {errors.map((source) => (
              <p key={source.environmentId} className="px-2 py-1 text-destructive text-xs">
                {source.error}
              </p>
            ))}
            {loading ? <p className="px-2 py-1 text-muted-foreground text-xs">Loading…</p> : null}
            {!loading && groups.length === 0 && allGroups.length > 0 ? (
              <p className="px-2 py-1 text-muted-foreground text-xs">
                {purposeFilter === "check_back" ? "No check-backs." : "No long-running tasks."}
              </p>
            ) : null}
            {groups.map((group) => (
              <TaskListItem
                key={group.key}
                group={group}
                active={group.key === activeKey}
                onSelect={() => setSelected(group.key)}
              />
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <TaskDetail
            key={activeKey}
            group={activeGroup}
            defaultMachine={creationEnvironment}
            onSaved={(key) => setSelected(key)}
            onDeleted={() => {
              setSelected(null);
              setShown(null);
            }}
          />
          {!loading && groups.length === 0 && activeKey === "new" && sources.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarClockIcon />
                </EmptyMedia>
                <EmptyTitle>No machines connected</EmptyTitle>
                <EmptyDescription>Connect a machine to schedule tasks on it.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </div>
      </div>
    </>
  );
}

function leadEnvironmentOf(group: ScheduledTaskGroup): EnvironmentId | null {
  return (
    group.members.find((member) => member.task === group.lead)?.environmentId ??
    group.members[0]?.environmentId ??
    null
  );
}

function TaskListItem(props: {
  readonly group: ScheduledTaskGroup;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { group } = props;
  const status = groupStatus(group);
  const next = soonestRunAt(group.members.map((member) => member.task));
  const machines = new Set(group.members.map((member) => member.environmentId)).size;
  return (
    <button
      type="button"
      data-active={props.active || undefined}
      onClick={props.onSelect}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent data-active:bg-accent"
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-sm">{group.lead.title}</span>
        {status === "running" || status === "failed" ? (
          <Badge variant={statusVariant(status === "running" ? "running" : "failed")}>
            {status}
          </Badge>
        ) : null}
      </span>
      <span className="truncate text-muted-foreground text-xs">
        {scheduleLabel(group.lead.schedule)}
        {status === "paused" ? " · paused" : next !== null ? ` · next ${relativeLabel(next)}` : ""}
        {machines > 1 ? ` · ${machines} machines` : ""}
      </span>
    </button>
  );
}

function draftOf(
  group: ScheduledTaskGroup | null,
  defaultMachine: EnvironmentId | null,
): EditorDraft {
  const lead = group?.lead ?? null;
  const schedule = lead
    ? scheduleDraftOf(lead.schedule)
    : { ...scheduleDraftOf({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }) };
  return {
    ...schedule,
    ...webhookDraftOf(lead?.schedule ?? null),
    title: lead?.title ?? "",
    prompt: lead?.prompt ?? "",
    enabled: lead?.enabled ?? true,
    machines: group
      ? [...new Set(group.members.map((member) => member.environmentId))]
      : defaultMachine === null
        ? []
        : [defaultMachine],
    projectKeys: group ? null : [],
    workspace: lead ? workspaceChoiceOf(lead.workspaceStrategy) : "fresh",
    agentRole: lead?.agentRole ?? DEFAULT_ROLE,
    threadMode: lead ? scheduledTaskThreadMode(lead) : "new_thread",
    purpose: lead ? scheduledTaskPurpose(lead) : "long_running",
    destination: null,
  };
}

function TaskDetail(props: {
  readonly group: ScheduledTaskGroup | null;
  readonly defaultMachine: EnvironmentId | null;
  readonly onSaved: (key: string) => void;
  readonly onDeleted: () => void;
}) {
  const { group } = props;
  const { environments } = useEnvironments();
  const machines = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const projectChoices = useProjectChoices();
  const projectKeyOf = (environmentId: EnvironmentId, projectId: string) =>
    projectChoices.find((choice) => choice.projectIdByEnvironment.get(environmentId) === projectId)
      ?.key ?? null;
  const [draft, setDraft] = useState<EditorDraft>(() =>
    draftOf(group, props.defaultMachine ?? machines[0]?.environmentId ?? null),
  );
  const projectKeys =
    draft.projectKeys ??
    (group === null
      ? []
      : [
          ...new Set(
            group.members.flatMap(
              (member) => projectKeyOf(member.environmentId, member.task.projectId) ?? [],
            ),
          ),
        ]);
  const [saving, setSaving] = useState(false);
  const [deliveriesFor, setDeliveriesFor] = useState<EnvironmentId | null>(null);
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const navigate = useNavigate();
  const policyMachine = draft.machines[0] ?? machines[0]?.environmentId ?? null;
  const policy = useEnvironmentQuery(
    policyMachine === null
      ? null
      : serverEnvironment.agentPolicyRead({ environmentId: policyMachine, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(policyMachine),
  );
  const update = (patch: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const leadEnvironmentId = group === null ? null : leadEnvironmentOf(group);
  // The thread the lead task posts into, or the one picked here in its place.
  const boundThreadId =
    group === null || leadEnvironmentId === null
      ? null
      : chosenThreadId(draft.destination, group.lead.threadId ?? null, {
          environmentId: leadEnvironmentId,
          projectId: group.lead.projectId,
        });
  // A single machine and project is where an unbound task can pick an existing thread.
  const soleEnvironmentId = draft.machines.length === 1 ? (draft.machines[0] ?? null) : null;
  const soleProject =
    projectKeys.length === 1
      ? projectChoices.find((choice) => choice.key === projectKeys[0])
      : undefined;
  const soleProjectId =
    soleEnvironmentId === null
      ? undefined
      : soleProject?.projectIdByEnvironment.get(soleEnvironmentId);
  const pickedThreadId =
    soleEnvironmentId === null || soleProjectId === undefined
      ? null
      : chosenThreadId(
          draft.destination,
          group?.members.find(
            (member) =>
              member.environmentId === soleEnvironmentId && member.task.projectId === soleProjectId,
          )?.task.threadId ?? null,
          { environmentId: soleEnvironmentId, projectId: soleProjectId },
        );
  // A task that runs in a thread posts there, so where it runs is that thread's.
  const bound = boundThreadId !== null && draft.threadMode !== "new_thread";
  // Without a thread yet, the first run starts one where it runs below.
  const threadModeDetail =
    draft.threadMode === "new_thread"
      ? null
      : draft.threadMode === "continue"
        ? "The first run starts a thread with the machine, project and role below; later runs continue that conversation."
        : "The first run starts a thread with the machine, project and role below; later runs post there, each in a fresh session without earlier runs' context.";
  const isWebhook = draft.kind === "webhook";
  const plan = planGroupSave({
    draft: {
      title: draft.title,
      prompt: draft.prompt,
      enabled: draft.enabled,
      schedule: { type: "interval", everyMs: 60_000 },
      machines: draft.machines,
      projectKeys,
      workspace: draft.workspace,
      agentRole: draft.agentRole,
      threadMode: draft.threadMode,
      purpose: draft.purpose,
      destination: draft.destination,
    },
    groupId: "",
    existing: group?.members ?? [],
    projects: projectChoices,
  });
  // A bound run follows its thread's current model, so a role only picks one for fresh threads.
  const roleSummary =
    !bound && policy.data ? roleModelSummary(policy.data.snapshot.manifest, draft.agentRole) : null;

  const scheduleToSave = (): ScheduledTaskUpsertSchedule | null => {
    if (!isWebhook) return timedScheduleOf(draft);
    return webhookScheduleOf(draft);
  };

  const save = async () => {
    if (saving) return;
    const schedule = scheduleToSave();
    if (!draft.title.trim() || !draft.prompt.trim()) {
      reportFailure("Task is incomplete", "Give it a name and a prompt.");
      return;
    }
    if (schedule === null) {
      if (isWebhook) {
        const errors = webhookDraftErrors(draft);
        const parsed = parseWebhookFilterDrafts(draft.filters);
        if (errors.length === 0 && "error" in parsed) reportFailure("Invalid filter", parsed.error);
        for (const error of errors) reportFailure(error.title, error.description);
      } else {
        reportFailure("Check the trigger", "Run every whole number of minutes, at least one.");
      }
      return;
    }
    if (plan.upserts.length === 0) {
      reportFailure("Nothing would run", "Choose a machine and a project it has.");
      return;
    }
    const groupId = group?.lead.groupId ?? group?.key ?? randomUUID();
    const final = planGroupSave({
      draft: { ...draft, projectKeys, schedule },
      groupId,
      existing: group?.members ?? [],
      projects: projectChoices,
    });
    if (
      final.upserts.some(
        (entry) => !readEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope),
      )
    ) {
      reportFailure("Not allowed", "This device cannot change tasks on every chosen machine.");
      return;
    }
    if (final.deletes.length > 0 && group !== null) {
      const message = `Stop running this task in ${final.deletes.length === 1 ? "1 place" : `${final.deletes.length} places`}?\nIts run history there is deleted.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setSaving(true);
    const failures: string[] = [];
    for (const entry of final.upserts) {
      const result = await upsert({ environmentId: entry.environmentId, input: entry.input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failures.push(String(squashAtomCommandFailure(result)));
      }
    }
    for (const entry of final.deletes) {
      const result = await remove({ environmentId: entry.environmentId, input: { id: entry.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failures.push(String(squashAtomCommandFailure(result)));
      }
    }
    setSaving(false);
    if (failures.length > 0) {
      reportFailure("Some changes did not save", failures.join("\n"));
      return;
    }
    // The editor stays open after a save, so later saves must diff against what was just stored.
    update({ savedFilters: draft.filters });
    props.onSaved(groupId);
  };

  const forEachMember = async (
    action: (
      environmentId: EnvironmentId,
      id: NonNullable<typeof group>["lead"]["id"],
    ) => Promise<unknown>,
  ) => {
    if (!group) return;
    for (const member of group.members) await action(member.environmentId, member.task.id);
  };

  const deleteAll = async () => {
    if (!group) return;
    const message = `Delete "${group.lead.title}"?`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    await forEachMember((environmentId, id) => remove({ environmentId, input: { id } }));
    props.onDeleted();
  };

  const machineLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "Machine";
  const projectLabel = (key: string) =>
    projectChoices.find((choice) => choice.key === key)?.title ?? key;

  return (
    <fieldset disabled={saving} className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
      <div className="flex items-center gap-3">
        <Switch
          checked={draft.enabled}
          aria-label="Task enabled"
          disabled={!canOperate}
          onCheckedChange={(enabled) => {
            update({ enabled });
            if (group)
              void forEachMember((environmentId, id) =>
                setEnabled({ environmentId, input: { id, enabled } }),
              );
          }}
        />
        <Input
          aria-label="Task name"
          placeholder="Name this task"
          value={draft.title}
          onChange={(event) => update({ title: event.target.value })}
        />
        {group && !isWebhook ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate}
            onClick={() =>
              void forEachMember((environmentId, id) => runNow({ environmentId, input: { id } }))
            }
          >
            <PlayIcon />
            Run now
          </Button>
        ) : null}
        {group ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete task"
            disabled={!canOperate}
            onClick={() => void deleteAll()}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        <Select value={draft.purpose} onValueChange={(purpose) => purpose && update({ purpose })}>
          <SelectTrigger size="xs" variant="ghost" aria-label="What this task is">
            <SelectValue>{PURPOSE_LABELS[draft.purpose]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(PURPOSE_LABELS) as ScheduledTaskPurpose[]).map((purpose) => (
              <SelectItem key={purpose} value={purpose}>
                {PURPOSE_LABELS[purpose]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={draft.kind}
          onValueChange={(kind) => {
            if (!kind) return;
            update({
              kind,
              prompt:
                kind === "webhook" && !draft.prompt.trim() ? DEFAULT_WEBHOOK_PROMPT : draft.prompt,
            });
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="When it runs">
            <SelectValue>{SCHEDULE_KIND_LABELS[draft.kind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(SCHEDULE_KIND_LABELS) as ScheduleKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {SCHEDULE_KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {draft.kind === "interval" ? (
          <>
            <span className="text-muted-foreground">every</span>
            <Input
              type="number"
              nativeInput
              min={1}
              aria-label="Minutes between runs"
              className="w-20"
              value={draft.intervalMinutes}
              onChange={(event) => update({ intervalMinutes: event.target.value })}
            />
            <span className="text-muted-foreground">minutes</span>
          </>
        ) : draft.kind === "once" ? (
          <Input
            aria-label="Run at"
            placeholder="2026-11-04T09:00:00+00:00"
            value={draft.runAt ?? ""}
            onChange={(event) => update({ runAt: event.target.value })}
          />
        ) : draft.kind === "webhook" ? null : (
          <>
            <span className="text-muted-foreground">at</span>
            <Input
              type="time"
              nativeInput
              aria-label="Time of day"
              className="w-32"
              value={draft.timeOfDay}
              onChange={(event) => update({ timeOfDay: event.target.value })}
            />
          </>
        )}
      </div>
      {draft.kind === "days" ? (
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_ORDER.map((day) => (
            <Toggle
              key={day}
              size="sm"
              variant="outline"
              pressed={draft.weekdays.includes(day)}
              onPressedChange={(pressed) =>
                update({
                  weekdays: pressed
                    ? [...draft.weekdays, day]
                    : draft.weekdays.filter((value) => value !== day),
                })
              }
            >
              {WEEKDAY_SHORT[day]}
            </Toggle>
          ))}
        </div>
      ) : null}

      {boundThreadId !== null && leadEnvironmentId !== null ? (
        <LinkedThreadPanel
          environmentId={leadEnvironmentId}
          threadId={boundThreadId}
          threadMode={draft.threadMode}
          project={projectChoices.find((choice) => choice.key === projectKeys[0])?.project ?? null}
          projectId={group?.lead.projectId ?? null}
          onThreadModeChange={(threadMode) => update({ threadMode })}
          onMove={(thread) =>
            setDraft((current) =>
              thread === null ? unbindDraftFromThread(current) : moveDraftToThread(current, thread),
            )
          }
        />
      ) : null}
      {bound ? null : (
        <>
          <ChipRow label="On">
            {machines.map((machine) => {
              const pressed = draft.machines.includes(machine.environmentId);
              return (
                <TintChip
                  key={machine.environmentId}
                  tint={{ color: "var(--primary)" }}
                  icon={
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(machine.serverConfig)}
                      className="size-3 shrink-0"
                    />
                  }
                  label={machine.label}
                  selected={pressed}
                  className="h-7 px-2 text-xs"
                  render={
                    <button
                      type="button"
                      aria-pressed={pressed}
                      onClick={() =>
                        update({
                          machines: pressed
                            ? draft.machines.filter((id) => id !== machine.environmentId)
                            : [...draft.machines, machine.environmentId],
                        })
                      }
                    />
                  }
                />
              );
            })}
          </ChipRow>
          <ChipRow label="In">
            {projectChoices.map((choice) => {
              const pressed = projectKeys.includes(choice.key);
              return (
                <ProjectChip
                  key={choice.key}
                  project={choice.project}
                  label={choice.title}
                  selected={pressed}
                  className="h-7 px-2 text-xs"
                  render={
                    <button
                      type="button"
                      aria-pressed={pressed}
                      onClick={() =>
                        update({
                          projectKeys: pressed
                            ? projectKeys.filter((key) => key !== choice.key)
                            : [...projectKeys, choice.key],
                        })
                      }
                    />
                  }
                />
              );
            })}
          </ChipRow>
          {plan.skipped.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Not run where the machine lacks the project:{" "}
              {plan.skipped
                .map(
                  (entry) =>
                    `${projectLabel(entry.projectKey)} on ${machineLabel(entry.environmentId)}`,
                )
                .join(", ")}
              .
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
            <span className="inline-flex items-center gap-1 text-muted-foreground">Runs in</span>
            <Select
              value={draft.threadMode}
              onValueChange={(threadMode) =>
                threadMode && update({ threadMode: threadMode as ScheduledTaskThreadMode })
              }
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="Where each run posts">
                <SelectValue>{THREAD_MODE_LABELS[draft.threadMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map(
                  (threadMode) => (
                    <SelectItem key={threadMode} value={threadMode}>
                      {THREAD_MODE_LABELS[threadMode]}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
            {draft.threadMode !== "new_thread" &&
            soleEnvironmentId !== null &&
            soleProjectId !== undefined ? (
              <ThreadDestinationPicker
                environmentId={soleEnvironmentId}
                projectId={soleProjectId}
                threadId={pickedThreadId}
                label={pickedThreadId === null ? "Thread started by the first run" : undefined}
                onSelect={(thread) =>
                  setDraft((current) =>
                    thread === null
                      ? unbindDraftFromThread(current)
                      : moveDraftToThread(current, thread),
                  )
                }
              />
            ) : null}
            <span className="inline-flex items-center gap-1 text-muted-foreground">Works in</span>
            <Select
              value={draft.workspace}
              onValueChange={(workspace) => workspace && update({ workspace })}
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="Where each run works">
                <SelectValue>{WORKSPACE_LABELS[draft.workspace]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="fresh">{WORKSPACE_LABELS.fresh}</SelectItem>
                <SelectItem value="checkout">{WORKSPACE_LABELS.checkout}</SelectItem>
              </SelectPopup>
            </Select>
            <span className="text-muted-foreground">as</span>
            <Select
              value={draft.agentRole}
              onValueChange={(value) => value && update({ agentRole: value as AgentRole })}
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="Subagent role">
                <SelectValue>
                  <AgentRoleChip role={draft.agentRole} />
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ROLE_OPTIONS.map((role) => (
                  <SelectItem key={role} value={role}>
                    <span className="flex items-center gap-2">
                      <AgentRoleChip role={role} />
                      <span className="text-muted-foreground text-xs">
                        {ROLE_DESCRIPTIONS[role]}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {roleSummary ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                uses
                <ModelLabel
                  environmentId={policyMachine}
                  driverKind={roleSummary.driverKind}
                  model={roleSummary.model}
                  effort={roleSummary.effort}
                />
              </span>
            ) : policy.error ? (
              <span className="text-muted-foreground text-xs">
                No role policy on {machineLabel(policyMachine as EnvironmentId)}
              </span>
            ) : null}
          </div>
          <p className="-mt-3 text-muted-foreground text-xs">
            {threadModeDetail === null ? null : <>{threadModeDetail} </>}
            A fresh run starts where a new thread does: its own workspace in a SlipJay project. The
            project checkout runs in the project folder, which is the integration checkout in a
            SlipJay project.
          </p>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scheduled-task-prompt">Prompt</Label>
        <Textarea
          id="scheduled-task-prompt"
          className="max-h-64 overflow-y-auto"
          placeholder="What should the agent do each time this runs?"
          value={draft.prompt}
          onChange={(event) => update({ prompt: event.target.value })}
        />
      </div>

      {isWebhook ? (
        <WebhookSettings draft={draft} update={update} group={group} machineLabel={machineLabel} />
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" disabled={!canOperate || saving} onClick={() => void save()}>
          {group ? "Save" : "Create task"}
        </Button>
      </div>

      {group ? (
        <div className="flex flex-col gap-1.5">
          <Label>Runs</Label>
          {group.members.map((member) => {
            const runThreadId = member.task.lastRunThreadId;
            const summary = (
              <>
                <span className="font-medium">{machineLabel(member.environmentId)}</span>
                <RunProjectLabel
                  choice={projectChoices.find(
                    (choice) =>
                      choice.key === projectKeyOf(member.environmentId, member.task.projectId),
                  )}
                  fallback={member.task.projectId}
                />
                <FixedModelLabel
                  environmentId={member.environmentId}
                  selection={member.task.modelSelection}
                />
                {member.task.lastRunStatus === "never" ? (
                  <span className="text-muted-foreground">not run yet</span>
                ) : (
                  <>
                    <Badge variant={statusVariant(member.task.lastRunStatus)}>
                      {member.task.lastRunStatus}
                    </Badge>
                    <span className="text-muted-foreground">
                      {relativeLabel(member.task.lastRunAt)}
                    </span>
                  </>
                )}
                {member.task.enabled && member.task.nextRunAt ? (
                  <span className="text-muted-foreground">
                    next {relativeLabel(member.task.nextRunAt)}
                  </span>
                ) : null}
              </>
            );
            return (
              <div
                key={`${member.environmentId}:${member.task.id}`}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                {runThreadId ? (
                  <button
                    type="button"
                    className="-mx-1.5 flex cursor-pointer flex-wrap items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: member.environmentId, threadId: runThreadId },
                      })
                    }
                  >
                    {summary}
                    <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 py-1">{summary}</div>
                )}
                {member.task.schedule.type === "webhook" ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => setDeliveriesFor(member.environmentId)}
                  >
                    <InboxIcon />
                    Deliveries
                  </Button>
                ) : null}
                {member.task.lastRunError ? (
                  <span className="w-full text-destructive">{member.task.lastRunError}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {group && deliveriesFor !== null
        ? group.members
            .filter((member) => member.environmentId === deliveriesFor)
            .slice(0, 1)
            .map((member) => (
              <WebhookDeliveriesDialog
                key={member.task.id}
                environmentId={member.environmentId}
                task={member.task}
                onClose={() => setDeliveriesFor(null)}
              />
            ))
        : null}
    </fieldset>
  );
}

function RunProjectLabel(props: {
  readonly choice: ReturnType<typeof useProjectChoices>[number] | undefined;
  readonly fallback: string;
}) {
  return props.choice ? (
    <ProjectChip project={props.choice.project} label={props.choice.title} />
  ) : (
    <span className="text-muted-foreground">{props.fallback}</span>
  );
}

/**
 * The thread a task posts into, when an agent bound it to one. Machine, project and
 * workspace are that thread's, so the editor shows only the thread and offers the way out.
 */
function LinkedThreadPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: NonNullable<ScheduledTaskGroup["lead"]["threadId"]>;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly project: ReturnType<typeof useProjects>[number] | null;
  readonly projectId: ProjectId | null;
  readonly onThreadModeChange: (threadMode: ScheduledTaskThreadMode) => void;
  /** Moves the task to the picked thread; null starts a new thread each run. */
  readonly onMove: (thread: PickedThread | null) => void;
}) {
  const navigate = useNavigate();
  const linkedMode = props.threadMode === "new_thread" ? null : props.threadMode;
  const runsInThread = linkedMode !== null;
  const thread = useThreadShells().find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.id === props.threadId,
  );
  return (
    <div
      data-unlinked={runsInThread ? undefined : ""}
      className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info/6 p-3 text-sm data-unlinked:border-border data-unlinked:bg-transparent"
    >
      <div className="flex flex-wrap items-center gap-2">
        <LinkIcon aria-hidden className="size-3.5 shrink-0 text-info" />
        <span className="text-muted-foreground">
          {runsInThread ? "Posts into" : "Was posting into"}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="min-w-0 max-w-80"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: props.environmentId, threadId: props.threadId },
            })
          }
        >
          <MessageSquareIcon />
          <span className="min-w-0 truncate">{thread?.title ?? "A thread not loaded here"}</span>
        </Button>
        {props.project ? <ProjectChip project={props.project} /> : null}
        {props.projectId !== null ? (
          <ThreadDestinationPicker
            environmentId={props.environmentId}
            projectId={props.projectId}
            threadId={props.threadId}
            label="Change thread"
            onSelect={props.onMove}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        {linkedMode !== null ? (
          <>
            <span>Each run</span>
            <Select
              value={linkedMode}
              onValueChange={(threadMode) =>
                threadMode && props.onThreadModeChange(threadMode as ScheduledTaskThreadMode)
              }
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="How each run uses the thread">
                <SelectValue>{LINKED_THREAD_MODE_LABELS[linkedMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="continue">{LINKED_THREAD_MODE_LABELS.continue}</SelectItem>
                <SelectItem value="fresh_session">
                  {LINKED_THREAD_MODE_LABELS.fresh_session}
                </SelectItem>
              </SelectPopup>
            </Select>
            <span>Deleting the thread also deletes this task.</span>
          </>
        ) : (
          <span>After you save, each run starts a new thread and you choose where it runs.</span>
        )}
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => props.onThreadModeChange(runsInThread ? "new_thread" : "continue")}
        >
          {runsInThread ? "Start a new thread each run" : "Keep posting into this thread"}
        </Button>
      </div>
    </div>
  );
}

type PickedThread = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly id: ThreadId;
};

/** Sorts first and never matches a thread id, so "New thread each run" is a plain list entry. */
const NEW_THREAD_DESTINATION = " new-thread";

/**
 * Picks the thread a task posts into: an open thread of the same machine and project, or a
 * new thread each run. The server refuses an archived, deleted or other-project thread on save.
 */
function ThreadDestinationPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  /** Names the trigger; it shows the current thread's title when absent. */
  readonly label?: string | undefined;
  readonly onSelect: (thread: PickedThread | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shells = useVisibleThreadShells(open);
  // Mounts older settled threads matching the query, which the shells may leave out.
  useThreadSearch(open ? [props.environmentId] : [], query, {
    titlesOnly: true,
    projectIds: [props.projectId],
  });
  const current = useThreadShells().find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.id === props.threadId,
  );
  const threads = scheduledTaskDestinationThreads(shells, {
    environmentId: props.environmentId,
    projectId: props.projectId,
    currentThreadId: props.threadId,
    query,
  });
  const search = query.trim().toLocaleLowerCase();
  const items: ReadonlyArray<string> = [
    ...(search ? [] : [NEW_THREAD_DESTINATION]),
    ...threads.map((thread) => thread.id),
  ];
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <Combobox
      items={items}
      filteredItems={items}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      value={props.threadId}
      onValueChange={(value) => {
        if (value === NEW_THREAD_DESTINATION) props.onSelect(null);
        else {
          const picked = threads.find((thread) => thread.id === value);
          if (picked) props.onSelect(picked);
        }
        close();
      }}
    >
      <ComboboxTrigger
        aria-label="Destination thread"
        render={<Button variant="outline" size="xs" className="min-w-0 max-w-72" />}
      >
        <MessageSquareIcon />
        <span className="min-w-0 truncate">
          {props.label ?? (current?.title.trim() || "A thread not loaded here")}
        </span>
        <ChevronDownIcon />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <ComboboxSearchInput
          aria-label="Search threads"
          placeholder="Search this project's threads..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No threads found.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {items.map((value, index) => (
            <ComboboxItem key={value} index={index} value={value}>
              <span className="block truncate">
                {value === NEW_THREAD_DESTINATION
                  ? "New thread each run"
                  : threads.find((thread) => thread.id === value)?.title || "Untitled thread"}
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function ChipRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="inline-flex w-10 shrink-0 items-center gap-1 pt-1 text-muted-foreground">
        {props.label}
      </span>
      <div className="flex flex-wrap gap-1.5">{props.children}</div>
    </div>
  );
}

function WebhookFiltersField(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const { filters, onChange } = props;
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label>Filters</Label>
          <p className="text-muted-foreground text-xs">
            Run only when every filter matches. Other requests are logged as filtered. Separate “is
            one of” values with commas; a value can't contain a comma.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          Add filter
        </Button>
      </div>
      {filters.map((filter, index) => (
        <div key={filter.id} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Filter ${index + 1} path`}
              placeholder="body.action"
              value={filter.path}
              onChange={(event) => update(index, { path: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filter.op}
              onValueChange={(op) => {
                const known = WEBHOOK_FILTER_OPS.find((option) => option.op === op);
                if (known) update(index, { op: known.op });
              }}
            >
              <SelectTrigger size="sm" aria-label={`Filter ${index + 1} test`}>
                <SelectValue>
                  {WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <Input
                aria-label={`Filter ${index + 1} value`}
                placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
                value={filter.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function WebhookSettings(props: {
  readonly draft: EditorDraft;
  readonly update: (patch: Partial<EditorDraft>) => void;
  readonly group: ScheduledTaskGroup | null;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
}) {
  const { draft, update, group } = props;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      {group ? (
        group.members.map((member) => (
          <div key={member.task.id} className="flex flex-col gap-1">
            <Label>Webhook URL · {props.machineLabel(member.environmentId)}</Label>
            <WebhookEndpointField environmentId={member.environmentId} task={member.task} />
          </div>
        ))
      ) : (
        <p className="text-muted-foreground text-sm">
          Each machine gets its own URL after you create the task.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {
          "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
        }
      </p>
      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="scheduled-task-max-age">Skip requests older than</Label>
        <Input
          id="scheduled-task-max-age"
          type="number"
          nativeInput
          min={1}
          max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
          className="w-24"
          placeholder="any"
          value={draft.maxDeliveryAgeMinutes}
          onChange={(event) => update({ maxDeliveryAgeMinutes: event.target.value })}
        />
        <span className="text-muted-foreground">minutes</span>
      </div>
      <WebhookFiltersField filters={draft.filters} onChange={(filters) => update({ filters })} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="scheduled-task-replay-key">Replay key</Label>
        <Input
          id="scheduled-task-replay-key"
          placeholder="{{headers.delivery-id}}"
          value={draft.replayKey}
          onChange={(event) => update({ replayKey: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="scheduled-task-coalesce-key">Coalesce key</Label>
        <Input
          id="scheduled-task-coalesce-key"
          placeholder="{{body.id}}"
          value={draft.coalesceKey}
          onChange={(event) => update({ coalesceKey: event.target.value })}
        />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="scheduled-task-coalesce-window">Coalesce window</Label>
        <Input
          id="scheduled-task-coalesce-window"
          type="number"
          nativeInput
          min={10}
          max={3600}
          className="w-24"
          placeholder="120"
          value={draft.coalesceWindowSeconds}
          onChange={(event) => update({ coalesceWindowSeconds: event.target.value })}
        />
        <span className="text-muted-foreground">seconds, 10–3600</span>
      </div>
      <p className="text-muted-foreground text-xs">
        Replay and coalesce keys are templates, optional. Replay keys suppress repeat deliveries for
        7 days. Coalescing runs the latest payload once when the window from the first delivery
        closes. Empty keys run normally.
      </p>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="scheduled-task-signature">Require signature</Label>
        <Switch
          id="scheduled-task-signature"
          checked={draft.signatureEnabled}
          onCheckedChange={(signatureEnabled) => update({ signatureEnabled })}
        />
      </div>
      {draft.signatureEnabled ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            aria-label="Signature header"
            value={draft.signatureHeader}
            onChange={(event) => update({ signatureHeader: event.target.value })}
          />
          <Input
            aria-label="Signature prefix"
            placeholder="No prefix"
            value={draft.signaturePrefix}
            onChange={(event) => update({ signaturePrefix: event.target.value })}
          />
          <Select
            value={draft.signatureEncoding}
            onValueChange={(value) =>
              update({ signatureEncoding: value === "base64" ? "base64" : "hex" })
            }
          >
            <SelectTrigger size="sm" aria-label="Signature encoding">
              <SelectValue>{draft.signatureEncoding}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="hex">hex</SelectItem>
              <SelectItem value="base64">base64</SelectItem>
            </SelectPopup>
          </Select>
          <Input
            type="password"
            autoComplete="off"
            aria-label="Signing secret"
            placeholder={group?.lead.webhook?.hasSecret ? "Unchanged" : "Shared secret"}
            value={draft.signatureSecret}
            onChange={(event) => update({ signatureSecret: event.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}
