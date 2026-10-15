import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_WEBHOOK_PROMPT } from "@t3tools/client-runtime/scheduled-task-webhook";
import { parseMaxDeliveryAge } from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentRole,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ModelSelection,
  type ScheduledTaskUpsertSchedule,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, InboxIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAllScheduledTasks, useSeenScheduledFailures } from "../../state/scheduledTasks";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { useRelativeTimeTick } from "../settings/settingsLayout";
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
  type ScheduledTaskGroup,
  type WorkspaceChoice,
  groupScheduledTasks,
  groupStatus,
  markGroupFailuresSeen,
  planGroupSave,
  roleModelSummary,
  scheduleDraftOf,
  soonestRunAt,
  timedScheduleOf,
  workspaceChoiceOf,
} from "./scheduledTasks.logic";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
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
const ROLE_OPTIONS = AgentRole.literals;
const DEFAULT_ROLE: AgentRole = "implementation-worker";

interface EditorDraft extends ScheduleDraft {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly machines: ReadonlyArray<EnvironmentId>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly workspace: WorkspaceChoice;
  readonly agentRole: AgentRole | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on each machine. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
}

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

const modelLabel = (selection: ModelSelection) => {
  const effort = selection.options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  )?.value;
  return `${formatModelSlugName(selection.model)}${typeof effort === "string" ? ` · ${effort}` : ""}`;
};

/** Projects across connected machines, one entry per repository. */
function useProjectChoices(): ReadonlyArray<ProjectChoice> {
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  return useMemo(() => {
    const byKey = new Map<
      string,
      { title: string; ids: Map<EnvironmentId, (typeof projects)[number]["id"]> }
    >();
    for (const project of projects) {
      if (project.isScratch) continue;
      const key = deriveLogicalProjectKeyFromSettings(project, grouping);
      const entry = byKey.get(key) ?? { title: project.title, ids: new Map() };
      entry.ids.set(project.environmentId, project.id);
      byKey.set(key, entry);
    }
    return [...byKey.entries()]
      .map(([key, entry]) => ({ key, title: entry.title, projectIdByEnvironment: entry.ids }))
      .toSorted((a, b) => a.title.localeCompare(b.title));
  }, [projects, grouping]);
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
  const groups = useMemo(
    () =>
      groupScheduledTasks(
        sources.flatMap((source) =>
          source.tasks === null
            ? []
            : [{ environmentId: source.environmentId, tasks: source.tasks }],
        ),
      ),
    [sources],
  );
  const linkedKey = groups.find((group) =>
    group.members.some(
      (member) =>
        member.task.id === props.taskId &&
        (props.environmentId === undefined || member.environmentId === props.environmentId),
    ),
  )?.key;
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const activeKey = selected ?? linkedKey ?? groups[0]?.key ?? "new";
  const activeGroup =
    activeKey === "new" ? null : (groups.find((group) => group.key === activeKey) ?? null);
  const [seen, setSeen] = useSeenScheduledFailures();
  useEffect(() => {
    if (activeGroup === null) return;
    const next = markGroupFailuresSeen(activeGroup, seen);
    if (next !== seen) setSeen(next);
  }, [activeGroup, seen, setSeen]);
  useRelativeTimeTick(60_000);
  const loading =
    sources.length > 0 && sources.every((source) => source.tasks === null && !source.error);
  const errors = sources.filter((source) => source.error !== null);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col border-e">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground text-xs">
            {groups.length === 1 ? "1 task" : `${groups.length} tasks`}
          </span>
          <Button size="xs" variant="ghost-muted" onClick={() => setSelected("new")}>
            <PlusIcon className="size-3" />
            New task
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {errors.map((source) => (
            <p key={source.environmentId} className="px-2 py-1 text-destructive text-xs">
              {source.error}
            </p>
          ))}
          {loading ? <p className="px-2 py-1 text-muted-foreground text-xs">Loading…</p> : null}
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
        {groups.length === 0 && activeKey !== "new" ? null : (
          <TaskDetail
            key={activeKey}
            group={activeGroup}
            onSaved={(key) => setSelected(key)}
            onDeleted={() => setSelected(null)}
          />
        )}
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
  projectKeyOf: (environmentId: EnvironmentId, projectId: string) => string | null,
  defaultMachine: EnvironmentId | null,
): EditorDraft {
  const lead = group?.lead ?? null;
  const schedule = lead
    ? scheduleDraftOf(lead.schedule)
    : { ...scheduleDraftOf({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }) };
  const signature = lead?.schedule.type === "webhook" ? lead.schedule.signature : null;
  return {
    ...schedule,
    title: lead?.title ?? "",
    prompt: lead?.prompt ?? "",
    enabled: lead?.enabled ?? true,
    machines: group
      ? [...new Set(group.members.map((member) => member.environmentId))]
      : defaultMachine === null
        ? []
        : [defaultMachine],
    projectKeys: group
      ? [
          ...new Set(
            group.members.flatMap(
              (member) => projectKeyOf(member.environmentId, member.task.projectId) ?? [],
            ),
          ),
        ]
      : [],
    workspace: lead ? workspaceChoiceOf(lead.workspaceStrategy) : "fresh",
    agentRole: lead ? (lead.agentRole ?? null) : DEFAULT_ROLE,
    signatureEnabled: signature != null,
    signatureHeader: signature?.header ?? "x-hub-signature-256",
    signatureEncoding: signature?.encoding ?? "hex",
    signaturePrefix: signature?.prefix ?? "sha256=",
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      lead?.schedule.type === "webhook" && lead.schedule.maxDeliveryAgeMinutes != null
        ? String(lead.schedule.maxDeliveryAgeMinutes)
        : "",
  };
}

