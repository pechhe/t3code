import { useAtomValue } from "@effect/atom-react";
import {
  adoptionChange,
  assignmentTitle,
  describeExperimentTreatment,
  describeRecordedOutcome,
  describeResultSource,
  describeVariantSetup,
  experimentKindWords,
  experimentUnit,
  FORGE_UNAVAILABLE_TEXT,
  isRolloverTrial,
  needsAnOutcome,
  outcomeNoteFor,
  pluralize,
  RECORDED_OUTCOME_CHOICES,
  resultRows,
  resultsVerdict,
  trialDraftFromExperiment,
  trialDraftIssues,
  trialProgressWords,
  trialStateWord,
  trialStopWords,
  UNKNOWN_RESULT,
  VARIANT_LETTERS,
  variantNameBesideLetter,
  type AdoptionEntry,
  type RecordedOutcomeChoice,
} from "@t3tools/client-runtime/experiments";
import type {
  EnvironmentId,
  Experiment,
  ExperimentAdoption,
  ExperimentAssignmentReport,
  ExperimentSampleResult,
  ExperimentVariant,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENT_ROLE_PRESENTATION } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  announce,
  commandFailure,
  TrialActionButtons,
  TrialErrorBox,
  TrialNote,
  TrialRow,
  useTrialActions,
  useTrialEnvironment,
  VariantName,
  type TrialEnvironment,
  type TrialFailure,
} from "./ExperimentParts";
import { SettingsSection } from "./settingsLayout";
import { SettingsChoice } from "./SettingsChoice";

const ASSIGNMENTS_PER_PAGE = 100;

export function TrialResults({
  environmentId,
  experimentId,
  onBack,
  onEdit,
}: {
  environmentId: EnvironmentId;
  experimentId: string;
  onBack: () => void;
  onEdit: (experiment: Experiment) => void;
}) {
  const list = useEnvironmentQuery(serverEnvironment.experimentsList({ environmentId, input: {} }));
  const experiment = list.data?.find((trial) => trial.id === experimentId) ?? null;
  return (
    <>
      <div className="px-3 sm:px-4">
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ChevronLeftIcon />
          Experiments
        </Button>
      </div>
      {list.error ? (
        <Alert variant="error">
          <AlertDescription>{list.error}</AlertDescription>
        </Alert>
      ) : null}
      {experiment === null ? (
        <TrialNote className="px-3 sm:px-4">
          {list.isPending ? "Loading this trial…" : "This trial is no longer here."}
        </TrialNote>
      ) : (
        <LoadedTrial
          environmentId={environmentId}
          experiment={experiment}
          others={(list.data ?? []).filter((trial) => trial.id !== experimentId)}
          refreshList={list.refresh}
          onEdit={onEdit}
        />
      )}
    </>
  );
}

