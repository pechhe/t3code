import { useAtomValue } from "@effect/atom-react";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Hex from "effect/encoding/Hex";
import {
  ALLOCATION_POLICY_LABELS,
  APPROACH_DESCRIPTIONS,
  currentJobSelection,
  defaultTrialQuestion,
  draftVariantName,
  emptyTrialDraft,
  freshTrialVariants,
  isDiscardedDraft,
  MAX_TRIAL_VARIANTS,
  selectionsMatch,
  trialDraftDefinition,
  trialDraftFromExperiment,
  trialDraftIssues,
  trialDraftLimitHint,
  trialDraftSentence,
  TRIAL_JOBS,
  TRIAL_KINDS,
  trialUnit,
  VARIANT_LETTERS,
  type DraftVariant,
  type TrialDraft,
  type TrialJob,
  type TrialKind,
} from "@t3tools/client-runtime/experiments";
import {
  AgentRole,
  type EnvironmentId,
  type Experiment,
  type ExperimentAllocationPolicy,
  type ModelSelection,
} from "@t3tools/contracts";
import { ChevronLeftIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENT_ROLE_PRESENTATION } from "../AgentRoleChip";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  announce,
  commandFailure,
  IssueLine,
  TrialErrorBox,
  TrialNote,
  TrialRow,
  useTrialEnvironment,
  VariantLetter,
  type TrialEnvironment,
  type TrialFailure,
} from "./ExperimentParts";
import { TrialModelPicker } from "./ExperimentTrialModelPicker";
import { SettingsSection } from "./settingsLayout";
import { SettingsChoice } from "./SettingsChoice";

const hashText = (text: string) => Hex.encode(sha256(new TextEncoder().encode(text)));

const VARIANT_HELP: Readonly<Record<TrialKind, string>> = {
  model: "A starts as what Delegation uses today. Each variant gets its own model and effort.",
  text: "This text is added to the agent's ordinary instructions on Claude and Codex. The trial can't reach other providers, so their work is left out. For example, add: “Ask for a fix with each finding”, “Check the change at phone width” or “Name the test that proves it”.",
  approach:
    "The lead's model stays the same on both sides. This applies to fresh threads linked to a Forge item on Claude and Codex, and the report shows what leads actually delegated.",
};

