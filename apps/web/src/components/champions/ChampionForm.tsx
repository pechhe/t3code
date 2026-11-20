import {
  DEFAULT_CHAMPION_INSTRUCTIONS,
  type ChampionConfig,
  type ChampionSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ScheduleDraft,
  scheduleDraftOf,
  timedScheduleOf,
} from "../scheduled/scheduledTasks.logic";
import { readMainAppProjectRef } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";
import { deriveChampionName } from "./champions.logic";
import { ChampionMachineNotice } from "./ChampionMachineNotice";
import { useChampionAction, useChampionCommandAllowed } from "./useChampionAction";

const DEFAULT_SCHEDULE: ChampionConfig["schedule"] = { type: "fixed_time", timeOfDay: "06:00" };
const DEFAULT_CHARTER: ChampionConfig["charter"] = {
  maxConcurrentRepairs: 1,
  maxRepairsPerDay: 3,
  instructions: DEFAULT_CHAMPION_INSTRUCTIONS,
};
const MAX_CONCURRENT_REPAIRS = [0, 1, 2, 3, 4] as const;
const MAX_REPAIRS_PER_DAY = 20;
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const CADENCE_LABELS = {
  interval: "Every few minutes",
  daily: "Every day",
  weekdays: "Every weekday",
  days: "On chosen days",
} as const;
type CadenceKind = keyof typeof CADENCE_LABELS;