function LoadedTrial({
  environmentId,
  experiment,
  others,
  refreshList,
  onEdit,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  others: ReadonlyArray<Experiment>;
  refreshList: () => void;
  onEdit: (experiment: Experiment) => void;
}) {
  const setup = useTrialEnvironment(environmentId);
  const results = useEnvironmentQuery(
    serverEnvironment.experimentsResults({
      environmentId,
      input: { experimentId: experiment.id, limit: ASSIGNMENTS_PER_PAGE },
    }),
  );
  const refresh = () => {
    refreshList();
    results.refresh();
  };
  const actions = useTrialActions(environmentId, experiment, refresh);
  const readOnly = isRolloverTrial(experiment);
  const issues =
    experiment.status === "draft" && !readOnly
      ? trialDraftIssues(trialDraftFromExperiment(experiment), setup.contextFor(others))
      : null;
  const data = results.data;
  const verdict = data === null ? null : resultsVerdict(data);
  const rows = data === null ? [] : resultRows(experiment, data.variants);
  const handEntered = data?.variants.reduce((sum, variant) => sum + variant.enteredByHand, 0) ?? 0;
  const enrolled = data?.variants.reduce((sum, variant) => sum + variant.enrolled, 0) ?? null;
  const needs = readOnly
    ? 0
    : (data?.samples.filter((sample) => needsAnOutcome(experiment, sample)).length ?? 0);
  const unit = experimentUnit(experiment);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [needsOnly, setNeedsOnly] = useState(false);
  return (
    <>
      <SettingsSection title="Results">
        <TrialRow>
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
            <div className="flex min-w-0 flex-[1_1_15rem] flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-medium">{experiment.title}</h3>
              <Badge variant="outline" size="sm">
                {trialStateWord(experiment)}
              </Badge>
            </div>
            <TrialActionButtons
              experiment={experiment}
              actions={actions}
              blocked={issues?.blocked ?? false}
              onEdit={() => onEdit(experiment)}
            />
          </div>
          <TrialNote className="whitespace-pre-wrap">{experiment.question}</TrialNote>
          {readOnly ? (
            <TrialNote>
              This kind of trial can't run any more. It stays here to read, and nothing on this page
              changes anything.
            </TrialNote>
          ) : null}
          <dl className="mt-1 grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Comparing</dt>
            <dd className="m-0 flex min-w-0 flex-col gap-1">
              {experiment.variants.map((variant, index) => (
                <VariantFact
                  key={variant.id}
                  environmentId={environmentId}
                  variant={variant}
                  index={index}
                />
              ))}
            </dd>
            <dt className="text-muted-foreground">Which work</dt>
            <dd className="m-0">
              {experimentKindWords(experiment)}
              {experiment.eligibility.projectIds.length > 0
                ? ` in ${experiment.eligibility.projectIds.map(setup.projectName).join(", ")}`
                : " in every project"}
            </dd>
            <dt className="text-muted-foreground">Stop when</dt>
            <dd className="m-0">{trialStopWords(experiment, setup.now)}</dd>
            <dt className="text-muted-foreground">Progress</dt>
            <dd className="m-0">{trialProgressWords(experiment, enrolled, setup.now)}</dd>
          </dl>
          <TrialErrorBox failure={actions.failure} onDismiss={actions.dismissFailure} />
        </TrialRow>
      </SettingsSection>
      <SettingsSection
        title="Whole trial, by variant"
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={results.refresh}>
            Reload
          </Button>
        }
      >
        <TrialRow className="gap-2.5">
          {results.error ? (
            <Alert variant="error" size="sm">
              <AlertDescription>{results.error}</AlertDescription>
            </Alert>
          ) : null}
          {data === null && results.isPending ? <TrialNote>Loading results…</TrialNote> : null}
          {data !== null && !data.forgeReadable ? (
            <Alert variant="warning" size="sm">
              <AlertDescription>{FORGE_UNAVAILABLE_TEXT}</AlertDescription>
            </Alert>
          ) : null}
          {verdict === null ? null : (
            <Alert variant={verdict.tone} size="sm" role="status">
              <AlertDescription>{verdict.text}</AlertDescription>
            </Alert>
          )}
          {data === null ? null : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs tabular-nums">
                  <thead>
                    <tr>
                      <th scope="col" className="w-[44%] py-1 text-left font-medium">
                        Per variant
                      </th>
                      {data.variants.map((variant, index) => (
                        <th
                          key={variant.variantId}
                          scope="col"
                          className="py-1 pl-3 text-right align-top font-medium"
                        >
                          <VariantName label={variant.label} index={index} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} data-row={row.key} className="border-t border-border/50">
                        <th scope="row" className="py-1 text-left align-top font-normal">
                          <span className="flex flex-wrap justify-between gap-x-2">
                            <span>{row.name}</span>
                            <span className="text-2xs text-muted-foreground">{row.source}</span>
                          </span>
                        </th>
                        {data.variants.map((variant, index) => {
                          const cell = row.cells[index];
                          return cell === undefined ? null : (
                            <td key={variant.variantId} className="py-1 pl-3 text-right align-top">
                              {cell.value === UNKNOWN_RESULT ? (
                                <span className="text-muted-foreground italic">{cell.value}</span>
                              ) : (
                                cell.value
                              )}
                              {cell.coverage === null ? null : (
                                <small className="block text-2xs text-muted-foreground">
                                  {cell.coverage}
                                </small>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {needs > 0 ? (
                <p className="text-xs">
                  {data.hasMore ? "At least " : ""}
                  {needs} landed {pluralize(unit, needs)} {needs === 1 ? "has" : "have"} no outcome
                  yet. A gap shows as unknown, never as zero.{" "}
                  <InlineButton
                    onClick={() => {
                      setNeedsOnly(true);
                      setAssignmentsOpen(true);
                    }}
                  >
                    Show {needs === 1 ? "it" : "them"}
                  </InlineButton>
                </p>
              ) : (
                <TrialNote>A gap shows as unknown, never as zero.</TrialNote>
              )}
              {handEntered > 0 ? (
                <TrialNote>
                  {handEntered} {pluralize("assignment", handEntered)} include results entered by
                  hand.
                </TrialNote>
              ) : null}
              {readOnly ? null : (
                <DefaultActions
                  environmentId={environmentId}
                  experiment={experiment}
                  setup={setup}
                  tooFew={verdict?.tooFew ?? true}
                  onAdopted={() => {
                    refresh();
                    setup.reloadPolicy();
                  }}
                />
              )}
            </>
          )}
        </TrialRow>
      </SettingsSection>
      <AssignmentsSection
        environmentId={environmentId}
        experiment={experiment}
        total={data?.totalSamples ?? null}
        needs={needs}
        open={assignmentsOpen}
        onOpenChange={setAssignmentsOpen}
        needsOnly={needsOnly}
        onNeedsOnlyChange={setNeedsOnly}
        onRecorded={results.refresh}
      />
    </>
  );
}

function VariantFact({
  environmentId,
  variant,
  index,
}: {
  environmentId: EnvironmentId;
  variant: ExperimentVariant;
  index: number;
}) {
  const details = variant.rollover
    ? describeExperimentTreatment(variant)
    : describeVariantSetup(variant);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span>
          <VariantName label={variant.label} index={index} />
        </span>
        {variant.modelSelection ? (
          <ModelLabel
            variant="chip"
            environmentId={environmentId}
            instanceId={variant.modelSelection.instanceId}
            model={variant.modelSelection.model}
          />
        ) : null}
      </span>
      {details === null ? null : (
        <span className="whitespace-pre-wrap text-muted-foreground">{details}</span>
      )}
    </div>
  );
}

function ChangeChain({ entries }: { entries: ReadonlyArray<AdoptionEntry> }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {entries.map((entry, index) => (
        <span key={`${entry.label}:${entry.effort ?? ""}`} className="flex items-center gap-1">
          {index > 0 ? <span className="text-muted-foreground">→</span> : null}
          <Badge variant="outline">
            {entry.effort === null ? entry.label : `${entry.label} ${entry.effort}`}
          </Badge>
        </span>
      ))}
    </span>
  );
}

function DefaultActions({
  environmentId,
  experiment: listed,
  setup,
  tooFew,
  onAdopted,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  setup: TrialEnvironment;
  tooFew: boolean;
  onAdopted: () => void;
}) {
  const adopt = useAtomCommand(serverEnvironment.experimentsAdopt);
  const canAdopt = useAtomValue(serverEnvironment.experimentsAdopt.permissionAtom(environmentId));
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [adoption, setAdoption] = useState<ExperimentAdoption | null>(null);
  const [failure, setFailure] = useState<TrialFailure | null>(null);
  const [pending, setPending] = useState(false);
  // The list refreshes after adopting; the response already says what happened.
  const experiment = adoption?.experiment ?? listed;
  const changeOf = (variant: ExperimentVariant) =>
    adoptionChange(experiment, variant, {
      manifest: setup.manifest,
      modelName: setup.nameOfSlug,
      roleLabel: (role) => AGENT_ROLE_PRESENTATION[role].label,
    });
  const apply = async (variantId: string) => {
    setPending(true);
    setFailure(null);
    const result = await adopt({
      environmentId,
      input: { experimentId: experiment.id, variantId },
    });
    setPending(false);
    const message = commandFailure("adopt", result);
    if (message !== null) {
      setFailure({ message, retry: () => void apply(variantId) });
      return;
    }
    if (result._tag !== "Success") return;
    setAdoption(result.value);
    setPreviewId(null);
    announce("Default changed.");
    onAdopted();
  };
  const adoptedIndex = experiment.variants.findIndex(
    (variant) => variant.id === experiment.adoptedVariantId,
  );
  const previewIndex = experiment.variants.findIndex((variant) => variant.id === previewId);
  const preview = experiment.variants[previewIndex];
  const change = preview === undefined ? null : changeOf(preview);
  const live = experiment.status === "running" || experiment.status === "paused";
  const options = experiment.variants.flatMap((variant, index) =>
    changeOf(variant) === null ? [] : [{ variant, index }],
  );
  return (
    <>
      {adoptedIndex >= 0 ? (
        <Alert variant="info" size="sm" role="status">
          <AlertDescription>
            <span>
              {VARIANT_LETTERS[adoptedIndex]} is now the default.
              {adoption?.nextStep ? ` ${adoption.nextStep}` : ""}{" "}
              {adoption?.applied === "delegation-setting" ||
              experiment.variants[adoptedIndex]?.modelSelection !== undefined ? (
                <Link to="/settings/delegation" className="underline">
                  Open in Delegation
                </Link>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      <TrialErrorBox failure={failure} onDismiss={() => setFailure(null)} />
      {preview !== undefined && change !== null ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-2.5 text-xs">
          <p className="font-medium">
            Make {VARIANT_LETTERS[previewIndex]} the default:{" "}
            {variantNameBesideLetter(preview.label, previewIndex)}
          </p>
          <TrialNote>
            {change.changesNothing
              ? `Nothing changes in Delegation. This records ${VARIANT_LETTERS[previewIndex]} as the default${live ? " and stops the trial" : ""}. Work already assigned keeps its variant.`
              : change.inDelegation
                ? "This is what changes in Delegation. It applies to new work."
                : "This is what changes. It applies to new work, once you land it."}
          </TrialNote>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">{change.what}</span>
            {change.before !== null && change.after !== null ? (
              <>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="w-11 text-muted-foreground">Now</span>
                  <ChangeChain entries={change.before} />
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="w-11 text-muted-foreground">After</span>
                  <ChangeChain entries={change.after} />
                </span>
              </>
            ) : null}
          </div>
          {change.note === null ? null : <TrialNote>{change.note}</TrialNote>}
          {tooFew ? (
            <p className="text-warning-foreground">
              There are too few results to conclude, so this would be your judgement rather than
              what the trial showed.
            </p>
          ) : null}
          {live && !change.changesNothing ? (
            <TrialNote>
              This also stops the trial. Work already assigned keeps its variant.
            </TrialNote>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" disabled={pending} onClick={() => void apply(preview.id)}>
              Apply
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setPreviewId(null);
                setFailure(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {options.map(({ variant, index }) => (
            <Button
              key={variant.id}
              size="xs"
              variant="outline"
              disabled={!canAdopt}
              onClick={() => setPreviewId(variant.id)}
            >
              Make {VARIANT_LETTERS[index]} the default
            </Button>
          ))}
          <TrialNote>You decide. Nothing changes until you apply it.</TrialNote>
        </div>
      ) : null}
    </>
  );
}

function AssignmentsSection({
  environmentId,
  experiment,
  total,
  needs,
  open,
  onOpenChange,
  needsOnly,
  onNeedsOnlyChange,
  onRecorded,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  total: number | null;
  needs: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  needsOnly: boolean;
  onNeedsOnlyChange: (needsOnly: boolean) => void;
  onRecorded: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const report = useEnvironmentQuery(
    open
      ? serverEnvironment.experimentsReport({
          environmentId,
          input: { experimentId: experiment.id, offset, limit: ASSIGNMENTS_PER_PAGE },
        })
      : null,
  );
  const samples = useEnvironmentQuery(
    open
      ? serverEnvironment.experimentsResults({
          environmentId,
          input: {
            experimentId: experiment.id,
            ...(offset === 0 ? {} : { offset }),
            limit: ASSIGNMENTS_PER_PAGE,
          },
        })
      : null,
  );
  const sampleOf = new Map(samples.data?.samples.map((sample) => [sample.assignmentId, sample]));
  const rows = (report.data?.assignments ?? []).filter((row) => {
    if (!needsOnly) return true;
    const sample = sampleOf.get(row.assignment.id);
    return sample !== undefined && needsAnOutcome(experiment, sample) && row.outcomes.length === 0;
  });
  const summary =
    total === null
      ? ""
      : total === 0
        ? "None yet"
        : `${total} in all${needs > 0 && !isRolloverTrial(experiment) ? ` · ${needs} ${needs === 1 ? "needs" : "need"} an outcome` : ""}`;
  return (
    <SettingsSection title="Evidence">
      <div className="border-t border-border/60 first:border-t-0">
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger className="flex w-full items-start gap-3 px-3 py-3 text-left sm:px-4">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Individual assignments</span>
              <span className="text-xs text-muted-foreground">{summary}</span>
            </span>
            <ChevronRightIcon
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {needs > 0 && !isRolloverTrial(experiment) ? (
              <div className="px-3 pb-2 sm:px-4">
                <ToggleGroup
                  aria-label="Which assignments to show"
                  value={[needsOnly ? "needs" : "all"]}
                  onValueChange={(values) => {
                    if (values[0] !== undefined) onNeedsOnlyChange(values[0] === "needs");
                  }}
                >
                  <Toggle value="all">All</Toggle>
                  <Toggle value="needs">Needs an outcome</Toggle>
                </ToggleGroup>
              </div>
            ) : null}
            {report.error ? (
              <div className="px-3 pb-2 sm:px-4">
                <Alert variant="error" size="sm">
                  <AlertDescription>{report.error}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            {report.data === null && report.isPending ? (
              <TrialRow>
                <TrialNote>Loading assignments…</TrialNote>
              </TrialRow>
            ) : null}
            {report.data !== null && rows.length === 0 ? (
              <TrialRow>
                <TrialNote>Nothing here.</TrialNote>
              </TrialRow>
            ) : null}
            {rows.map((row) => (
              <AssignmentRow
                key={row.assignment.id}
                environmentId={environmentId}
                experiment={experiment}
                row={row}
                sample={sampleOf.get(row.assignment.id) ?? null}
                refresh={() => {
                  report.refresh();
                  samples.refresh();
                  onRecorded();
                }}
              />
            ))}
            {report.data !== null && (report.data.offset > 0 || report.data.hasMore) ? (
              <TrialRow className="flex-row flex-wrap items-center gap-2">
                <TrialNote>
                  Showing {report.data.offset + 1}–
                  {report.data.offset + report.data.assignments.length} of{" "}
                  {report.data.totalAssignments}
                </TrialNote>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={report.data.offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - ASSIGNMENTS_PER_PAGE))}
                >
                  Previous
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!report.data.hasMore}
                  onClick={() => setOffset(offset + ASSIGNMENTS_PER_PAGE)}
                >
                  Next
                </Button>
              </TrialRow>
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </SettingsSection>
  );
}

function sampleWords(sample: ExperimentSampleResult | null): string {
  if (sample === null) return UNKNOWN_RESULT;
  const count = (value: number | null, word: string) =>
    value === null ? [] : [`${value} ${pluralize(word, value)}`];
  const parts = [
    ...count(sample.confirmedBlockers, "confirmed blocker"),
    ...count(sample.falsePositives, "false positive"),
    ...count(sample.problemsAfterLanding, "problem after landing").map((text) =>
      text.replace("problem after landings", "problems after landing"),
    ),
    ...(sample.sentBack === null ? [] : [`sent back ${sample.sentBack}`]),
    ...count(sample.delegatedHelpers, "helper"),
  ];
  return parts.length === 0 ? UNKNOWN_RESULT : parts.join(", ");
}

function AssignmentRow({
  environmentId,
  experiment,
  row,
  sample,
  refresh,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  row: ExperimentAssignmentReport;
  sample: ExperimentSampleResult | null;
  refresh: () => void;
}) {
  const { assignment } = row;
  const canRecord = useAtomValue(
    serverEnvironment.experimentsRecordOutcome.permissionAtom(environmentId),
  );
  const [recording, setRecording] = useState(false);
  const letter = experiment.variants.findIndex((variant) => variant.id === assignment.variant.id);
  const sourceIds = new Set(sample?.sources.map((source) => source.reference));
  const others = row.outcomes.filter((outcome) => !sourceIds.has(outcome.id));
  const words = sampleWords(sample);
  return (
    <TrialRow>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 text-sm">
          {sample?.specId ? `${sample.specId} · ` : ""}
          {assignmentTitle(row)}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {assignment.threadId === null ? null : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: assignment.threadId }}
              className="text-xs underline"
            >
              Open thread
            </Link>
          )}
          {!isRolloverTrial(experiment) && !recording ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canRecord}
              onClick={() => setRecording(true)}
            >
              Record an outcome
            </Button>
          ) : null}
        </span>
      </div>
      <TrialNote>
        <VariantName label={assignment.variant.label} index={letter} /> ·{" "}
        {sample?.landingWindowComplete !== null && sample !== null ? "Landed" : "Not landed yet"} ·{" "}
        {new Date(assignment.assignedAt).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        })}
      </TrialNote>
      <p className="text-xs">
        {words === UNKNOWN_RESULT ? (
          <span className="text-muted-foreground italic">{words}</span>
        ) : (
          words
        )}
      </p>
      {(sample?.sources.length ?? 0) > 0 || others.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {sample?.sources.map((source) => {
            const described = describeResultSource(source, row.outcomes);
            return (
              <li
                key={`${source.measure}:${source.origin}:${source.reference}:${source.findingRef ?? ""}`}
              >
                {described.measure}: {described.origin}
              </li>
            );
          })}
          {others.map((outcome) => {
            const described = describeRecordedOutcome(outcome);
            return (
              <li key={outcome.id}>
                {described.label}: {described.origin}
              </li>
            );
          })}
        </ul>
      ) : null}
      {recording ? (
        <RecordOutcomeForm
          environmentId={environmentId}
          assignmentId={assignment.id}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            refresh();
          }}
        />
      ) : null}
    </TrialRow>
  );
}

function RecordOutcomeForm({
  environmentId,
  assignmentId,
  onClose,
  onSaved,
}: {
  environmentId: EnvironmentId;
  assignmentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const record = useAtomCommand(serverEnvironment.experimentsRecordOutcome);
  const [choice, setChoice] = useState<RecordedOutcomeChoice>("blocker");
  const [where, setWhere] = useState("");
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<TrialFailure | null>(null);
  const [attemptId] = useState(() => randomUUID());
  const info = RECORDED_OUTCOME_CHOICES[choice];
  const save = async () => {
    if (where.trim() === "") {
      setMissing(true);
      return;
    }
    setPending(true);
    setFailure(null);
    const result = await record({
      environmentId,
      input: {
        id: attemptId,
        assignmentId,
        runId: null,
        kind: info.kind,
        source: "human-review",
        note: outcomeNoteFor(choice),
        evidence: [where.trim()],
        actualModelSelection: null,
        fallbackReason: null,
      },
    });
    setPending(false);
    const message = commandFailure("outcome", result);
    if (message !== null) {
      setFailure({ message, retry: () => void save() });
      return;
    }
    if (result._tag !== "Success") return;
    announce("Outcome saved. The totals catch up within a minute.");
    onSaved();
  };
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border/60 p-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col items-start gap-1 text-xs font-medium">
          <span>What happened</span>
          <SettingsChoice
            label="What happened"
            value={choice}
            values={(Object.keys(RECORDED_OUTCOME_CHOICES) as RecordedOutcomeChoice[]).map(
              (value) => ({ value, label: RECORDED_OUTCOME_CHOICES[value].label }),
            )}
            onChange={(value) => setChoice(value as RecordedOutcomeChoice)}
          />
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          Where it shows
          <Input
            size="sm"
            value={where}
            placeholder="A finding, test result or thread"
            onChange={(event) => {
              setWhere(event.target.value);
              setMissing(false);
            }}
          />
        </label>
      </div>
      {info.countsInTotals ? null : (
        <TrialNote>This stays with the assignment. The totals don't count it.</TrialNote>
      )}
      {missing ? (
        <p className="text-xs text-warning-foreground" role="alert">
          Say where this shows, so the result can be checked later.
        </p>
      ) : null}
      <TrialErrorBox failure={failure} onDismiss={() => setFailure(null)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={pending} onClick={() => void save()}>
          Save outcome
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