export function TrialEditor({
  environmentId,
  editing,
  onDone,
  onOpenTrial,
}: {
  environmentId: EnvironmentId;
  editing: Experiment | null;
  onDone: () => void;
  onOpenTrial: (experimentId: string) => void;
}) {
  const setup = useTrialEnvironment(environmentId);
  const list = useEnvironmentQuery(serverEnvironment.experimentsList({ environmentId, input: {} }));
  const create = useAtomCommand(serverEnvironment.experimentsCreate);
  const transition = useAtomCommand(serverEnvironment.experimentsTransition);
  const canCreate = useAtomValue(serverEnvironment.experimentsCreate.permissionAtom(environmentId));
  const canChange = useAtomValue(
    serverEnvironment.experimentsTransition.permissionAtom(environmentId),
  );
  const [draft, setDraft] = useState<TrialDraft>(() =>
    editing === null ? emptyTrialDraft(setup.now) : trialDraftFromExperiment(editing),
  );
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<{
    readonly message: string;
    readonly retry: "save" | "start" | "delete";
  } | null>(null);
  // A failed start leaves a saved draft, so a retry must not create it twice.
  const [saved, setSaved] = useState<{ readonly id: string; readonly key: string } | null>(null);
  const [toDiscard, setToDiscard] = useState<ReadonlyArray<string>>(
    editing === null ? [] : [editing.id],
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const others = (list.data ?? []).filter(
    (trial) => trial.id !== editing?.id && trial.id !== saved?.id && !isDiscardedDraft(trial),
  );
  const context = setup.contextFor(others);
  const issues = trialDraftIssues(draft, context);
  const currentFor = (job: TrialJob) => currentJobSelection(setup.manifest, job, setup.instanceFor);
  const effortsOf = (selection: ModelSelection | null) => {
    if (selection === null) return [];
    const driverKind = setup.entries.find(
      (entry) => entry.instanceId === selection.instanceId,
    )?.driverKind;
    return (
      setup.catalog.find(
        (model) =>
          model.binding.driverKind === driverKind && model.binding.model === selection.model,
      )?.efforts ?? []
    );
  };
  const reset = (next: TrialDraft): TrialDraft => {
    if (next.kind === null) return next;
    const current = next.kind === "model" ? currentFor(next.job) : null;
    return {
      ...next,
      variants: freshTrialVariants(next.kind, current, effortsOf(current)),
      question: next.questionEdited ? next.question : defaultTrialQuestion(next.kind, next.job),
    };
  };
  const setVariant = (index: number, variant: DraftVariant) =>
    setDraft({
      ...draft,
      variants: draft.variants.map((other, at) => (at === index ? variant : other)),
    });
  const addVariant = () => {
    const added: DraftVariant =
      draft.kind === "text"
        ? { type: "text", text: "", sourcePath: "added-text" }
        : { type: "model", selection: null };
    setDraft({ ...draft, variants: [...draft.variants, added] });
  };

  const submit = async (start: boolean) => {
    setPending(true);
    setFailed(null);
    const fail = (message: string) => {
      setFailed({ message, retry: start ? "start" : "save" });
      setPending(false);
    };
    const key = JSON.stringify(draft);
    let current = saved;
    let discard = toDiscard;
    if (current === null || current.key !== key) {
      if (current !== null) discard = [...discard, current.id];
      const id = randomUUID();
      const result = await create({
        environmentId,
        input: trialDraftDefinition(draft, { id, modelName: setup.modelName, hashText }),
      });
      const message = commandFailure("save", result);
      if (message !== null) return fail(message);
      if (result._tag !== "Success") return setPending(false);
      current = { id, key };
      setSaved(current);
      setToDiscard(discard);
    }
    for (const experimentId of discard) {
      const result = await transition({
        environmentId,
        input: { experimentId, status: "stopped" },
      });
      const message = commandFailure("save", result);
      if (message !== null) {
        list.refresh();
        return fail(message);
      }
      discard = discard.filter((id) => id !== experimentId);
      setToDiscard(discard);
    }
    if (start) {
      const result = await transition({
        environmentId,
        input: { experimentId: current.id, status: "running" },
      });
      const message = commandFailure("start-saved", result);
      if (message !== null) {
        list.refresh();
        return fail(message);
      }
    }
    setPending(false);
    announce(start ? "Trial started." : "Draft saved.");
    list.refresh();
    onDone();
  };

  const deleteDraft = async () => {
    if (editing === null) return;
    setPending(true);
    setFailed(null);
    const result = await transition({
      environmentId,
      input: { experimentId: editing.id, status: "stopped" },
    });
    setPending(false);
    setConfirmingDelete(false);
    const message = commandFailure("delete", result);
    if (message !== null) {
      setFailed({ message, retry: "delete" });
      return;
    }
    if (result._tag !== "Success") return;
    announce("Draft deleted.");
    list.refresh();
    onDone();
  };

  // Retrying from this render, not the failed call's, keeps what that call already saved.
  const failure: TrialFailure | null =
    failed === null
      ? null
      : {
          message: failed.message,
          retry: () => {
            if (failed.retry === "delete") void deleteDraft();
            else void submit(failed.retry === "start");
          },
        };
  const kind = draft.kind;
  const unit = trialUnit(draft);
  const hint = trialDraftLimitHint(draft);
  return (
    <>
      <div className="px-3 sm:px-4">
        <Button size="xs" variant="ghost-muted" onClick={onDone}>
          <ChevronLeftIcon />
          Experiments
        </Button>
      </div>
      <SettingsSection title={editing === null ? "New trial" : "Edit draft"}>
        <EditorStep number={1} title="What do you want to compare?">
          <RadioGroup
            aria-label="What do you want to compare?"
            value={kind}
            onValueChange={(value) => {
              const next = value as TrialKind;
              if (next !== kind) setDraft(reset({ ...draft, kind: next }));
            }}
          >
            {(Object.keys(TRIAL_KINDS) as TrialKind[]).map((id) => (
              <div key={id} className="flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-start gap-2">
                  <Radio value={id} />
                  <span className="flex min-w-0 flex-col text-sm">
                    <span className="font-medium">{TRIAL_KINDS[id].name}</span>
                    <span className="text-xs text-muted-foreground">
                      {TRIAL_KINDS[id].description}
                    </span>
                  </span>
                </label>
                {kind === id && id === "model" ? (
                  <ChoiceMore label="Job">
                    <SettingsChoice
                      label="Job"
                      value={draft.job}
                      values={(Object.keys(TRIAL_JOBS) as TrialJob[]).map((job) => ({
                        value: job,
                        label: TRIAL_JOBS[job].name,
                      }))}
                      onChange={(job) => {
                        if (job !== draft.job) {
                          setDraft(reset({ ...draft, job: job as TrialJob }));
                        }
                      }}
                    />
                  </ChoiceMore>
                ) : null}
                {kind === id && id === "text" ? (
                  <ChoiceMore label="Who gets it">
                    <SettingsChoice
                      label="Who gets it"
                      value={draft.textRole ?? "every"}
                      values={[
                        { value: "every", label: "Every agent" },
                        ...AgentRole.literals.map((role) => ({
                          value: role,
                          label: AGENT_ROLE_PRESENTATION[role].label,
                        })),
                      ]}
                      onChange={(role) =>
                        setDraft({
                          ...draft,
                          textRole: role === "every" ? null : (role as AgentRole),
                        })
                      }
                    />
                  </ChoiceMore>
                ) : null}
              </div>
            ))}
          </RadioGroup>
        </EditorStep>
        {kind === null ? null : (
          <>
            <EditorStep number={2} title="Variants">
              <TrialNote>{VARIANT_HELP[kind]}</TrialNote>
              {kind === "model" && TRIAL_JOBS[draft.job].note ? (
                <TrialNote>{TRIAL_JOBS[draft.job].note}</TrialNote>
              ) : null}
              {kind === "model" && setup.manifest === null && !setup.policyPending ? (
                <TrialNote>
                  Delegation's settings can't be read here, so choose A yourself.
                </TrialNote>
              ) : null}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
                {draft.variants.map((variant, index) => (
                  <VariantColumn
                    key={VARIANT_LETTERS[index]}
                    environmentId={environmentId}
                    setup={setup}
                    variant={variant}
                    index={index}
                    current={kind === "model" ? currentFor(draft.job) : null}
                    onChange={(next) => setVariant(index, next)}
                    {...(index >= 2
                      ? {
                          onRemove: () =>
                            setDraft({
                              ...draft,
                              variants: draft.variants.filter((_, at) => at !== index),
                            }),
                        }
                      : {})}
                  >
                    {issues.variants[index]?.map((issue) => (
                      <IssueLine key={issue.text} issue={issue} />
                    ))}
                  </VariantColumn>
                ))}
              </div>
              {kind === "approach" ? (
                <TrialNote>This comparison has only two sides.</TrialNote>
              ) : (
                <div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={draft.variants.length >= MAX_TRIAL_VARIANTS}
                    onClick={addVariant}
                  >
                    <PlusIcon />
                    Add variant
                  </Button>
                </div>
              )}
            </EditorStep>
            <EditorStep number={3} title="Which work">
              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className="p-0 text-xs text-muted-foreground">Projects</legend>
                <div className="flex flex-col">
                  {setup.projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex min-h-7 cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={draft.projectIds.includes(project.id)}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            projectIds: checked
                              ? [...draft.projectIds, project.id]
                              : draft.projectIds.filter((id) => id !== project.id),
                          })
                        }
                      />
                      <span>{project.title}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {issues.work.map((issue) => (
                <IssueLine key={issue.text} issue={issue} onOpenTrial={onOpenTrial} />
              ))}
            </EditorStep>
            <EditorStep number={4} title="Stop when">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <EditorField label={`Limit of ${unit}s`}>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    inputMode="numeric"
                    value={draft.limit}
                    onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
                  />
                </EditorField>
                <EditorField label="End date">
                  <Input
                    type="date"
                    value={draft.endDate}
                    onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
                  />
                </EditorField>
              </div>
              {issues.stop.map((issue) => (
                <IssueLine key={issue.text} issue={issue} />
              ))}
              {hint === null ? null : <TrialNote>{hint}</TrialNote>}
            </EditorStep>
            <EditorStep number={5} title="Summary">
              <div className="flex flex-col gap-1 rounded-lg bg-accent px-2.5 py-2">
                <p className="text-sm">{trialDraftSentence(draft, context)}</p>
                <ul className="text-xs text-muted-foreground">
                  {draft.variants.map((variant, index) => {
                    const name = draftVariantName(variant, index, setup.modelName);
                    const isCurrent =
                      variant.type === "model" &&
                      selectionsMatch(variant.selection, currentFor(draft.job));
                    return (
                      <li key={VARIANT_LETTERS[index]}>
                        <VariantLetter>{VARIANT_LETTERS[index]}</VariantLetter>{" "}
                        {isCurrent ? `Current setup: ${name}` : name}
                      </li>
                    );
                  })}
                </ul>
                <TrialNote>
                  Nothing changes in Delegation for other work. Most results record themselves; a
                  few need someone to record them, and the results page asks for those.
                </TrialNote>
              </div>
              <EditorField label="The question this answers">
                <Textarea
                  rows={3}
                  value={draft.question}
                  onChange={(event) =>
                    setDraft({ ...draft, question: event.target.value, questionEdited: true })
                  }
                />
              </EditorField>
              <TrialErrorBox failure={failure} onDismiss={() => setFailed(null)} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending || !canCreate}
                  onClick={() => void submit(false)}
                >
                  Save draft
                </Button>
                <Button
                  size="xs"
                  disabled={pending || issues.blocked || !canCreate || !canChange}
                  onClick={() => void submit(true)}
                >
                  Start trial
                </Button>
                <Button size="xs" variant="ghost-muted" onClick={onDone}>
                  Cancel
                </Button>
                {editing === null ? null : (
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {confirmingDelete ? (
                      <>
                        <span className="text-xs text-muted-foreground">Delete this draft?</span>
                        <Button size="xs" disabled={pending} onClick={() => void deleteDraft()}>
                          Delete draft
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => setConfirmingDelete(false)}
                        >
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={!canChange}
                        onClick={() => setConfirmingDelete(true)}
                      >
                        Delete draft
                      </Button>
                    )}
                  </span>
                )}
              </div>
            </EditorStep>
          </>
        )}
      </SettingsSection>
    </>
  );
}

function EditorStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <TrialRow className="gap-2.5">
      <h3 className="flex gap-1.5 text-sm font-medium">
        <span className="text-muted-foreground tabular-nums">{number}.</span>
        {title}
      </h3>
      {children}
    </TrialRow>
  );
}

function ChoiceMore({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-6 text-xs text-muted-foreground">
      <span>{label}</span>
      <div className="w-64 max-w-full">{children}</div>
    </div>
  );
}

function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
      {label}
      {children}
    </label>
  );
}

function VariantColumn({
  environmentId,
  setup,
  variant,
  index,
  current,
  onChange,
  onRemove,
  children,
}: {
  environmentId: EnvironmentId;
  setup: TrialEnvironment;
  variant: DraftVariant;
  index: number;
  current: ModelSelection | null;
  onChange: (variant: DraftVariant) => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const isCurrent = variant.type === "model" && selectionsMatch(variant.selection, current);
  const name = isCurrent ? "Current setup" : draftVariantName(variant, index, setup.modelName);
  return (
    <div
      data-variant={VARIANT_LETTERS[index]}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-2"
    >
      <div className="flex min-h-6 items-start justify-between gap-1 text-xs font-medium">
        <span className="min-w-0 pt-1">
          <VariantLetter>{VARIANT_LETTERS[index]}</VariantLetter> {name}
        </span>
        {onRemove ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove variant ${VARIANT_LETTERS[index]}`}
            onClick={onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {variant.type === "model" ? (
        <>
          <TrialModelPicker
            environmentId={environmentId}
            setup={setup}
            selection={variant.selection}
            onChange={(selection) => onChange({ type: "model", selection })}
          />
          {index === 0 && !isCurrent && current !== null ? (
            <div>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => onChange({ type: "model", selection: current })}
              >
                Use current setup
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {variant.type === "text" ? (
        variant.text === null ? (
          <TrialNote>No text added: this agent runs on its ordinary instructions.</TrialNote>
        ) : (
          <>
            <EditorField label="Text to add">
              <Textarea
                rows={4}
                value={variant.text}
                onChange={(event) => onChange({ ...variant, text: event.target.value })}
              />
            </EditorField>
            <EditorField label="Where it would live">
              <Input
                size="sm"
                value={variant.sourcePath}
                onChange={(event) => onChange({ ...variant, sourcePath: event.target.value })}
              />
            </EditorField>
          </>
        )
      ) : null}
      {variant.type === "approach" ? (
        <>
          <ToggleGroup
            aria-label={`Approach for variant ${VARIANT_LETTERS[index]}`}
            value={[variant.policy]}
            onValueChange={(values) => {
              const policy = values[0] as ExperimentAllocationPolicy | undefined;
              if (policy !== undefined) onChange({ type: "approach", policy });
            }}
          >
            {(["inline-first", "delegate-earlier"] as const).map((policy) => (
              <Toggle key={policy} value={policy}>
                {ALLOCATION_POLICY_LABELS[policy]}
              </Toggle>
            ))}
          </ToggleGroup>
          <TrialNote>{APPROACH_DESCRIPTIONS[variant.policy]}</TrialNote>
        </>
      ) : null}
      {children}
    </div>
  );
}