function TaskDetail(props: {
  readonly group: ScheduledTaskGroup | null;
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
    draftOf(group, projectKeyOf, machines[0]?.environmentId ?? null),
  );
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
  const bound = group?.lead.threadId != null;
  const isWebhook = draft.kind === "webhook";
  const plan = planGroupSave({
    draft: {
      title: draft.title,
      prompt: draft.prompt,
      enabled: draft.enabled,
      schedule: { type: "interval", everyMs: 60_000 },
      machines: draft.machines,
      projectKeys: draft.projectKeys,
      workspace: draft.workspace,
      agentRole: draft.agentRole,
    },
    groupId: "",
    existing: group?.members ?? [],
    projects: projectChoices,
  });
  const roleSummary =
    draft.agentRole !== null && policy.data
      ? roleModelSummary(policy.data.snapshot.manifest, draft.agentRole)
      : null;

  const scheduleToSave = (): ScheduledTaskUpsertSchedule | null => {
    if (!isWebhook) return timedScheduleOf(draft);
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    const secret = draft.signatureSecret.trim();
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
    };
  };

  const save = async () => {
    if (saving) return;
    const schedule = scheduleToSave();
    if (!draft.title.trim() || !draft.prompt.trim()) {
      reportFailure("Task is incomplete", "Give it a name and a prompt.");
      return;
    }
    if (schedule === null) {
      reportFailure(
        "Check the trigger",
        isWebhook
          ? `Skip requests older than 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES} minutes, or leave it blank.`
          : "Run every whole number of minutes, at least one.",
      );
      return;
    }
    if (plan.upserts.length === 0) {
      reportFailure("Nothing would run", "Choose a machine and a project it has.");
      return;
    }
    const groupId = group?.lead.groupId ?? group?.key ?? randomUUID();
    const final = planGroupSave({
      draft: { ...draft, schedule },
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

      <ChipRow label="On">
        {machines.map((machine) => (
          <Toggle
            key={machine.environmentId}
            size="sm"
            variant="outline"
            disabled={bound}
            pressed={draft.machines.includes(machine.environmentId)}
            onPressedChange={(pressed) =>
              update({
                machines: pressed
                  ? [...draft.machines, machine.environmentId]
                  : draft.machines.filter((id) => id !== machine.environmentId),
              })
            }
          >
            <EnvironmentMachineIcon
              kind={resolveEnvironmentMachineKind(machine.serverConfig)}
              className="size-3.5"
            />
            {machine.label}
          </Toggle>
        ))}
      </ChipRow>
      <ChipRow label="In">
        {projectChoices.map((choice) => (
          <Toggle
            key={choice.key}
            size="sm"
            variant="outline"
            disabled={bound}
            pressed={draft.projectKeys.includes(choice.key)}
            onPressedChange={(pressed) =>
              update({
                projectKeys: pressed
                  ? [...draft.projectKeys, choice.key]
                  : draft.projectKeys.filter((key) => key !== choice.key),
              })
            }
          >
            {choice.title}
          </Toggle>
        ))}
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
      {bound ? (
        <p className="text-muted-foreground text-xs">
          An agent set this task to post into its own thread.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        <span className="text-muted-foreground">Works in</span>
        <Select
          value={draft.workspace}
          onValueChange={(workspace) => workspace && update({ workspace })}
        >
          <SelectTrigger
            size="xs"
            variant="ghost"
            aria-label="Where each run works"
            disabled={bound}
          >
            <SelectValue>{WORKSPACE_LABELS[draft.workspace]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="fresh">{WORKSPACE_LABELS.fresh}</SelectItem>
            <SelectItem value="checkout">{WORKSPACE_LABELS.checkout}</SelectItem>
          </SelectPopup>
        </Select>
        <span className="text-muted-foreground">as</span>
        <Select
          value={draft.agentRole ?? "fixed"}
          onValueChange={(value) =>
            value && update({ agentRole: value === "fixed" ? null : (value as AgentRole) })
          }
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="Subagent role">
            <SelectValue>
              {draft.agentRole ??
                `a fixed model (${group ? modelLabel(group.lead.modelSelection) : "none"})`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role} value={role}>
                {role}
              </SelectItem>
            ))}
            {group && group.lead.agentRole == null ? (
              <SelectItem value="fixed">{`its fixed model (${modelLabel(group.lead.modelSelection)})`}</SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
        {roleSummary ? (
          <span className="text-muted-foreground text-xs">
            uses {formatModelSlugName(roleSummary.model)}
            {roleSummary.effort ? ` · ${roleSummary.effort}` : ""}
          </span>
        ) : draft.agentRole !== null && policy.error ? (
          <span className="text-muted-foreground text-xs">
            No role policy on {machineLabel(policyMachine as EnvironmentId)}
          </span>
        ) : null}
      </div>
      <p className="-mt-3 text-muted-foreground text-xs">
        A fresh workspace is a SlipJay workspace in a SlipJay project, and a new worktree elsewhere.
        A SlipJay project always gets one.
      </p>

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
          {group.members.map((member) => (
            <div
              key={`${member.environmentId}:${member.task.id}`}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="font-medium">{machineLabel(member.environmentId)}</span>
              <span className="text-muted-foreground">
                {projectLabel(
                  projectKeyOf(member.environmentId, member.task.projectId) ??
                    member.task.projectId,
                )}
              </span>
              <span className="text-muted-foreground">
                {modelLabel(member.task.modelSelection)}
              </span>
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
              {member.task.lastRunThreadId ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: {
                        environmentId: member.environmentId,
                        threadId: member.task.lastRunThreadId as NonNullable<
                          typeof member.task.lastRunThreadId
                        >,
                      },
                    })
                  }
                >
                  Open thread
                </Button>
              ) : null}
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
          ))}
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

function ChipRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="w-8 shrink-0 pt-1 text-muted-foreground">{props.label}</span>
      <div className="flex flex-wrap gap-1.5">{props.children}</div>
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
