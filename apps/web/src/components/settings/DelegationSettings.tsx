import { SubagentConservationSettings } from "./SubagentConservationSettings";
import { pooledModels, type PooledModel } from "@t3tools/shared/accountPools";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import {
  AgentPolicyManifest,
  AgentPolicySettingsError,
  type DelegationStance,
  isReviewerRole,
  MODEL_NOTE_MAX_LENGTH,
  modelNote,
  type AgentPolicySettings,
  type AgentRole,
  type EnvironmentId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addEntry,
  catalogModels,
  effortForModel,
  ensureModel,
  isAnyAccountBinding,
  matchesCatalogModel,
  modelLabel,
  pooledDefaultStance,
  pooledModelForBinding,
  pooledNote,
  readOnlyUnenforcedProviders,
  removeEntry,
  replaceEntry,
  reviewerWrapUpToolCalls,
  ROLE_DESCRIPTIONS,
  editableManifest,
  roleGroups,
  setEntryEffort,
  setModelDefaultStance,
  setModelListedOnly,
  modelListedOnly,
  setModelNote,
  modelDefaultStance,
  setModelOptions,
  listedModels,
  offersFast,
  runsFast,
  setModelFast,
  setPreferOtherAuthorProvider,
  setReviewerWrapUpToolCalls,
  roleClassLabel,
  rolePolicy,
  savePolicyToTargets,
  unavailableReason,
  type CatalogModel,
  type Job,
  type PolicySaveAnswer,
  type PolicySaveTarget,
  jobsFor,
  splitJob,
} from "./DelegationSettings.logic";
import { AGENT_ROLE_PRESENTATION, AgentRoleChip } from "../AgentRoleChip";
import ChatMarkdown from "../ChatMarkdown";
import { useClientSettings } from "../../hooks/useSettings";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import { ModelLabel } from "../ModelLabel";
import { cn } from "~/lib/utils";
import { PolicyEffortPicker, PolicyModelPicker } from "./PolicyModelPicker";
import { SettingsChoice as Choice } from "./SettingsChoice";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useAgentPolicies } from "./useAgentPolicies";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const isValid = Schema.is(AgentPolicyManifest);
const isPolicySettingsError = Schema.is(AgentPolicySettingsError);
type Manifest = AgentPolicyManifest;

export function DelegationSettings() {
  const { environments, environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environments.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          Connect an environment to manage delegation.
        </p>
      ) : (
        <ScopedDelegation
          environments={environments}
          representativeId={environment?.environmentId ?? null}
        />
      )}
      {environments
        .filter(({ connection }) => connection.phase === "connected")
        .map(({ environmentId, label }) => (
          <SubagentConservationSettings
            key={environmentId}
            environmentId={environmentId}
            label={label}
          />
        ))}
      <PermissionsSection />
    </SettingsPageContainer>
  );
}

/**
 * One editor for the selected environments. Each keeps its own policy file, so the
 * editor shows one environment's policy and a save writes it to every selected one.
 */
