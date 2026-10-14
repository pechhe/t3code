import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  Experiment,
  ExperimentDefinition,
  ExperimentOutcomeInput,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useMemo, useState, type FormEvent } from "react";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  applyProviderInstanceSettings,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ExperimentsSettings() {
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Experiments" variant="plain">
        <p className="text-sm text-muted-foreground">
          Compare one policy at a time on newly eligible work. Save a draft, review its boundaries,
          then explicitly start enrollment. Pausing stops new assignments; existing assignments keep
          their recorded variant.
        </p>
        {environments.length === 0 && <p>Connect an environment to manage trials.</p>}
        {environments.map((environment) => (
          <EnvironmentExperiments key={environment.environmentId} environment={environment} />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentExperiments({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const connected = environment.connection.phase === "connected";
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.experimentsList({ environmentId, input: {} }) : null,
  );
  const canCreate = useAtomValue(serverEnvironment.experimentsCreate.permissionAtom(environmentId));
  const [creating, setCreating] = useState(false);
  return (
    <SettingsSection
      title={environment.label}
      headerAction={
        <div className="flex gap-2">
          <Button size="xs" variant="ghost-muted" disabled={!connected} onClick={query.refresh}>
            Refresh
          </Button>
          <Button
            size="xs"
            disabled={!connected || !canCreate}
            onClick={() => setCreating(!creating)}
          >
            New trial
          </Button>
        </div>
      }
    >
      {!connected && (
        <p className="p-4 text-sm">Reconnect this environment to view its experiments.</p>
      )}
      {query.error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.isPending && !query.data && <p className="p-4 text-sm">Loading experiments…</p>}
      {creating && (
        <ExperimentDraft
          environmentId={environmentId}
          onSaved={() => {
            setCreating(false);
            query.refresh();
          }}
        />
      )}
      {query.data?.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">
          No experiments yet. Create a bounded trial to compare outcomes and resource use.
        </p>
      )}
      {query.data?.map((experiment) => (
        <ExperimentRow
          key={experiment.id}
          experiment={experiment}
          environmentId={environmentId}
          refresh={query.refresh}
        />
      ))}
    </SettingsSection>
  );
}

function ExperimentDraft({
  environmentId,
  onSaved,
}: {
  environmentId: EnvironmentId;
  onSaved: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const create = useAtomCommand(serverEnvironment.experimentsCreate);
  const canCreate = useAtomValue(serverEnvironment.experimentsCreate.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [lever, setLever] = useState<ExperimentDefinition["lever"]>("rollover");
  const [modelA, setModelA] = useState<ModelSelection | null>(null);
  const [modelB, setModelB] = useState<ModelSelection | null>(null);
  const [question, setQuestion] = useState(
    "Does an earlier rollover improve verified completion without increasing rework?",
  );
  const [outcome, setOutcome] = useState("verified completion");
  const [softA, setSoftA] = useState(150000);
  const [softB, setSoftB] = useState(120000);
  const [hard, setHard] = useState(180000);
  const [limit, setLimit] = useState(40);
  const [end, setEnd] = useState(() =>
    (() => {
      const date = new Date(Date.now() + 7 * 86400000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    })(),
  );
  const [projectIds, setProjectIds] = useState<ExperimentDefinition["eligibility"]["projectIds"]>(
    [],
  );
  const [models, setModels] = useState("");
  const [categories, setCategories] = useState("");
  const [stop, setStop] = useState("Stop if verified completion falls or rework increases.");
  const [codeRevision, setCodeRevision] = useState("");
  const [briefRevision, setBriefRevision] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !canCreate) return;
    if (
      !title.trim() ||
      !question.trim() ||
      !outcome.trim() ||
      (lever === "rollover" ? softA >= hard || softB >= hard : !modelA || !modelB) ||
      !Number.isFinite(Date.parse(end)) ||
      Date.parse(end) <= Date.now()
    ) {
      setError(
        "Provide a title, question and outcome, choose two models or soft limits below the hard limit, and choose a future end date.",
      );
      return;
    }
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        id: randomUUID(),
        title: title.trim(),
        question: question.trim(),
        lever,
        primaryOutcome: outcome.trim(),
        variants:
          lever === "rollover"
            ? [
                {
                  id: "a",
                  label: "Current rollover",
                  rollover: { softLimit: softA, hardLimit: hard },
                },
                {
                  id: "b",
                  label: "Earlier rollover",
                  rollover: { softLimit: softB, hardLimit: hard },
                },
              ]
            : [
                { id: "a", label: "Model A", modelSelection: modelA! },
                { id: "b", label: "Model B", modelSelection: modelB! },
              ],
        eligibility: {
          projectIds,
          models: models
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          taskCategories: categories
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
        maxAssignments: limit,
        endsAt: new Date(end).toISOString(),
        stopConditions: stop
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        codeRevision: codeRevision.trim() || null,
        briefRevision: briefRevision.trim() || null,
      },
    });
    setPending(false);
    if (result._tag === "Success") onSaved();
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 border-b p-4">
      <h3 className="text-sm font-medium">New trial</h3>
      <p className="text-xs text-muted-foreground">
        Rollover trials use thread assignments and token limits. Reviewer and delegation trials
        assign the selected model to eligible tasks. Empty eligibility filters include all projects,
        models or categories in this environment.
      </p>
      <label className="block text-sm">
        Compare
        <select
          className="mt-1 block rounded-md border bg-background p-2"
          value={lever}
          onChange={(event) => setLever(event.target.value as ExperimentDefinition["lever"])}
        >
          <option value="rollover">Rollover policies</option>
          <option value="reviewer">Reviewer models</option>
          <option value="delegation">Delegation models</option>
        </select>
      </label>
      <label className="block text-sm">
        Title
        <Input required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="block text-sm">
        Question
        <Textarea required value={question} onChange={(event) => setQuestion(event.target.value)} />
      </label>
      <label className="block text-sm">
        Primary outcome
        <Input required value={outcome} onChange={(event) => setOutcome(event.target.value)} />
      </label>
      {lever === "rollover" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "Current soft limit", value: softA, setter: setSoftA },
            { label: "Earlier soft limit", value: softB, setter: setSoftB },
            { label: "Shared hard limit", value: hard, setter: setHard },
          ].map(({ label, value, setter }) => (
            <label key={label} className="text-sm">
              {label}
              <Input
                type="number"
                min={1}
                required
                value={value}
                onChange={(event) => setter(Number(event.target.value))}
              />
            </label>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <TrialModelPicker
            environmentId={environmentId}
            label="Model A"
            selection={modelA}
            onChange={setModelA}
          />
          <TrialModelPicker
            environmentId={environmentId}
            label="Model B"
            selection={modelB}
            onChange={setModelB}
          />
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm">Eligible projects</legend>
        {projects.map((project) => (
          <label key={project.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={projectIds.includes(project.id)}
              onChange={(event) =>
                setProjectIds(
                  event.target.checked
                    ? [...projectIds, project.id]
                    : projectIds.filter((id) => id !== project.id),
                )
              }
            />
            {project.title}
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        Eligible model names (comma separated)
        <Input
          value={models}
          onChange={(event) => setModels(event.target.value)}
          placeholder="All models"
        />
      </label>
      <label className="block text-sm">
        Task categories (comma separated)
        <Input
          value={categories}
          onChange={(event) => setCategories(event.target.value)}
          placeholder="All categories"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Maximum assignments
          <Input
            type="number"
            min={1}
            required
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
        <label className="text-sm">
          End date and time
          <Input
            type="datetime-local"
            required
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
      </div>
      <label className="block text-sm">
        Human stop criteria (one per line)
        <Textarea value={stop} onChange={(event) => setStop(event.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">
        Assignment count and end date stop enrollment automatically. Human stop criteria need a
        person to review them.
      </p>
      <label className="block text-sm">
        Code revision (optional)
        <Input value={codeRevision} onChange={(event) => setCodeRevision(event.target.value)} />
      </label>
      <label className="block text-sm">
        Brief revision (optional)
        <Input value={briefRevision} onChange={(event) => setBriefRevision(event.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending || !canCreate}>
        {pending ? "Saving…" : "Save draft"}
      </Button>
    </form>
  );
}

function ExperimentRow({
  experiment,
  environmentId,
  refresh,
}: {
  experiment: Experiment;
  environmentId: EnvironmentId;
  refresh: () => void;
}) {
  const transition = useAtomCommand(serverEnvironment.experimentsTransition);
  const canChange = useAtomValue(
    serverEnvironment.experimentsTransition.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportOffset, setReportOffset] = useState(0);
  const report = useEnvironmentQuery(
    showReport
      ? serverEnvironment.experimentsReport({
          environmentId,
          input: { experimentId: experiment.id, offset: reportOffset, limit: 100 },
        })
      : null,
  );
  const change = async (status: "running" | "paused" | "stopped") => {
    if (pending || !canChange) return;
    setPending(true);
    const result = await transition({
      environmentId,
      input: { experimentId: experiment.id, status },
    });
    setPending(false);
    if (result._tag === "Success") {
      refresh();
      report.refresh();
    }
  };
  return (
    <article className="space-y-3 border-b p-4 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{experiment.title}</h3>
          <p className="text-xs text-muted-foreground">
            {experiment.status} · {experiment.lever} · revision {experiment.revision}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(experiment.status === "draft" || experiment.status === "paused") && (
            <Button
              size="xs"
              disabled={!canChange || pending}
              onClick={() => void change("running")}
            >
              {experiment.status === "draft" ? "Start trial" : "Resume"}
            </Button>
          )}
          {experiment.status === "running" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!canChange || pending}
              onClick={() => void change("paused")}
            >
              Pause
            </Button>
          )}
          {experiment.status !== "stopped" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!canChange || pending}
              onClick={() => void change("stopped")}
            >
              Stop
            </Button>
          )}
          <Button size="xs" variant="ghost-muted" onClick={() => setShowReport(!showReport)}>
            {showReport ? "Hide comparison" : "Compare"}
          </Button>
        </div>
      </div>
      <p className="text-sm">{experiment.question}</p>
      <p className="text-xs text-muted-foreground">
        Primary outcome: {experiment.primaryOutcome}. Up to {experiment.maxAssignments} assignments;
        ends {new Date(experiment.endsAt).toLocaleString()}.
      </p>
      <div className="flex flex-wrap gap-4 text-xs">
        {experiment.variants.map((variant) => (
          <p key={variant.id}>
            {variant.label}:{" "}
            {variant.rollover
              ? `${variant.rollover.softLimit.toLocaleString()} soft / ${variant.rollover.hardLimit.toLocaleString()} hard`
              : (variant.modelSelection?.model ?? "Model selection")}
          </p>
        ))}
      </div>
      {showReport && (
        <div className="space-y-3">
          <Button size="xs" variant="ghost-muted" onClick={report.refresh}>
            Refresh evidence
          </Button>
          {report.error && <p role="alert">{report.error}</p>}
          {report.isPending && !report.data && <p className="text-sm">Loading evidence…</p>}
          {report.data && (
            <>
              <p className="text-xs text-muted-foreground">
                Whole trial: {report.data.totalAssignments} assignments ·{" "}
                {report.data.randomizedCount} randomized · {report.data.observationalCount}{" "}
                historical / observational. Evidence read{" "}
                {new Date(report.data.readAt).toLocaleString()}. Missing telemetry is unavailable,
                never zero. Historical comparisons are observational.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">
                  {report.data.assignments.length === 0
                    ? "No assignments on this page"
                    : `Showing assignments ${report.data.offset + 1}–${report.data.offset + report.data.assignments.length} of ${report.data.totalAssignments}`}
                  . Variant counts and reviewed outcomes below cover this page only.
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={report.isPending || report.data.offset === 0}
                  onClick={() => setReportOffset(Math.max(0, report.data!.offset - 100))}
                >
                  Previous page
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={report.isPending || !report.data.hasMore}
                  onClick={() =>
                    setReportOffset(report.data!.offset + report.data!.assignments.length)
                  }
                >
                  Next page
                </Button>
              </div>
              {experiment.variants.map((variant) => {
                const rows = report.data!.assignments.filter(
                  (row) => row.assignment.variant.id === variant.id,
                );
                return (
                  <div key={variant.id} className="rounded-md border p-3">
                    <h4 className="text-sm font-medium">
                      {variant.label} · {rows.length} assignments on this page
                    </h4>
                    {["randomized", "observational"].map((method) => {
                      const group = rows.filter(
                        (row) => row.assignment.assignmentMethod === method,
                      );
                      return (
                        <p key={method} className="mt-1 text-xs text-muted-foreground">
                          {method} on this page: {group.length} assignments ·{" "}
                          {
                            group.filter((row) =>
                              row.outcomes.some(
                                (outcome) =>
                                  outcome.kind === "verified-completion" &&
                                  (outcome.source === "human-review" ||
                                    outcome.source === "independent-evidence"),
                              ),
                            ).length
                          }{" "}
                          reviewed completions ·{" "}
                          {
                            group.filter((row) =>
                              row.outcomes.some((outcome) => outcome.kind === "failure"),
                            ).length
                          }{" "}
                          failures ·{" "}
                          {
                            group.filter((row) =>
                              row.outcomes.some((outcome) => outcome.kind === "rework"),
                            ).length
                          }{" "}
                          with rework
                        </p>
                      );
                    })}
                    {rows.map((row) => (
                      <div key={row.assignment.id} className="mt-3 space-y-1 text-xs">
                        <Link
                          to="/$environmentId/$threadId"
                          params={{ environmentId, threadId: row.assignment.threadId }}
                          className="underline"
                        >
                          Open thread · {row.assignment.unitKind} {row.assignment.unitId}
                        </Link>
                        <p>
                          {row.assignment.assignmentMethod} · assigned{" "}
                          {row.assignment.assignedModelSelection.model} · {row.usage.status} usage
                        </p>
                        <p>
                          Input {row.usage.inputTokens?.toLocaleString() ?? "unavailable"} · output{" "}
                          {row.usage.outputTokens?.toLocaleString() ?? "unavailable"} · active{" "}
                          {row.activeMs === null
                            ? "unavailable"
                            : `${Math.round(row.activeMs / 1000)}s`}{" "}
                          · wall{" "}
                          {row.wallClockMs === null
                            ? "unavailable"
                            : `${Math.round(row.wallClockMs / 1000)}s`}{" "}
                          · wait{" "}
                          {row.waitMs === null
                            ? "unavailable"
                            : `${Math.round(row.waitMs / 1000)}s`}
                        </p>
                        <p>
                          Cached input{" "}
                          {row.usage.cachedInputTokens?.toLocaleString() ?? "unavailable"} · cache
                          creation{" "}
                          {row.usage.cacheCreationTokens?.toLocaleString() ?? "unavailable"} ·
                          reasoning {row.usage.reasoningTokens?.toLocaleString() ?? "unavailable"}
                        </p>
                        <p>
                          {row.usage.missingTurns} missing turns · {row.usage.partialTurns} partial
                          turns
                          {row.usage.hasUnattributedSubagentUsage
                            ? " · unattributed subagent usage"
                            : ""}
                          {!row.projectionAvailable ? " · thread projection unavailable" : ""}
                        </p>
                        <p>
                          Descendant coverage: {row.descendantCoverage}
                          {row.telemetryTruncated
                            ? " · telemetry truncated at the report limit"
                            : ""}
                        </p>
                        {row.missingThreadIds.length > 0 && (
                          <p>
                            Missing thread evidence: {row.missingThreadIds.join(", ")}. Usage and
                            timing omit this unavailable evidence.
                          </p>
                        )}
                        {row.runs.length === 0 ? (
                          <p>No run evidence available.</p>
                        ) : (
                          row.runs.map((run) => (
                            <p key={`${run.threadId}:${run.runId}`}>
                              Run {run.runId}: {run.status} · selected model{" "}
                              {run.modelSelection.model} · requested{" "}
                              {new Date(run.requestedAt).toLocaleString()}
                              {run.startedAt
                                ? ` · started ${new Date(run.startedAt).toLocaleString()}`
                                : " · no recorded start"}
                              {run.completedAt
                                ? ` · ended ${new Date(run.completedAt).toLocaleString()}`
                                : ""}
                              {!row.turns.some(
                                (turn) =>
                                  turn.threadId === run.threadId && turn.runId === run.runId,
                              )
                                ? " · no provider turn evidence"
                                : ""}
                            </p>
                          ))
                        )}
                        {row.coExposureIds.length > 0 && (
                          <p>Also exposed to: {row.coExposureIds.join(", ")}</p>
                        )}
                        {row.outcomes.length === 0 ? (
                          <p>No verified outcome recorded.</p>
                        ) : (
                          row.outcomes.map((entry) => (
                            <p key={entry.id}>
                              {entry.kind} · {entry.source}: {entry.note}{" "}
                              {entry.evidence.join(" · ")}
                            </p>
                          ))
                        )}
                        {row.observations.map((entry) => (
                          <p key={entry.id}>
                            {entry.kind} at {entry.usedTokens.toLocaleString()} tokens
                            {entry.lowYield ? " · low yield" : ""}
                          </p>
                        ))}
                        <OutcomeCapture
                          environmentId={environmentId}
                          assignmentId={row.assignment.id}
                          refresh={report.refresh}
                        />
                        {row.turns.map((turn) => (
                          <p key={turn.providerTurnId}>
                            {turn.modelSource === "run-selection"
                              ? "Selected model"
                              : "Actual model"}
                            : {turn.modelSelection?.model ?? "unknown"} ({turn.modelSource}) ·{" "}
                            {turn.status}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function TrialModelPicker({
  environmentId,
  label,
  selection,
  onChange,
}: {
  environmentId: EnvironmentId;
  label: string;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const instanceId = selection?.instanceId ?? entries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const model = selection?.model ?? "";
  const options = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, instanceId, model),
    [settings, providers, instanceId, model],
  );
  return (
    <div className="space-y-2 text-sm">
      <p>{label}</p>
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        isComposerOwned={false}
        {...(selection ? {} : { triggerLabel: "Choose model" })}
        onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
      />
    </div>
  );
}

const OUTCOME_KINDS: readonly ExperimentOutcomeInput["kind"][] = [
  "verified-completion",
  "failure",
  "cancellation",
  "constraint-missed",
  "user-correction",
  "rework",
  "validated-finding",
  "false-positive",
  "incomplete-review",
  "fallback",
  "manual-override",
];
function OutcomeCapture({
  environmentId,
  assignmentId,
  refresh,
}: {
  environmentId: EnvironmentId;
  assignmentId: string;
  refresh: () => void;
}) {
  const canRecord = useAtomValue(
    serverEnvironment.experimentsRecordOutcome.permissionAtom(environmentId),
  );
  const record = useAtomCommand(serverEnvironment.experimentsRecordOutcome);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [kind, setKind] = useState<ExperimentOutcomeInput["kind"]>("verified-completion");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canRecord || pending || !evidence.trim()) return;
    setPending(true);
    const result = await record({
      environmentId,
      input: {
        id: randomUUID(),
        assignmentId,
        runId: null,
        kind,
        source: "human-review",
        note,
        evidence: evidence
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        actualModelSelection: null,
        fallbackReason: kind === "fallback" ? note.trim() || null : null,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      setOpen(false);
      setNote("");
      setEvidence("");
      refresh();
    }
  };
  return (
    <div>
      <Button size="xs" variant="ghost-muted" disabled={!canRecord} onClick={() => setOpen(!open)}>
        Record reviewed outcome
      </Button>
      {open && (
        <form onSubmit={(event) => void submit(event)} className="mt-2 space-y-2">
          <label className="block">
            Outcome
            <select
              className="ml-2 rounded border bg-background p-1"
              value={kind}
              onChange={(event) => setKind(event.target.value as ExperimentOutcomeInput["kind"])}
            >
              {OUTCOME_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Evidence references (one per line)
            <Textarea
              required
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder="Test result, review finding, artifact or thread evidence"
            />
          </label>
          <label className="block">
            Review note
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <p className="text-muted-foreground">
            Saved as human review evidence. Telemetry and self-reports alone do not verify
            completion.
          </p>
          <Button type="submit" size="xs" disabled={pending || !canRecord || !evidence.trim()}>
            {pending ? "Saving…" : "Save outcome"}
          </Button>
        </form>
      )}
    </div>
  );
}
