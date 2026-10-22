import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import {
  AgentPolicyManifest,
  isReviewerRole,
  type AgentPolicySettings,
  type AgentRole,
  type EnvironmentId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addEntry,
  catalogModels,
  effortForModel,
  ensureModel,
  listModel,
  modelLabel,
  moveEntry,
  removeEntry,
  replaceEntry,
  ROLE_DESCRIPTIONS,
  roleGroups,
  setCaller,
  setEntryEffort,
  setLarge,
  offersFast,
  runsFast,
  setModelFast,
  setPreferOtherAuthorProvider,
  splitGroup,
  isUiOnly,
  rolePolicy,
  type RolePolicy,
  unavailableReason,
  type CatalogModel,
  type RoleGroup,
} from "./DelegationSettings.logic";
import { AGENT_ROLE_PRESENTATION, AgentRoleChip } from "../AgentRoleChip";
import ChatMarkdown from "../ChatMarkdown";
import { ModelLabel } from "../ModelLabel";
import { cn } from "~/lib/utils";
import { PolicyEffortPicker, PolicyModelPicker } from "./PolicyModelPicker";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useAgentPolicies } from "./useAgentPolicies";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const isValid = Schema.is(AgentPolicyManifest);
type Manifest = AgentPolicyManifest;

function Choice({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{values.find((item) => item.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {values.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

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
            {shown.label}&apos;s; saving applies it to all of them.
          </AlertDescription>
        </Alert>
      ) : null}
      {shown ? (
        <PolicyEditor
          key={shown.data.snapshot.hash}
          environmentId={shown.environmentId}
          // A save to "all" must reach all: an unreadable environment would silently keep its old policy.
          unsavedEnvironments={connected.length - editable.length}
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
}: {
  environmentId: EnvironmentId;
  targets: ReadonlyArray<{ environmentId: EnvironmentId; label: string; hash: string }>;
  unsavedEnvironments: number;
  data: AgentPolicySettings;
  onReload: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const saved = data.snapshot.manifest;
  const [draft, setDraft] = useState<Manifest>(saved);
  const [pending, setPending] = useState(false);
  const save = useAtomCommand(serverEnvironment.agentPolicySave);
  const catalog = catalogModels(data.providers);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const groups = roleGroups(draft);
  const submit = async () => {
    setPending(true);
    const failures: string[] = [];
    for (const target of targets) {
      const result = await save({
        environmentId: target.environmentId,
        input: { expectedHash: target.hash, manifest: draft },
      });
      if (result._tag !== "Success") {
        const message = String(squashAtomCommandFailure(result));
        failures.push(targets.length > 1 ? `${target.label}: ${message}` : message);
      }
    }
    setPending(false);
    if (failures.length === 0) onSaved();
    else onError(failures.join("; "));
  };
  return (
    <>
      {groups.map((group) => (
        <FallbackAlert key={group.list} group={group} manifest={draft} providers={data.providers} />
      ))}
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Any installed model can serve a job. Only Codex and Claude enforce a reader&apos;s read-only
        source access, so another provider&apos;s model runs with its account&apos;s own
        permissions.
      </p>
      <SettingsSection
        id="delegation"
        title="Jobs"
        headerAction={
          <Button size="xs" variant="ghost-muted" disabled={pending} onClick={onReload}>
            Reload
          </Button>
        }
      >
        {groups.map((group) => (
          <JobRow
            key={group.list}
            environmentId={environmentId}
            group={group}
            manifest={draft}
            briefs={data.snapshot.briefs}
            rolesDir={`${data.sourceRoot}/roles`}
            providers={data.providers}
            catalog={catalog}
            disabled={pending}
            onChange={setDraft}
          />
        ))}
      </SettingsSection>
      {dirty ? (
        <Alert variant="info">
          <AlertDescription>
            {!isValid(draft)
              ? "Every job needs at least one model before saving."
              : unsavedEnvironments > 0
                ? "Every selected environment needs a readable policy before saving. Choose one environment to save to it alone."
                : "Unsaved changes apply to new tasks once saved."}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pending}
              onClick={() => setDraft(saved)}
            >
              Discard
            </Button>
            <Button
              size="xs"
              disabled={pending || !isValid(draft) || unsavedEnvironments > 0}
              onClick={() => void submit()}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <p className="px-4 text-xs text-muted-foreground">
        {data.sourceRoot}/roles/policy.json · policy {data.snapshot.sourceRevision}
        {data.checkout === undefined ? null : ` · ${describeCheckout(data.checkout)}`}
      </p>
    </>
  );
}

/** The installed agent-config revision, its unlanded state and how far it trails main. */
export function describeCheckout(checkout: NonNullable<AgentPolicySettings["checkout"]>) {
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

/** Names a job whose first choice cannot take work now, and what it uses instead. */
function FallbackAlert({
  group,
  manifest,
  providers,
}: {
  group: RoleGroup;
  manifest: Manifest;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const entries = manifest.lists[group.list] ?? [];
  const first = entries[0];
  if (first === undefined) return null;
  const uiOnly = isUiOnly(manifest, group.roles);
  const reason = unavailableReason(manifest.models[first.model], providers, { uiOnly });
  if (reason === null) return null;
  const next = entries.find(
    (entry) => unavailableReason(manifest.models[entry.model], providers, { uiOnly }) === null,
  );
  const label = (alias: string) => modelLabel(manifest.models[alias], alias, providers);
  return (
    <Alert variant="warning">
      <AlertDescription>
        {label(first.model)} is {reason}. {group.roles.join(" and ")}{" "}
        {next
          ? `will use ${label(next.model)} instead.`
          : "will be refused until a model is available."}
      </AlertDescription>
    </Alert>
  );
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

function JobRow({
  environmentId,
  group,
  manifest,
  briefs,
  rolesDir,
  providers,
  catalog,
  disabled,
  onChange,
}: {
  environmentId: EnvironmentId;
  group: RoleGroup;
  manifest: Manifest;
  briefs: AgentPolicySettings["snapshot"]["briefs"];
  rolesDir: string;
  providers: ReadonlyArray<ServerProvider>;
  catalog: ReadonlyArray<CatalogModel>;
  disabled: boolean;
  onChange: (manifest: Manifest) => void;
}) {
  const entries = manifest.lists[group.list] ?? [];
  const label = (alias: string) => modelLabel(manifest.models[alias], alias, providers);
  const uiOnly = isUiOnly(manifest, group.roles);
  const reasons = new Map(
    entries.map((entry) => [
      entry.model,
      unavailableReason(manifest.models[entry.model], providers, { uiOnly }),
    ]),
  );
  const firstAvailable = entries.find((entry) => reasons.get(entry.model) === null);
  const single = group.roles.length === 1 ? group.roles[0] : undefined;
  const exceptions = group.roles.flatMap((role) => {
    const policy = rolePolicy(manifest, role);
    return [
      ...(policy.large ? [{ role, kind: "large" as const }] : []),
      ...Object.keys(policy.callers ?? {}).map((caller) => ({ role, kind: caller })),
    ];
  });
  const largeChoices = [
    ...new Map(
      group.roles.flatMap((role) => {
        const large = rolePolicy(manifest, role).large;
        return large ? [[`${large.model}:${large.effort ?? ""}`, large] as const] : [];
      }),
    ).values(),
  ];
  const listed = (model: CatalogModel) =>
    entries.some((entry) => {
      const binding = manifest.models[entry.model];
      return (
        binding?.driverKind === model.binding.driverKind && binding.model === model.binding.model
      );
    })
      ? "Already in this job"
      : null;
  const add = (model: CatalogModel) => {
    const [next, alias] = ensureModel(manifest, model);
    const effort = effortForModel(model);
    onChange(
      addEntry(next, group.list, {
        model: alias,
        ...(effort === undefined ? {} : { effort }),
      }),
    );
  };
  const chip = (alias: string, effort?: string) => {
    const binding = manifest.models[alias];
    return binding ? (
      <ModelLabel
        variant="chip"
        environmentId={environmentId}
        driverKind={binding.driverKind}
        model={binding.model}
        effort={effort}
      />
    ) : (
      <Badge variant="outline">{alias}</Badge>
    );
  };
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <Collapsible>
        <CollapsibleTrigger className="group/job flex w-full items-start gap-3 px-3 py-3 text-left sm:px-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {group.roles.map((role) => (
                <span key={role} className="flex items-center gap-1">
                  <RoleBriefChip role={role} brief={briefs[role]?.text} rolesDir={rolesDir} />
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {group.roles.map((role) => ROLE_DESCRIPTIONS[role]).join(" · ")}
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {entries.map((entry, index) => (
                <span
                  key={entry.model}
                  className={cn(
                    "flex min-w-0 items-center gap-1",
                    entry !== firstAvailable && "opacity-60",
                    reasons.get(entry.model) !== null && "line-through",
                  )}
                >
                  {index > 0 ? <span className="text-xs text-muted-foreground">→</span> : null}
                  {chip(entry.model)}
                </span>
              ))}
              {largeChoices.map((large) => (
                <span
                  key={`${large.model}:${large.effort ?? ""}`}
                  className="ms-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
                >
                  large
                  {chip(large.model, large.effort)}
                </span>
              ))}
            </div>
          </div>
          <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/job:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 px-3 pb-4 sm:px-4">
            <ol className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60">
              {entries.map((entry, index) => {
                const binding = manifest.models[entry.model];
                const reason = reasons.get(entry.model) ?? null;
                return (
                  <li key={entry.model} className="flex min-w-0 items-center gap-1.5 px-2 py-1">
                    <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      {index + 1}
                    </span>
                    <PolicyModelPicker
                      environmentId={environmentId}
                      catalog={catalog}
                      binding={binding}
                      disabled={disabled}
                      pickDisabledReason={listed}
                      onPick={(model) =>
                        onChange(
                          replaceEntry(
                            manifest,
                            group.list,
                            entry.model,
                            model,
                            effortForModel(model, entry.effort),
                          ),
                        )
                      }
                    />
                    <PolicyEffortPicker
                      environmentId={environmentId}
                      binding={binding}
                      effort={entry.effort}
                      disabled={disabled}
                      onChange={(effort) =>
                        onChange(setEntryEffort(manifest, group.list, entry.model, effort))
                      }
                    />
                    {offersFast(binding, providers) ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <label className="flex shrink-0 cursor-default items-center gap-1.5 text-xs" />
                          }
                        >
                          <Switch
                            checked={runsFast(binding)}
                            disabled={disabled}
                            onCheckedChange={(fast) =>
                              onChange(setModelFast(manifest, entry.model, fast))
                            }
                          />
                          Fast
                        </TooltipTrigger>
                        <TooltipPopup>
                          Runs this model on the fast service tier in every job that lists it
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-xs text-warning">{reason}</span>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Move ${label(entry.model)} up`}
                      disabled={disabled || index === 0}
                      onClick={() => onChange(moveEntry(manifest, group.list, index, -1))}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Move ${label(entry.model)} down`}
                      disabled={disabled || index === entries.length - 1}
                      onClick={() => onChange(moveEntry(manifest, group.list, index, 1))}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${label(entry.model)}`}
                      disabled={disabled}
                      onClick={() => onChange(removeEntry(manifest, group.list, entry.model))}
                    >
                      <XIcon />
                    </Button>
                  </li>
                );
              })}
            </ol>
            {exceptions.map(({ role, kind }) => (
              <ExceptionLine
                key={`${role}:${kind}`}
                environmentId={environmentId}
                role={group.roles.length > 1 ? role : undefined}
                kind={kind}
                policy={rolePolicy(manifest, role)}
                catalog={catalog}
                manifest={manifest}
                disabled={disabled}
                onChange={(edit) => onChange(edit(manifest, role))}
              />
            ))}
            <div className="flex flex-wrap items-center gap-1.5">
              <PolicyModelPicker
                environmentId={environmentId}
                catalog={catalog}
                binding={undefined}
                disabled={disabled}
                pickDisabledReason={listed}
                trigger={
                  <Button size="xs" variant="outline" disabled={disabled}>
                    <PlusIcon />
                    Add model
                  </Button>
                }
                onPick={add}
              />
              {single && !rolePolicy(manifest, single).large && entries.length > 0 ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => onChange(setLarge(manifest, single, entries[entries.length - 1]))}
                >
                  Different model for large tasks
                </Button>
              ) : null}
              {single && entries.length > 0 ? (
                <PolicyModelPicker
                  environmentId={environmentId}
                  catalog={catalog}
                  binding={undefined}
                  disabled={disabled}
                  pickDisabledReason={(model) => {
                    const alias = aliasOf(manifest, model);
                    return alias !== undefined &&
                      rolePolicy(manifest, single).callers?.[alias] !== undefined
                      ? "Already has its own choice"
                      : null;
                  }}
                  trigger={
                    <Button size="xs" variant="ghost-muted" disabled={disabled}>
                      Different model for one agent
                    </Button>
                  }
                  onPick={(model) => {
                    const [next, alias] = ensureModel(manifest, model);
                    onChange(setCaller(next, single, alias, entries[entries.length - 1]!.model));
                  }}
                />
              ) : null}
              {group.roles.length > 1 ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => onChange(splitGroup(manifest, group))}
                >
                  Split into separate jobs
                </Button>
              ) : null}
            </div>
            {group.roles.filter(isReviewerRole).map((role) => (
              <label key={role} className="flex items-center gap-2 text-xs">
                <Switch
                  checked={manifest.roles[role].preferOtherAuthorProvider === true}
                  disabled={disabled}
                  onCheckedChange={(value) =>
                    onChange(setPreferOtherAuthorProvider(manifest, role, value))
                  }
                />
                {group.roles.length > 1 ? `${AGENT_ROLE_PRESENTATION[role].label}: ` : ""}Prefer a
                different provider from the author. Never defaults to the author&apos;s own model.
              </label>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

const aliasOf = (manifest: Manifest, model: CatalogModel) =>
  Object.entries(manifest.models).find(
    ([, binding]) =>
      binding.driverKind === model.binding.driverKind && binding.model === model.binding.model,
  )?.[0];

/**
 * A role's exception to its list: a different first model for large tasks, or for one
 * asking agent. Its choice must be listed in the job, so picking another model lists it last.
 */
function ExceptionLine({
  environmentId,
  role,
  kind,
  policy,
  catalog,
  manifest,
  disabled,
  onChange,
}: {
  environmentId: EnvironmentId;
  role: AgentRole | undefined;
  kind: "large" | string;
  policy: RolePolicy;
  catalog: ReadonlyArray<CatalogModel>;
  manifest: Manifest;
  disabled: boolean;
  onChange: (edit: (manifest: Manifest, role: AgentRole) => Manifest) => void;
}) {
  let body: ReactNode;
  let remove: (manifest: Manifest, role: AgentRole) => Manifest;
  if (kind === "large" && policy.large) {
    const large = policy.large;
    body = (
      <>
        <span>Large tasks start on</span>
        <PolicyModelPicker
          environmentId={environmentId}
          catalog={catalog}
          binding={manifest.models[large.model]}
          disabled={disabled}
          onPick={(model) =>
            onChange((m, r) => {
              const effort = effortForModel(model, large.effort);
              const [next, alias] = listModel(m, policy.list, model, effort);
              return setLarge(next, r, {
                model: alias,
                ...(effort === undefined ? {} : { effort }),
              });
            })
          }
        />
        <PolicyEffortPicker
          environmentId={environmentId}
          binding={manifest.models[large.model]}
          effort={large.effort}
          disabled={disabled}
          onChange={(effort) => onChange((m, r) => setLarge(m, r, { ...large, effort }))}
        />
      </>
    );
    remove = (m, r) => setLarge(m, r, undefined);
  } else {
    const first = policy.callers?.[kind] ?? "";
    const caller = manifest.models[kind];
    body = (
      <>
        <span>When</span>
        {caller ? (
          <ModelLabel
            variant="chip"
            environmentId={environmentId}
            driverKind={caller.driverKind}
            model={caller.model}
          />
        ) : (
          <span>{kind}</span>
        )}
        <span>asks, start on</span>
        <PolicyModelPicker
          environmentId={environmentId}
          catalog={catalog}
          binding={manifest.models[first]}
          disabled={disabled}
          onPick={(model) =>
            onChange((m, r) => {
              const [next, alias] = listModel(m, policy.list, model, effortForModel(model));
              return setCaller(next, r, kind, alias);
            })
          }
        />
      </>
    );
    remove = (m, r) => setCaller(m, r, kind, undefined);
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/40 py-1 ps-3 pe-1 text-xs text-muted-foreground">
      {role ? <AgentRoleChip role={role} /> : null}
      {body}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        className="ms-auto"
        aria-label="Remove exception"
        disabled={disabled}
        onClick={() => onChange(remove)}
      >
        <XIcon />
      </Button>
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
        description="With Full access, Claude helpers can edit, run commands and use the network outside their workspace. Off, they only read. Codex helpers stay sandboxed either way."
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
    </SettingsSection>
  );
}