function ScopedDelegation({
  environments,
  representativeId,
}: {
  environments: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
  }>;
  representativeId: EnvironmentId | null;
}) {
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const { policies, reload } = useAgentPolicies(
    connected.map(({ environmentId }) => environmentId),
  );
  const [error, setError] = useState<string | null>(null);
  const label = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ?? "";
  const named = (environmentId: EnvironmentId, message: string) =>
    environments.length > 1 ? `${label(environmentId)}: ${message}` : message;
  const editable = policies.flatMap(({ environmentId, data }) =>
    data ? [{ environmentId, label: label(environmentId), data }] : [],
  );
  const shown = editable.find((policy) => policy.environmentId === representativeId) ?? editable[0];
  const differs =
    shown !== undefined &&
    editable.some(
      (policy) =>
        JSON.stringify(policy.data.snapshot.manifest) !==
        JSON.stringify(shown.data.snapshot.manifest),
    );
  const liveConfig = useAtomValue(
    serverEnvironment.configValueAtom(shown?.environmentId ?? representativeId),
  );
  const notices = [
    ...environments
      .filter(({ connection }) => connection.phase !== "connected")
      .map(({ environmentId }) =>
        named(environmentId, "Reconnect this environment to edit its delegation policy."),
      ),
    ...policies.flatMap(({ environmentId, canEdit, data, error: readError, isPending }) =>
      !canEdit
        ? [named(environmentId, "Owner settings permission is required to manage delegation.")]
        : isPending && !data && !readError
          ? [named(environmentId, "Loading policy…")]
          : [],
    ),
  ];
  return (
    <>
      {[
        ...(error ? [error] : []),
        ...policies.flatMap((policy) =>
          policy.error ? [named(policy.environmentId, policy.error)] : [],
        ),
      ].map((message) => (
        <Alert key={message} variant="error">
          <AlertDescription role="alert">{message}</AlertDescription>
        </Alert>
      ))}
      {notices.map((notice) => (
        <p key={notice} className="px-4 text-sm text-muted-foreground">
          {notice}
        </p>
      ))}
      {policies
        .filter((policy) => policy.error && !policy.data)
        .map(({ environmentId }) => (
          // Without a readable policy the checkout is unreadable too: say so, never "up to date".
          <p key={environmentId} className="px-4 text-xs text-muted-foreground">
            {named(
              environmentId,
              describeCheckout({ revision: null, hasLocalChanges: null, behindMain: null }),
            )}
          </p>
        ))}
      {differs ? (
        <Alert variant="info">
          <AlertDescription>
            Policies differ across {editable.map((policy) => policy.label).join(", ")}. This shows{" "}
            {shown.label}&apos;s; a change applies it to all of them.
          </AlertDescription>
        </Alert>
      ) : null}
      {shown ? (
        <PolicyEditor
          // Keyed by environment, not revision, so a save keeps open jobs, focus and scroll.
          key={shown.environmentId}
          environmentId={shown.environmentId}
          // A save to "all" must reach all: an unreadable environment would silently keep its old policy.
          unsavedEnvironments={environments.length - editable.length}
          targets={editable.map((policy) => ({
            environmentId: policy.environmentId,
            label: policy.label,
            hash: policy.data.snapshot.hash,
          }))}
          data={{ ...shown.data, providers: liveConfig?.providers ?? shown.data.providers }}
          onReload={reload}
          onSaved={() => {
            setError(null);
            reload();
          }}
          onError={(message) => {
            setError(message);
            reload();
          }}
          onDiscard={() => setError(null)}
        />
      ) : null}
    </>
  );
}