function CadenceField(props: {
  readonly draft: ScheduleDraft;
  readonly onChange: (patch: Partial<ScheduleDraft>) => void;
}) {
  const { draft } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Cadence</Label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select value={draft.kind} onValueChange={(kind) => kind && props.onChange({ kind })}>
          <SelectTrigger size="sm" className="w-auto" aria-label="How often it checks">
            <SelectValue>{CADENCE_LABELS[draft.kind as CadenceKind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(CADENCE_LABELS) as CadenceKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {CADENCE_LABELS[kind]}
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
              className="w-20"
              aria-label="Minutes between checks"
              value={draft.intervalMinutes}
              onChange={(event) => props.onChange({ intervalMinutes: event.target.value })}
            />
            <span className="text-muted-foreground">minutes</span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">at</span>
            <Input
              type="time"
              nativeInput
              className="w-32"
              aria-label="Time of day"
              value={draft.timeOfDay}
              onChange={(event) => props.onChange({ timeOfDay: event.target.value })}
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
                props.onChange({
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
    </div>
  );
}

interface ProjectOption {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

function useProjectOptions(): ReadonlyArray<ProjectOption> {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const machines = new Set(projects.map((project) => project.environmentId));
  const machineLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "Machine";
  return projects
    .filter((project) => !project.isScratch)
    .map((project) => ({
      key: `${project.environmentId}:${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      label:
        machines.size > 1
          ? `${project.title} · ${machineLabel(project.environmentId)}`
          : project.title,
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function defaultProjectKey(options: ReadonlyArray<ProjectOption>): string | null {
  const only = options.length === 1 ? options[0] : undefined;
  if (only) return only.key;
  const ref = readMainAppProjectRef();
  const current =
    ref && options.find((option) => `${ref.environmentId}:${ref.projectId}` === option.key);
  return current?.key ?? null;
}

export function ChampionForm(props: {
  readonly existing: {
    readonly environmentId: EnvironmentId;
    readonly champion: ChampionSummary;
  } | null;
  readonly onDone: (
    target: {
      readonly environmentId: EnvironmentId;
      readonly id: string;
      readonly view?: "metrics";
    } | null,
  ) => void;
}) {
  const options = useProjectOptions();
  const [projectKey, setProjectKey] = useState<string | null>(() => defaultProjectKey(options));
  const selectedProject = options.find((option) => option.key === projectKey) ?? null;
  const environmentId =
    props.existing?.environmentId ?? selectedProject?.environmentId ?? options[0]?.environmentId;
  if (environmentId === undefined) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            A champion watches one project on one machine. Add a project first.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ChampionFormFields
      existing={props.existing}
      environmentId={environmentId}
      options={options}
      project={selectedProject}
      projectKey={projectKey}
      onProjectChange={setProjectKey}
      onDone={props.onDone}
    />
  );
}

function ChampionFormFields(props: {
  readonly existing: {
    readonly environmentId: EnvironmentId;
    readonly champion: ChampionSummary;
  } | null;
  readonly environmentId: EnvironmentId;
  readonly options: ReadonlyArray<ProjectOption>;
  readonly project: ProjectOption | null;
  readonly projectKey: string | null;
  readonly onProjectChange: (key: string) => void;
  readonly onDone: (
    target: {
      readonly environmentId: EnvironmentId;
      readonly id: string;
      readonly view?: "metrics";
    } | null,
  ) => void;
}) {
  const champion = props.existing?.champion ?? null;
  const { environmentId } = props;
  const [firstId] = useState(() => champion?.id ?? randomUUID());
  const [attempted, setAttempted] = useState<{
    readonly key: string;
    readonly id: string;
  } | null>(null);
  const [purpose, setPurpose] = useState(champion?.purpose ?? "");
  const [name, setName] = useState(champion?.name ?? "");
  const [schedule, setSchedule] = useState<ScheduleDraft>(() =>
    scheduleDraftOf(champion?.schedule ?? DEFAULT_SCHEDULE),
  );
  const charter = champion?.charter ?? DEFAULT_CHARTER;
  const [maxConcurrent, setMaxConcurrent] = useState(charter.maxConcurrentRepairs);
  const [maxPerDay, setMaxPerDay] = useState(String(charter.maxRepairsPerDay));
  const [instructions, setInstructions] = useState(charter.instructions);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useChampionAction();
  const upsert = useAtomCommand(serverEnvironment.upsertChampion, {
    label: "champion save",
    reportFailure: false,
  });
  const setup = useAtomCommand(serverEnvironment.setupChampion, {
    label: "champion setup",
  });
  const canSave = useChampionCommandAllowed(serverEnvironment.upsertChampion, environmentId);
  const canSetup = useChampionCommandAllowed(serverEnvironment.setupChampion, environmentId);
  const projectId = champion?.projectId ?? props.project?.projectId ?? null;
  const configOf = (): ChampionConfig | null => {
    if (!purpose.trim() || projectId === null) {
      setProblem("Say what should stay true and choose a project.");
      return null;
    }
    const finalName = name.trim() || deriveChampionName(purpose);
    const timed = timedScheduleOf(schedule);
    const perDay = Number(maxPerDay);
    if (timed === null) {
      setAdvancedOpen(true);
      setProblem("Check the cadence. Run every whole number of minutes, at least one.");
      return null;
    }
    if (timed.type === "once") {
      setAdvancedOpen(true);
      setProblem("A champion checks on a cadence, so pick an interval or a time of day.");
      return null;
    }
    if (!Number.isInteger(perDay) || perDay < 0 || perDay > MAX_REPAIRS_PER_DAY) {
      setAdvancedOpen(true);
      setProblem(`Repairs per day must be a whole number from 0 to ${MAX_REPAIRS_PER_DAY}.`);
      return null;
    }
    setProblem(null);
    return {
      id: firstId,
      projectId,
      name: finalName,
      purpose: purpose.trim(),
      schedule: timed,
      ...(champion?.models === undefined ? {} : { models: champion.models }),
      charter: {
        maxConcurrentRepairs: maxConcurrent,
        maxRepairsPerDay: perDay,
        instructions,
      },
    };
  };

  const submitNew = async (mode: "propose" | "manual") => {
    const config = configOf();
    if (config === null) return;
    const destination = props.project?.environmentId;
    if (destination === undefined || props.projectKey === null) return;
    // A failed save may still have landed, and a draft can't move to another project.
    const id =
      attempted === null || attempted.key === props.projectKey
        ? (attempted?.id ?? firstId)
        : randomUUID();
    setAttempted({ key: props.projectKey, id });
    const created = await run(mode, "save", [
      () => upsert({ environmentId: destination, input: { ...config, id } }),
    ]);
    if (!created) return;
    if (mode === "propose") {
      await run("propose", "setup", [() => setup({ environmentId: destination, input: { id } })]);
    }
    props.onDone({
      environmentId: destination,
      id,
      ...(mode === "manual" ? { view: "metrics" as const } : {}),
    });
  };

  const saveExisting = async () => {
    const config = configOf();
    if (config === null || props.existing === null) return;
    const existing = props.existing;
    const saved = await run("save", "save", [
      () => upsert({ environmentId: existing.environmentId, input: config }),
    ]);
    if (saved) props.onDone({ environmentId: existing.environmentId, id: config.id });
  };

  const AdvancedChevron = advancedOpen ? ChevronDownIcon : ChevronRightIcon;
  const disabled = busy !== null;
  return (
    <form
      className="mx-auto flex max-w-180 flex-col gap-5 p-4 sm:p-6"
      noValidate
      onSubmit={(event) => event.preventDefault()}
    >
      <h2 className="font-semibold text-lg">
        {champion ? `Edit ${champion.name}` : "New champion"}
      </h2>
      <ChampionMachineNotice environmentId={environmentId} draft />
      {champion ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="champion-name">Name</Label>
          <Input
            id="champion-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="champion-purpose">Goal</Label>
        <Textarea
          id="champion-purpose"
          placeholder="What good looks like, in a sentence or two. For example: YardSmith feels instant, with every common screen usable in under 300 ms on Production."
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Project</Label>
        {champion ? (
          <p className="text-muted-foreground text-sm">
            {props.options.find(
              (option) =>
                option.environmentId === environmentId && option.projectId === champion.projectId,
            )?.label ?? "This champion's project isn't loaded here."}{" "}
            A champion stays with the project it was made for.
          </p>
        ) : (
          <Select
            value={props.projectKey}
            onValueChange={(value) => value && props.onProjectChange(value)}
          >
            <SelectTrigger aria-label="Project">
              <SelectValue>{props.project?.label ?? "Choose a project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </div>

      {champion === null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || !canSave || !canSetup}
              onClick={() => void submitNew("propose")}
            >
              {busy === "propose" ? "Starting…" : "Set up metrics with AI"}
            </Button>
            <Button
              variant="ghost"
              disabled={disabled || !canSave}
              onClick={() => void submitNew("manual")}
            >
              Add metrics myself
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Setup reads your remit and the evidence available in this project, then sets what to
            track and starts the champion.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <AdvancedChevron aria-hidden />
          Advanced settings
        </Button>
        {advancedOpen ? (
          <div className="flex flex-col gap-4 rounded-lg border p-3">
            {champion === null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="champion-name">Name</Label>
                <Input
                  id="champion-name"
                  placeholder={deriveChampionName(purpose) || "Name this champion"}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            ) : null}
            <CadenceField
              draft={schedule}
              onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="champion-charter">Repair charter</Label>
              <Textarea
                id="champion-charter"
                placeholder="What may be repaired without asking? Anything outside this becomes a Spec."
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Repairs at once</Label>
                <Select
                  value={maxConcurrent}
                  onValueChange={(value) => value !== null && setMaxConcurrent(value)}
                >
                  <SelectTrigger size="sm" aria-label="Repairs at once">
                    <SelectValue>
                      {maxConcurrent === 0 ? "None, measure only" : maxConcurrent}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {MAX_CONCURRENT_REPAIRS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === 0 ? "None, measure only" : value}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="champion-repairs-per-day">Repairs per day</Label>
                <Input
                  id="champion-repairs-per-day"
                  type="number"
                  nativeInput
                  min={0}
                  max={MAX_REPAIRS_PER_DAY}
                  value={maxPerDay}
                  onChange={(event) => setMaxPerDay(event.target.value)}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Workers, reviewers, and design and release gates follow normal role policy. See Usage
              for what this consumes.
            </p>
          </div>
        ) : null}
      </div>

      {problem || error ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          {problem ?? error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={disabled} onClick={() => props.onDone(null)}>
          Cancel
        </Button>
        {champion ? (
          <Button disabled={disabled || !canSave} onClick={() => void saveExisting()}>
            Save
          </Button>
        ) : null}
      </div>
    </form>
  );
}
