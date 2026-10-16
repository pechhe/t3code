import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  Experiment,
  ExperimentDefinition,
  ExperimentOutcomeInput,
  ExperimentReport,
  ExperimentWorkReport,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ALLOCATION_POLICY_LABELS,
  ORCHESTRATION_POLICY_VARIANTS,
  WORK_TREATMENT_STATUS_LABELS,
  compareWorkTreatment,
  describeExperimentTreatment,
  describeModelSelection,
  describeOrchestrationControls,
  describeUsage,
  describeWorkDeviation,
  describeWorkExclusion,
  describeWorkTaskLaunch,
  formatDurationMs,
  orchestrationControlsError,
} from "@t3tools/client-runtime/experiments";
import { createModelSelection } from "@t3tools/shared/model";
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
import { TraitsPicker } from "../chat/TraitsPicker";
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
import { experimentRolloverBaseline } from "./experimentRolloverPolicy";

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

const DEFAULT_QUESTIONS: Readonly<Record<ExperimentDefinition["lever"], string>> = {
  rollover: "Does an earlier rollover improve verified completion without increasing rework?",
  reviewer: "Which reviewer model finds validated issues with fewer false positives?",
  delegation: "Which delegated model completes eligible tasks with less rework?",
  "orchestration-policy":
    "Does delegating bounded non-UI work earlier reduce total accepted-work usage without lowering independently verified completion?",
  instruction:
    "Does this instruction version improve verified completion without increasing rework?",
};

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
  const [orchestrator, setOrchestrator] = useState<ModelSelection | null>(null);
  const [policyHash, setPolicyHash] = useState("");
  const [reviewerPolicyRevision, setReviewerPolicyRevision] = useState("");
  const [verificationRevision, setVerificationRevision] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  const [editedQuestion, setQuestion] = useState<string | null>(null);
  const question = editedQuestion ?? DEFAULT_QUESTIONS[lever];
  const [outcome, setOutcome] = useState("verified completion");
  const settings = useEnvironmentSettings(environmentId);
  const actualSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const [earlierSoft, setEarlierSoft] = useState<number | null>(null);
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
  const baseline =
    actualSettings &&
    experimentRolloverBaseline(
      actualSettings.contextRollover,
      models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    );
  const softA = baseline?.soft ?? settings.contextRollover.softThreshold;
  const hard = baseline?.hard ?? settings.contextRollover.hardThreshold;
  const softB = earlierSoft ?? Math.max(1, Math.floor(softA * 0.8));
  const [categories, setCategories] = useState("");
  const [reviewScope, setReviewScope] = useState<"change" | "spec">("change");
  const [stop, setStop] = useState("Stop if verified completion falls or rework increases.");
  const [codeRevision, setCodeRevision] = useState("");
  const [briefRevision, setBriefRevision] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !canCreate) return;
    const controlsError =
      lever === "orchestration-policy"
        ? orchestrationControlsError({
            orchestratorSelection: orchestrator,
            policyHash,
            reviewerPolicyRevision,
            verificationRevision,
            concurrency,
          })
        : null;
    if (controlsError) {
      setError(controlsError);
      return;
    }
    if (
      !title.trim() ||
      !question.trim() ||
      !outcome.trim() ||
      (lever === "rollover"
        ? !baseline || softA >= hard || softB >= softA
        : lever !== "orchestration-policy" && (!modelA || !modelB)) ||
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
        ...(lever === "orchestration-policy" && orchestrator
          ? {
              orchestrationControls: {
                orchestratorSelection: orchestrator,
                policyHash: policyHash.trim(),
                reviewerPolicyRevision: reviewerPolicyRevision.trim(),
                verificationRevision: verificationRevision.trim(),
                concurrency,
              },
            }
          : {}),
        primaryOutcome: outcome.trim(),
        variants:
          lever === "orchestration-policy"
            ? ORCHESTRATION_POLICY_VARIANTS
            : lever === "rollover"
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
          ...(lever === "reviewer" ? { reviewScopes: [reviewScope] } : {}),
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
        assign the selected model to eligible tasks. Orchestration-policy trials assign each
        enrolled work package to inline-first or delegate-earlier before its parent decides how to
        execute it. Empty eligibility filters include all projects, models or categories in this
        environment.
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
          <option value="orchestration-policy">Orchestration policies</option>
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
      {lever === "orchestration-policy" ? (
        <div className="space-y-3">
          <p className="text-sm">
            Compares {ALLOCATION_POLICY_LABELS["inline-first"]} with{" "}
            {ALLOCATION_POLICY_LABELS["delegate-earlier"]}. Only non-UI work packages enroll. Role
            restrictions apply in both arms: UI work and browser evidence keep their restricted
            routes, and an unsupported route is refused rather than substituted. A running
            delegation-model trial in the same projects cannot run alongside this one.
          </p>
          <TrialModelPicker
            environmentId={environmentId}
            label="Parent model and effort (held fixed in both arms)"
            selection={orchestrator}
            onChange={setOrchestrator}
            withOptions
          />
          <label className="block text-sm">
            Agent policy hash
            <Input
              required
              value={policyHash}
              onChange={(event) => setPolicyHash(event.target.value)}
              placeholder="64-character hash from t3 agent roles"
              spellCheck={false}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Reviewer policy revision
              <Input
                required
                value={reviewerPolicyRevision}
                onChange={(event) => setReviewerPolicyRevision(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Verification revision
              <Input
                required
                value={verificationRevision}
                onChange={(event) => setVerificationRevision(event.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Concurrent managed tasks per parent
            <Input
              type="number"
              min={1}
              required
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Work enrolled under a different parent selection or agent policy is recorded as an
            exclusion, not assigned. Eligible model names below filter by the parent model.
          </p>
        </div>
      ) : lever === "rollover" ? (
        <div className="space-y-3">
          <p className="text-sm">
            Environment default:{" "}
            {!actualSettings
              ? "loading environment settings…"
              : settings.contextRollover.enabled
                ? `${settings.contextRollover.softThreshold.toLocaleString()} soft / ${settings.contextRollover.hardThreshold.toLocaleString()} hard`
                : "rollover disabled"}
            .
          </p>
          {(actualSettings?.contextRollover.modelRules ?? []).map((rule) => (
            <p key={rule.modelPattern} className="text-xs text-muted-foreground">
              Model names containing “{rule.modelPattern}”:{" "}
              {rule.enabled
                ? `${rule.softThreshold.toLocaleString()} soft / ${rule.hardThreshold.toLocaleString()} hard`
                : "rollover disabled"}
              . First matching rule wins.
            </p>
          ))}
          {baseline ? (
            <p className="text-sm">
              Current control for selected eligibility: {softA.toLocaleString()} soft. Both variants
              retain {hard.toLocaleString()} hard.
            </p>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {!actualSettings
                ? "Wait for this environment’s settings before saving a rollover trial."
                : settings.contextRollover.enabled
                  ? "Eligible models have different or disabled policies. Enter exact eligible model names below with one shared enabled policy before saving."
                  : "Rollover is disabled in this environment. Enable it before comparing the current policy with an earlier rollover."}
            </p>
          )}
          <label className="block text-sm">
            Earlier soft limit
            <Input
              type="number"
              min={1}
              max={softA - 1}
              required
              value={softB}
              disabled={!baseline}
              onChange={(event) => setEarlierSoft(Number(event.target.value))}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Current control and hard limits follow the selected models’ configured policy and cannot
            be changed here. Provider context safety clamps still apply to both variants.
          </p>
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
          onChange={(event) => {
            setModels(event.target.value);
            setEarlierSoft(null);
          }}
          placeholder="All models"
        />
      </label>
      {lever === "reviewer" && (
        <label className="block text-sm">
          Reviews compared
          <select
            className="mt-1 block rounded-md border bg-background p-2"
            value={reviewScope}
            onChange={(event) => setReviewScope(event.target.value as "change" | "spec")}
          >
            <option value="change">Change reviews (a candidate landing)</option>
            <option value="spec">Spec reviews (the integrated outcome)</option>
          </select>
        </label>
      )}
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
      <Button
        type="submit"
        size="sm"
        disabled={pending || !canCreate || (lever === "rollover" && !baseline)}
      >
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
            {variant.label}
            {variant.allocationPolicy ? "" : `: ${describeExperimentTreatment(variant)}`}
          </p>
        ))}
      </div>
      {experiment.orchestrationControls && (
        <p className="text-xs text-muted-foreground">
          Held fixed in both arms: {describeOrchestrationControls(experiment.orchestrationControls)}
          .
        </p>
      )}
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
                  .{" "}
                  {report.data.work
                    ? "Policy summaries cover every enrolled unit; work details cover this page only."
                    : "Variant counts and reviewed outcomes below cover this page only."}
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
              {report.data.work && (
                <OrchestrationPolicyReport
                  environmentId={environmentId}
                  report={report.data}
                  work={report.data.work}
                  refresh={report.refresh}
                />
              )}
              {(report.data.work ? [] : experiment.variants).map((variant) => {
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
                        {row.assignment.threadId === null ? (
                          <p>
                            {row.assignment.unitKind} {row.assignment.unitId}
                          </p>
                        ) : (
                          <Link
                            to="/$environmentId/$threadId"
                            params={{ environmentId, threadId: row.assignment.threadId }}
                            className="underline"
                          >
                            Open thread · {row.assignment.unitKind} {row.assignment.unitId}
                          </Link>
                        )}
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
                            {entry.kind} at {entry.usedTokens?.toLocaleString() ?? "unavailable"}{" "}
                            tokens
                            {entry.recoveredTokens !== undefined
                              ? ` · ${entry.recoveredTokens.toLocaleString()} tokens recovered`
                              : ""}
                            {entry.growthTokens !== undefined
                              ? ` · ${entry.growthTokens.toLocaleString()} tokens subsequent growth`
                              : ""}
                            {entry.delayMs !== undefined
                              ? ` · ${(entry.delayMs / 1000).toFixed(1)}s to rollover`
                              : ""}
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

function OrchestrationPolicyReport({
  environmentId,
  report,
  work,
  refresh,
}: {
  environmentId: EnvironmentId;
  report: ExperimentReport;
  work: readonly ExperimentWorkReport[];
  refresh: () => void;
}) {
  const exclusions = report.exclusions ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {report.uncertainty} No policy is promoted automatically. Usage is token counts only; no
        charges, prices or subscription usage are inferred.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(report.policySummary ?? []).map((summary) => (
          <div key={summary.assignedPolicy} className="space-y-1 rounded-md border p-3 text-xs">
            <h4 className="text-sm font-medium">
              {ALLOCATION_POLICY_LABELS[summary.assignedPolicy]} · {summary.assignedCount} assigned
            </h4>
            <p>
              Actual allocation: {summary.actualInlineCount} inline · {summary.actualDelegatedCount}{" "}
              delegated · {summary.allocationUnknownCount} not yet recorded ·{" "}
              {summary.deviationCount} with deviations
            </p>
            <p>
              {summary.independentlyAcceptedCount} independently accepted ·{" "}
              {summary.incompleteCount} not yet accepted · {summary.failureCount} with failures or
              blocked launches · {summary.cancellationCount} cancelled
            </p>
            <p>
              Coverage gaps: {summary.missingParentCount} with incomplete parent usage ·{" "}
              {summary.incompleteChildCount} with incomplete child usage
            </p>
            <p>
              Elapsed to accepted work:{" "}
              {summary.acceptedElapsed.n === 0
                ? "no accepted units yet"
                : `n=${summary.acceptedElapsed.n} · mean ${formatDurationMs(
                    summary.acceptedElapsed.meanMs === null
                      ? null
                      : Math.round(summary.acceptedElapsed.meanMs),
                  )} · range ${formatDurationMs(summary.acceptedElapsed.minMs)}–${formatDurationMs(
                    summary.acceptedElapsed.maxMs,
                  )}`}
            </p>
            <p>Parent plus child total: {describeUsage(summary.usage)}</p>
          </div>
        ))}
      </div>
      <div className="rounded-md border p-3 text-xs">
        <h4 className="text-sm font-medium">Exclusions · {exclusions.length}</h4>
        {exclusions.length === 0 ? (
          <p className="text-muted-foreground">No enrolled work was excluded from this trial.</p>
        ) : (
          exclusions.map((exclusion) => (
            <p key={exclusion.unit.id}>
              Work {exclusion.unit.workId}: {exclusion.unit.description} ·{" "}
              {describeWorkExclusion(exclusion.reason)}
            </p>
          ))
        )}
      </div>
      {work.map((entry) => (
        <WorkUnitReport
          key={entry.unit.id}
          environmentId={environmentId}
          experimentId={report.experiment.id}
          work={entry}
          assignment={report.assignments.find(
            (row) => row.assignment.unitKind === "work" && row.assignment.unitId === entry.unit.id,
          )}
          refresh={refresh}
        />
      ))}
    </div>
  );
}

function WorkUnitReport({
  environmentId,
  experimentId,
  work,
  assignment,
  refresh,
}: {
  environmentId: EnvironmentId;
  experimentId: string;
  work: ExperimentWorkReport;
  assignment: ExperimentReport["assignments"][number] | undefined;
  refresh: () => void;
}) {
  const { unit } = work;
  const treatment = compareWorkTreatment(work, experimentId);
  const firstAllocation = work.allocations[0];
  const blocked = work.tasks.flatMap((task) => {
    const reason = describeWorkTaskLaunch(task).blockedReason;
    return reason === null ? [] : [{ taskId: task.taskId, reason }];
  });
  const phases = Object.entries(work.phaseMs).filter(([, value]) => value !== null);
  const telemetry = work.evidence.filter((entry) => entry.source === "provider-telemetry").length;
  return (
    <div className="space-y-1 rounded-md border p-3 text-xs">
      <h4 className="text-sm font-medium">
        Work {unit.workId}: {unit.description}
      </h4>
      <p className="text-muted-foreground">
        {unit.taskCategory} · {unit.taskClass} · enrolled{" "}
        {new Date(unit.createdAt).toLocaleString()} ·{" "}
        {unit.owner.parentThreadId === null ? (
          "external parent session"
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: unit.owner.parentThreadId }}
            className="underline"
          >
            Open parent thread
          </Link>
        )}
      </p>
      <p>
        Assigned{" "}
        {treatment.assignedPolicy ? ALLOCATION_POLICY_LABELS[treatment.assignedPolicy] : "none"}
        {assignment ? ` at ${new Date(assignment.assignment.assignedAt).toLocaleString()}` : ""} ·
        first allocation{" "}
        {firstAllocation
          ? new Date(firstAllocation.recordedAt).toLocaleString()
          : "not yet recorded"}{" "}
        · actual {treatment.actualAllocation ?? "not yet recorded"} ·{" "}
        {WORK_TREATMENT_STATUS_LABELS[treatment.status]}
      </p>
      {work.allocations.map((allocation) => (
        <p key={allocation.id}>
          Allocation {allocation.allocation}: {allocation.reason}
          {allocation.deviationReason ? ` · exception: ${allocation.deviationReason}` : ""} · parent
          self-report, {new Date(allocation.recordedAt).toLocaleString()}
        </p>
      ))}
      {work.deviations.length > 0 && (
        <p>Deviations: {work.deviations.map(describeWorkDeviation).join(" · ")}</p>
      )}
      <p>
        Parent: {describeModelSelection(unit.orchestratorSelection)} ({unit.modelSource}) · coverage{" "}
        {work.parentCoverage} · {describeUsage(work.parentUsage)}
      </p>
      <p>
        Children: coverage {work.childCoverage}
        {work.childCoverage === "not-applicable" ? "" : ` · ${describeUsage(work.childUsage)}`}
      </p>
      {work.tasks.map((task) => (
        <p key={task.taskId}>
          {task.binding.role} ({task.binding.taskClass}) · requested{" "}
          {describeModelSelection(task.binding.requested)} · assigned{" "}
          {task.binding.assigned ? describeModelSelection(task.binding.assigned) : "none"} ·
          effective {describeModelSelection(task.binding.effective)} ·{" "}
          {describeWorkTaskLaunch(task).label}
        </p>
      ))}
      {blocked.map((entry) => (
        <p key={entry.taskId} role="alert" className="text-destructive">
          Blocked: {entry.reason}
        </p>
      ))}
      <p>Total: {describeUsage(work.usage)}</p>
      {work.usage.status !== "complete" && (
        <p>Observed subtotal (not a complete total): {describeUsage(work.observedUsage)}</p>
      )}
      <p>
        Elapsed to accepted work {formatDurationMs(work.elapsedToAcceptedMs)} · active{" "}
        {formatDurationMs(work.activeMs)} · observed parent/child overlap{" "}
        {formatDurationMs(work.overlapMs)} (simultaneous activity, not proof of useful parallelism)
      </p>
      {phases.length > 0 && (
        <p>
          Phases:{" "}
          {phases.map(([phase, value]) => `${phase} ${formatDurationMs(value)}`).join(" · ")}
        </p>
      )}
      <p>
        {work.evidence.length} evidence records · {telemetry} provider telemetry ·{" "}
        {work.evidence.length - telemetry} self-reported
      </p>
      <p>
        {work.independentlySupportedAcceptance
          ? "Independently supported acceptance recorded."
          : "No independently supported acceptance yet; parent or child claims alone do not count."}
      </p>
      {work.outcomes.map((entry) => (
        <p key={entry.id}>
          {entry.kind} · {entry.source}: {entry.note} {entry.evidence.join(" · ")}
        </p>
      ))}
      {work.coExposureIds.length > 0 && <p>Also exposed to: {work.coExposureIds.join(", ")}</p>}
      {assignment && (
        <OutcomeCapture
          environmentId={environmentId}
          assignmentId={assignment.assignment.id}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function TrialModelPicker({
  environmentId,
  label,
  selection,
  onChange,
  withOptions = false,
}: {
  environmentId: EnvironmentId;
  label: string;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  /** Also choose provider options such as effort, which then form part of the treatment. */
  withOptions?: boolean;
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
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  return (
    <div className="space-y-2 text-sm">
      <p>{label}</p>
      <div className="flex flex-wrap items-center gap-1.5">
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
        {withOptions && selection && activeEntry && (
          <TraitsPicker
            provider={activeEntry.driverKind}
            models={activeEntry.models}
            model={selection.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={selection.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            onModelOptionsChange={(options) =>
              onChange(createModelSelection(selection.instanceId, selection.model, options))
            }
          />
        )}
      </div>
      {withOptions && selection && (
        <p className="text-xs text-muted-foreground">
          Recorded as {describeModelSelection(selection)}.
        </p>
      )}
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