function PolicyEditor({
  environmentId,
  targets,
  unsavedEnvironments,
  data,
  onReload,
  onSaved,
  onError,
  onDiscard,
}: {
  environmentId: EnvironmentId;
  targets: ReadonlyArray<{ environmentId: EnvironmentId; label: string; hash: string }>;
  unsavedEnvironments: number;
  data: AgentPolicySettings;
  onReload: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
  onDiscard: () => void;
}) {
  const saved = data.snapshot.manifest;
  const modelAccounts = useScopedSettings((settings) => settings.modelAccounts);
  const modelLinks = useScopedSettings((settings) => settings.modelLinks);
  const pooledModelKeys = useScopedSettings((settings) => settings.pooledModelKeys ?? []);
  const providerModelPreferences = useScopedSettings(
    (settings) => settings.providerModelPreferences,
  );
  const routing = { pooledModelKeys, modelAccounts, modelLinks, providerModelPreferences };
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const pools = withPooledModelLabels(pooledModels(data.providers, routing), slotLabels);
  const catalog = catalogModels(data.providers, routing);
  const [draft, setDraft] = useState<Manifest>(() => editableManifest(saved, catalog, pools));
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState(false);
  const [hasEdits, setHasEdits] = useState(false);
  const [draftHashes, setDraftHashes] = useState(
    () => new Map(targets.map((target) => [target.environmentId, target.hash])),
  );
  // A policy read after a reload or another device's save replaces the draft once nothing is
  // saving; the read that follows this page's own save already matches it.
  const [shownPolicy, setShownPolicy] = useState(saved);
  if (shownPolicy !== saved) {
    setShownPolicy(saved);
    if (!pending && !refused && !hasEdits) {
      setDraft(editableManifest(saved, catalog, pools));
      setDraftHashes(new Map(targets.map((target) => [target.environmentId, target.hash])));
    }
  }
  // Edits made while a save runs queue behind it; each save builds on the revision the last one
  // wrote, unless the policy has since changed elsewhere.
  const queue = useRef<{
    next: Manifest | null;
    latest: Manifest | null;
    running: boolean;
    hashes: Map<EnvironmentId, string>;
  }>({
    next: null,
    latest: null,
    running: false,
    hashes: new Map(draftHashes),
  });
  const save = useAtomCommand(serverEnvironment.agentPolicySave);
  const readPolicy = useAtomQueryRunner(serverEnvironment.agentPolicyRead, {
    refresh: true,
    reportFailure: false,
  });
  // Set when a save reached the file but not the shared checkout's remote.
  const [publishNotice, setPublishNotice] = useState<string | null>(null);
  const jobs = jobsFor(draft, roleGroups(draft));
  const blocked = !isValid(draft) || unsavedEnvironments > 0;
  const saveTo = async (
    target: PolicySaveTarget,
    expectedHash: string,
    manifest: Manifest,
  ): Promise<PolicySaveAnswer> => {
    const result = await save({
      environmentId: target.environmentId,
      input: {
        expectedHash,
        manifest,
        ...(target.environmentId === environmentId ? {} : { validateCatalog: false }),
      },
    });
    if (result._tag === "Success") return { ok: true, settings: result.value };
    const error = squashAtomCommandFailure(result);
    return {
      ok: false,
      message: String(error),
      stale:
        isPolicySettingsError(error) && error.reason === "stale" && error.attention === undefined,
    };
  };
  const readFrom = async (target: PolicySaveTarget) => {
    const result = await readPolicy({ environmentId: target.environmentId, input: {} });
    return result._tag === "Success" ? result.value : null;
  };
  const flush = async () => {
    const state = queue.current;
    if (state.running) return;
    state.running = true;
    setPending(true);
    setPublishNotice(null);
    const failures: string[] = [];
    const notPushed: string[] = [];
    let written: Manifest | null = null;
    for (
      let manifest = state.next;
      manifest !== null && failures.length === 0;
      manifest = state.next
    ) {
      state.next = null;
      // Each target saves against the hash the draft was built from or its own last write left,
      // never a newer read's, which could authorize a draft built from older content.
      const outcome = await savePolicyToTargets({
        manifest,
        targets: [
          ...targets.filter((target) => target.environmentId === environmentId),
          ...targets.filter((target) => target.environmentId !== environmentId),
        ],
        hashes: state.hashes,
        save: saveTo,
        read: readFrom,
      });
      setDraftHashes(new Map(state.hashes));
      notPushed.push(...outcome.notPushed);
      if (outcome.failure !== null) failures.push(outcome.failure);
      else written = manifest;
    }
    state.next = null;
    state.running = false;
    setPending(false);
    if (failures.length > 0) {
      setRefused(true);
      onError(failures.join("; "));
      return;
    }
    if (notPushed.length > 0)
      setPublishNotice(`Saved, but not pushed to agent-config: ${notPushed.join("; ")}.`);
    setHasEdits(state.latest !== written);
    onSaved();
  };
  const change = (next: Manifest) => {
    setDraft(next);
    setHasEdits(true);
    queue.current.latest = next;
    if (refused || !isValid(next) || unsavedEnvironments > 0) return;
    if (!queue.current.running) queue.current.hashes = new Map(draftHashes);
    queue.current.next = next;
    void flush();
  };
  const unenforced = readOnlyUnenforcedProviders(data.providers);
  return (
    <>
      {unenforced.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {unenforced.join(", ")} cannot keep a reader read-only, so their models serve only writer
          jobs; a reader job skips them.
        </p>
      ) : null}
      {refused ? (
        <Alert variant="warning">
          <AlertDescription>
            Your change was not saved. It is still shown here: note what you changed, then Discard
            to load the current policy and make it again.
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                onDiscard();
                setRefused(false);
                setHasEdits(false);
                setDraft(editableManifest(saved, catalog, pools));
                setDraftHashes(
                  new Map(targets.map((target) => [target.environmentId, target.hash])),
                );
              }}
            >
              Discard
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {publishNotice ? (
        <Alert variant="warning">
          <AlertDescription role="status">{publishNotice}</AlertDescription>
        </Alert>
      ) : null}
      <ModelsSection
        environmentId={environmentId}
        manifest={draft}
        jobs={jobs}
        providers={data.providers}
        pools={pools}
        onChange={change}
      />
      <SettingsSection
        id="delegation"
        title="Jobs"
        headerAction={
          <Button size="xs" variant="ghost-muted" disabled={pending} onClick={onReload}>
            Reload
          </Button>
        }
      >
        {jobs.map((job) => (
          <JobRow
            key={job.roles.join("+")}
            environmentId={environmentId}
            job={job}
            manifest={draft}
            briefs={data.snapshot.briefs}
            rolesDir={`${data.sourceRoot}/roles`}
            providers={data.providers}
            pools={pools}
            catalog={catalog}
            onChange={change}
          />
        ))}
      </SettingsSection>
      {blocked &&
      JSON.stringify(draft) !== JSON.stringify(editableManifest(saved, catalog, pools)) ? (
        <Alert variant="info">
          <AlertDescription>
            {!isValid(draft)
              ? "Every list needs at least one model. Changes save once each has one."
              : "Every selected environment needs a readable policy before changes save. Choose one environment to save to it alone."}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setHasEdits(false);
                setDraft(editableManifest(saved, catalog, pools));
                setDraftHashes(
                  new Map(targets.map((target) => [target.environmentId, target.hash])),
                );
              }}
            >
              Discard
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <p className="px-4 text-xs text-muted-foreground">
        {data.sourceRoot}/roles/policy.json · policy {data.snapshot.sourceRevision}
        {data.checkout === undefined ? null : ` · ${describeCheckout(data.checkout)}`}
        {pending ? " · Saving…" : null}
      </p>
    </>
  );
}

/** The installed agent-config revision, its unlanded state and how far it trails main. */
function describeCheckout(checkout: NonNullable<AgentPolicySettings["checkout"]>) {
  const revision =
    checkout.revision === null
      ? "agent-config unknown"
      : `agent-config ${checkout.revision.slice(0, 12)}`;
  const local =
    checkout.hasLocalChanges === null
      ? "unlanded changes unknown"
      : checkout.hasLocalChanges
        ? "unlanded changes"
        : "no unlanded changes";
  const behind =
    checkout.behindMain === null
      ? "behind main unknown"
      : checkout.behindMain === 0
        ? "up to date with main"
        : `${checkout.behindMain} behind main`;
  return [revision, local, behind].join(" · ");
}

/** A role's chip; hovering it shows the brief the role's helpers start from. */
function RoleBriefChip({
  role,
  brief,
  rolesDir,
}: {
  role: AgentRole;
  brief: string | undefined;
  rolesDir: string;
}) {
  if (brief === undefined) return <AgentRoleChip role={role} />;
  return (
    <PreviewCard>
      <PreviewCardTrigger delay={350} closeDelay={120} render={<AgentRoleChip role={role} />} />
      <PreviewCardPopup align="start" className="w-[40rem] max-w-[calc(100vw-2rem)]">
        <div className="max-h-[min(36rem,70vh)] overflow-y-auto px-4 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Brief every {AGENT_ROLE_PRESENTATION[role].label.toLowerCase()} starts from
          </p>
          <ChatMarkdown text={brief} cwd={rolesDir} className="text-sm" />
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

/** A role's model candidates, how to edit them and a way to add another. */
function ListEditor({
  environmentId,
  list,
  manifest,
  providers,
  pools,
  catalog,
  onChange,
  children,
}: {
  environmentId: EnvironmentId;
  list: string;
  manifest: Manifest;
  providers: ReadonlyArray<ServerProvider>;
  pools: ReadonlyArray<PooledModel>;
  catalog: ReadonlyArray<CatalogModel>;
  onChange: (manifest: Manifest) => void;
  children?: ReactNode;
}) {
  const label = (alias: string) => modelLabel(manifest.models[alias], alias, providers, pools);
  const entries = [...(manifest.lists[list] ?? [])].sort((a, b) =>
    label(a.model).localeCompare(label(b.model)),
  );
  const listed = (model: CatalogModel) =>
    entries.some((entry) => {
      const binding = manifest.models[entry.model];
      return binding !== undefined && matchesCatalogModel(binding, model, pools);
    })
      ? "Already in this job"
      : null;
  const add = (model: CatalogModel) => {
    const [next, alias] = ensureModel(manifest, model, pools);
    const effort = effortForModel(model);
    onChange(
      addEntry(next, list, {
        model: alias,
        ...(effort === undefined ? {} : { effort }),
      }),
    );
  };
  return (
    <>
      <ol className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60">
        {entries.map((entry) => {
          const binding = manifest.models[entry.model];
          const reason = unavailableReason(binding, providers, { pools });
          return (
            <li key={entry.model} className="flex min-w-0 items-center gap-1.5 px-2 py-1">
              <PolicyModelPicker
                environmentId={environmentId}
                catalog={catalog}
                binding={binding}
                pickDisabledReason={listed}
                onPick={(model) =>
                  onChange(
                    replaceEntry(
                      manifest,
                      list,
                      entry.model,
                      model,
                      effortForModel(model, entry.effort),
                      pools,
                    ),
                  )
                }
              />
              <PolicyEffortPicker
                environmentId={environmentId}
                binding={binding}
                effort={entry.effort}
                onChange={(effort) => onChange(setEntryEffort(manifest, list, entry.model, effort))}
                onModelOptionsChange={(options) =>
                  onChange(setModelOptions(manifest, entry.model, options))
                }
              />
              {offersFast(binding, providers) ? (
                <label className="flex shrink-0 cursor-default items-center gap-1.5 text-xs">
                  <Tooltip>
                    <TooltipTrigger render={<span />}>
                      <Switch
                        checked={runsFast(binding)}
                        onCheckedChange={(fast) =>
                          onChange(setModelFast(manifest, entry.model, fast))
                        }
                      />
                    </TooltipTrigger>
                    <TooltipPopup>
                      Runs this model on the fast service tier in every job that lists it
                    </TooltipPopup>
                  </Tooltip>
                  Fast
                </label>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-xs text-warning">{reason}</span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${label(entry.model)}`}
                onClick={() => onChange(removeEntry(manifest, list, entry.model))}
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-1.5">
        <PolicyModelPicker
          environmentId={environmentId}
          catalog={catalog}
          binding={undefined}
          pickDisabledReason={listed}
          trigger={
            <Button size="xs" variant="outline">
              <PlusIcon />
              Add model
            </Button>
          }
          onPick={add}
        />
        {children}
      </div>
    </>
  );
}

function JobRow({
  environmentId,
  job,
  manifest,
  briefs,
  rolesDir,
  providers,
  pools,
  catalog,
  onChange,
}: {
  environmentId: EnvironmentId;
  job: Job;
  manifest: Manifest;
  briefs: AgentPolicySettings["snapshot"]["briefs"];
  rolesDir: string;
  providers: ReadonlyArray<ServerProvider>;
  pools: ReadonlyArray<PooledModel>;
  catalog: ReadonlyArray<CatalogModel>;
  onChange: (manifest: Manifest) => void;
}) {
  const primary = job.sections[0]!;
  const isReviewer = job.roles.includes("reviewer");
  const chip = (alias: string) => {
    const binding = manifest.models[alias];
    return binding ? (
      <PolicyModelLabel
        variant="chip"
        environmentId={environmentId}
        binding={binding}
        pools={pools}
      />
    ) : (
      <Badge variant="outline">{alias}</Badge>
    );
  };
  const labelFor = (alias: string) => modelLabel(manifest.models[alias], alias, providers, pools);
  const configured = manifest.lists[primary.list] ?? [];
  const entries = isReviewer
    ? configured
    : [...configured].sort((a, b) => labelFor(a.model).localeCompare(labelFor(b.model)));
  const actions = (
    <>
      {job.splitGroups.length > 0 ? (
        <Button size="xs" variant="ghost-muted" onClick={() => onChange(splitJob(manifest, job))}>
          Split into separate jobs
        </Button>
      ) : null}
    </>
  );
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <Collapsible>
        <CollapsibleTrigger className="group/job flex w-full items-start gap-3 px-3 py-3 text-left sm:px-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {job.roles.map((role) => (
                <span key={role} className="flex items-center gap-1">
                  <RoleBriefChip role={role} brief={briefs[role]?.text} rolesDir={rolesDir} />
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {job.roles
                .map(
                  (role) =>
                    `${roleClassLabel(rolePolicy(manifest, role))}: ${ROLE_DESCRIPTIONS[role]}`,
                )
                .join(" · ")}
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {entries.map((entry) => {
                const reason = unavailableReason(manifest.models[entry.model], providers, {
                  pools,
                });
                return (
                  <span
                    key={entry.model}
                    className={cn("min-w-0", reason !== null && "line-through")}
                  >
                    {chip(entry.model)}
                  </span>
                );
              })}
            </div>
          </div>
          <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/job:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 px-3 pb-4 sm:px-4">
            {isReviewer ? (
              <p className="text-xs text-muted-foreground">
                The lead picks one independent reviewer for each review, change, Spec or pre-mortem,
                from these models by their notes.
              </p>
            ) : null}
            {primary.hint ? <p className="text-xs text-muted-foreground">{primary.hint}</p> : null}
            <ListEditor
              environmentId={environmentId}
              list={primary.list}
              manifest={manifest}
              providers={providers}
              pools={pools}
              catalog={catalog}
              onChange={onChange}
            >
              {actions}
            </ListEditor>
            {job.roles.filter(isReviewerRole).map((role) => (
              <label key={role} className="flex items-center gap-2 text-xs">
                <Switch
                  checked={manifest.roles[role].preferOtherAuthorProvider === true}
                  onCheckedChange={(value) =>
                    onChange(setPreferOtherAuthorProvider(manifest, role, value))
                  }
                />
                {job.roles.length > 1 ? `${AGENT_ROLE_PRESENTATION[role].label}: ` : ""}Prefer a
                different provider from the author.
              </label>
            ))}
            {isReviewer ? (
              <ReviewerWrapUpField
                value={reviewerWrapUpToolCalls(manifest)}
                onSave={(calls) => onChange(setReviewerWrapUpToolCalls(manifest, calls))}
              />
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** Tool call count before T3 asks a still-reading reviewer to write its report. */
function ReviewerWrapUpField({
  value,
  onSave,
}: {
  value: number;
  onSave: (calls: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value);
  }
  const inputId = useId();
  const commit = (next: number | null) => {
    const rounded = next === null ? null : Math.round(next);
    if (rounded === null || !Number.isFinite(rounded) || rounded < 1) {
      setDraft(value);
      return;
    }
    setDraft(rounded);
    if (rounded !== value) onSave(rounded);
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={inputId} className="font-medium text-foreground">
          Ask for the report after
        </label>
        <NumberField
          value={draft}
          min={1}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={(next) => setDraft(next)}
          onValueCommitted={(next) => commit(next)}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label="Fewer tool calls before wrap-up" />
            <NumberFieldInput
              id={inputId}
              aria-label="Ask for the report after tool calls"
              size={4}
              className="w-12 text-center"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <NumberFieldIncrement aria-label="More tool calls before wrap-up" />
          </NumberFieldGroup>
        </NumberField>
        <span className="text-muted-foreground">tool calls</span>
      </div>
      <p className="text-xs text-muted-foreground">
        A reviewer still reading at this point is told to write its report now with what it has,
        marking what it did not trace as suspected. If it keeps reading for half as many again, T3
        interrupts it and restarts its turn, telling it to write the report without reading further.
      </p>
    </div>
  );
}

/** Each listed model once, with the note a delegating agent reads to choose it. */
function ModelsSection({
  environmentId,
  manifest,
  jobs,
  providers,
  pools,
  onChange,
}: {
  environmentId: EnvironmentId;
  manifest: Manifest;
  jobs: ReadonlyArray<Job>;
  providers: ReadonlyArray<ServerProvider>;
  pools: ReadonlyArray<PooledModel>;
  onChange: (manifest: Manifest) => void;
}) {
  return (
    <SettingsSection id="delegation-models" title="Models">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        One note and one default stance per model. Agents read the note when choosing a model. A new
        thread starts on its model&apos;s default stance, or Implement when it has none. When every
        model on a job&apos;s list is unavailable, an agent may fall back to another model, never to
        one marked Never off-list.
      </p>
      {listedModels(manifest, jobs, pools).map(({ alias, model, pooledModel, roles }) => {
        const binding = manifest.models[alias]!;
        const showPooled = pooledModel !== undefined && isAnyAccountBinding(binding);
        const name = showPooled
          ? pooledModel.displayName
          : modelLabel(binding, alias, providers, pools);
        const defaultStance =
          (pooledModel === undefined
            ? modelDefaultStance(manifest, model)
            : (pooledDefaultStance(manifest, pooledModel.key, pools) ??
              modelDefaultStance(manifest, binding.model))) ?? "unset";
        const note =
          (pooledModel === undefined
            ? modelNote(manifest, model)
            : (pooledNote(manifest, pooledModel.key, pools) ??
              modelNote(manifest, binding.model))) ?? "";
        return (
          <div
            key={model}
            className="grid grid-cols-1 items-start gap-x-4 gap-y-1.5 border-t border-border/60 px-3 py-2.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:px-4"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <ModelLabel
                environmentId={environmentId}
                driverKind={binding.driverKind}
                model={binding.model}
                name={showPooled ? pooledModel.displayName : undefined}
                hideSource={showPooled}
                className="text-sm"
              />
              <div className="flex flex-wrap gap-1">
                {roles.map((role) => (
                  <AgentRoleChip key={role} role={role} />
                ))}
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-start gap-2 sm:flex-nowrap">
              <div className="min-w-0 flex-1">
                <NoteField
                  name={name}
                  note={note}
                  onSave={(nextNote) => onChange(setModelNote(manifest, model, nextNote, pools))}
                />
              </div>
              <div className="shrink-0">
                <Choice
                  label={`Default stance for ${name}`}
                  value={defaultStance}
                  values={[
                    { value: "unset", label: "No default (Implement)" },
                    { value: "orchestrate", label: "Orchestrate" },
                    { value: "implement", label: "Implement" },
                  ]}
                  onChange={(value) =>
                    onChange(
                      setModelDefaultStance(
                        manifest,
                        model,
                        value === "unset" ? undefined : (value as DelegationStance),
                        pools,
                      ),
                    )
                  }
                />
              </div>
              <div className="shrink-0">
                <Choice
                  label={`Off-list use of ${name}`}
                  value={modelListedOnly(manifest, model, pools) ? "never" : "fallback"}
                  values={[
                    { value: "fallback", label: "Off-list fallback" },
                    { value: "never", label: "Never off-list" },
                  ]}
                  onChange={(value) =>
                    onChange(setModelListedOnly(manifest, model, value === "never", pools))
                  }
                />
              </div>
            </div>
          </div>
        );
      })}
    </SettingsSection>
  );
}

const NOTE_SAVE_DELAY_MS = 700;

/** A one-line note that saves shortly after typing stops, and at once on Enter or leaving it. */
function NoteField({
  name,
  note,
  onSave,
}: {
  name: string;
  note: string;
  onSave: (note: string) => void;
}) {
  const [value, setValue] = useState(note);
  const [focused, setFocused] = useState(false);
  // A note saved elsewhere replaces this one unless it has unsaved typing.
  const [shownNote, setShownNote] = useState(note);
  if (shownNote !== note) {
    setShownNote(note);
    if (value.trim() === shownNote) setValue(note);
  }
  // Text past the limit stays in the field so nothing is lost to a silent cut, and is not saved.
  const tooLong = value.trim().length > MODEL_NOTE_MAX_LENGTH;
  const messageId = useId();
  const unsaved = !tooLong && value.trim() !== note;
  const save = useEffectEvent((text: string) => onSave(text));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounces the save with a timer, so typing is not a policy write per key.
  useEffect(() => {
    if (!unsaved) return;
    const timer = setTimeout(() => save(value), NOTE_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [unsaved, value]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Textarea
        size="sm"
        rows={1}
        value={value}
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? messageId : undefined}
        aria-label={`What ${name} is good at`}
        placeholder="What is it good at? e.g. Cheap and fast; bounded code"
        onFocus={() => setFocused(true)}
        onChange={(event) => setValue(event.target.value.replace(/\n/g, " "))}
        onBlur={() => {
          setFocused(false);
          if (unsaved) onSave(value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
      />
      {focused || tooLong ? (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span id={messageId} className="text-destructive">
            {tooLong
              ? `Notes can be up to ${MODEL_NOTE_MAX_LENGTH} characters, so this one is not saved.`
              : null}
          </span>
          <span
            className={cn(
              "shrink-0 text-2xs tabular-nums",
              tooLong ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {value.trim().length}/{MODEL_NOTE_MAX_LENGTH}
          </span>
        </div>
      ) : null}
      {note === "" && !unsaved && !tooLong ? (
        <span className="text-xs text-warning-foreground">
          Add a note to help agents judge when to use {name}.
        </span>
      ) : null}
    </div>
  );
}

const IDLE_CLOSE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "off", label: "Never" },
  { value: "30", label: "After 30 minutes" },
  { value: "120", label: "After 2 hours" },
  { value: "1440", label: "After 1 day" },
];

/** Runtime behaviour lives in each server's settings, separately from the policy file. */
function PermissionsSection() {
  const delegation = useScopedSettings((settings) => settings.delegation);
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<typeof delegation>) =>
    updateSettings({ delegation: { ...delegation, ...patch } });
  const idle = delegation.advisorIdleCloseMinutes;
  const idleChoices = IDLE_CLOSE_CHOICES.some((choice) => choice.value === String(idle))
    ? IDLE_CLOSE_CHOICES
    : [...IDLE_CLOSE_CHOICES, { value: String(idle), label: `After ${idle} minutes` }];
  return (
    <SettingsSection title="Permissions and cleanup">
      <SettingsRow
        serverScoped
        settingKeys={["delegation"]}
        {...searchableSetting("delegation-child-permissions")}
        description="Never more than the agent that started them. A change applies to new helpers."
        control={
          <Choice
            label="Helper permissions"
            value={delegation.defaultChildRuntimeMode}
            values={[
              { value: "inherit", label: "Same as caller" },
              { value: "approval-required", label: "Supervised" },
              { value: "auto-accept-edits", label: "Auto-accept edits" },
              { value: "auto", label: "Auto" },
              { value: "full-access", label: "Full access" },
            ]}
            onChange={(mode) =>
              update({ defaultChildRuntimeMode: mode as RuntimeMode | "inherit" })
            }
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["delegation"]}
        {...searchableSetting("delegation-trusted-claude-writers")}
        description="With Full access, Claude helpers can edit, run commands and use the network outside their workspace. Off, they only read. Helpers on other providers run with host access either way."
        control={
          <Switch
            aria-label="Let Claude helpers write with full access"
            checked={delegation.allowTrustedClaudeWriters}
            onCheckedChange={(allowTrustedClaudeWriters) => update({ allowTrustedClaudeWriters })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["delegation"]}
        {...searchableSetting("delegation-advisor-idle-close")}
        description="Closes advisors whose result was delivered. Closed advisors stay readable in Earlier."
        control={
          <Choice
            label="Close idle advisors"
            value={idle === null ? "off" : String(idle)}
            values={idleChoices}
            onChange={(value) =>
              update({ advisorIdleCloseMinutes: value === "off" ? null : Number(value) })
            }
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["delegation"]}
        {...searchableSetting("delegation-model-shadow")}
        description="Records which model the Decisions provider would pick for each delegated role task, beside the one the agent chose. It never changes which model runs. Sends the task's text to the Decisions provider."
        control={
          <Switch
            aria-label="Record the Decisions provider's model pick"
            checked={delegation.modelShadow}
            onCheckedChange={(modelShadow) => update({ modelShadow })}
          />
        }
      />
    </SettingsSection>
  );
}

/** A delegation model's label: a pooled `anyAccount` (or legacy `poolId`) model by its name, else the model. */
function PolicyModelLabel({
  environmentId,
  binding,
  pools,
  variant,
}: {
  environmentId: EnvironmentId;
  binding: Manifest["models"][string];
  pools: ReadonlyArray<PooledModel>;
  variant?: "full" | "chip";
}) {
  const pooled = isAnyAccountBinding(binding) ? pooledModelForBinding(binding, pools) : undefined;
  return (
    <ModelLabel
      variant={variant ?? "full"}
      environmentId={environmentId}
      driverKind={binding.driverKind}
      model={binding.model}
      name={pooled?.displayName}
      hideSource={pooled !== undefined}
    />
  );
}
