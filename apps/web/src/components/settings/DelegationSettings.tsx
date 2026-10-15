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
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  addEntry,
  catalogModels,
  effortChoices,
  effortFor,
  ensureModel,
  modelLabel,
  moveEntry,
  removeEntry,
  ROLE_DESCRIPTIONS,
  roleGroups,
  setCaller,
  setEntryEffort,
  setLarge,
  setPreferOtherAuthorProvider,
  splitGroup,
  isUiOnly,
  unavailableReason,
  UNAVAILABLE_ROLES,
  type CatalogModel,
  type RoleGroup,
} from "./DelegationSettings.logic";
import { AgentRoleChip } from "../AgentRoleChip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
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
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environments.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          Connect an environment to manage delegation.
        </p>
      ) : null}
      {environments.map((environment) => (
        <EnvironmentDelegation
          key={environment.environmentId}
          environmentId={environment.environmentId}
          title={environments.length > 1 ? environment.label : "Jobs"}
          connected={environment.connection.phase === "connected"}
        />
      ))}
      <PermissionsSection />
    </SettingsPageContainer>
  );
}

function EnvironmentDelegation({
  environmentId,
  title,
  connected,
}: {
  environmentId: EnvironmentId;
  title: string;
  connected: boolean;
}) {
  const canEdit = useAtomValue(serverEnvironment.agentPolicySave.permissionAtom(environmentId));
  const liveConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const query = useEnvironmentQuery(
    connected && canEdit ? serverEnvironment.agentPolicyRead({ environmentId, input: {} }) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const notice = !connected
    ? "Reconnect this environment to edit its delegation policy."
    : !canEdit
      ? "Owner settings permission is required to manage delegation."
      : query.isPending && !query.data
        ? "Loading policy…"
        : null;
  return (
    <>
      {(error ?? query.error) ? (
        <Alert variant="error">
          <AlertDescription role="alert">{error ?? query.error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? <p className="px-4 text-sm text-muted-foreground">{notice}</p> : null}
      {query.data ? (
        <PolicyEditor
          key={query.data.snapshot.hash}
          environmentId={environmentId}
          title={title}
          data={{ ...query.data, providers: liveConfig?.providers ?? query.data.providers }}
          onReload={query.refresh}
          onSaved={() => {
            setError(null);
            query.refresh();
          }}
          onError={(message) => {
            setError(message);
            query.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function PolicyEditor({
  environmentId,
  title,
  data,
  onReload,
  onSaved,
  onError,
}: {
  environmentId: EnvironmentId;
  title: string;
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
    const result = await save({
      environmentId,
      input: { expectedHash: data.snapshot.hash, manifest: draft },
    });
    setPending(false);
    if (result._tag === "Success") onSaved();
    else onError(String(squashAtomCommandFailure(result)));
  };
  return (
    <>
      {groups.map((group) => (
        <FallbackAlert key={group.list} group={group} manifest={draft} providers={data.providers} />
      ))}
      <SettingsSection
        id="delegation"
        title={title}
        headerAction={
          <Button size="xs" variant="ghost-muted" disabled={pending} onClick={onReload}>
            Reload
          </Button>
        }
      >
        {groups.map((group) => (
          <JobRow
            key={group.list}
            group={group}
            manifest={draft}
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
            {isValid(draft)
              ? "Unsaved changes apply to new tasks once saved."
              : "Every job needs at least one model before saving."}
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
            <Button size="xs" disabled={pending || !isValid(draft)} onClick={() => void submit()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <p className="px-4 text-xs text-muted-foreground">
        {data.sourceRoot}/roles/policy.json · revision {data.snapshot.sourceRevision}
        {data.uncommitted === true ? " · not committed" : ""}
      </p>
    </>
  );
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
  const roles = group.roles.filter((role) => !UNAVAILABLE_ROLES.has(role));
  const entries = manifest.lists[group.list] ?? [];
  const first = entries[0];
  if (roles.length === 0 || first === undefined) return null;
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
        {label(first.model)} is {reason}. {roles.join(" and ")}{" "}
        {next
          ? `will use ${label(next.model)} instead.`
          : "will be refused until a model is available."}
      </AlertDescription>
    </Alert>
  );
}

function JobRow({
  group,
  manifest,
  providers,
  catalog,
  disabled,
  onChange,
}: {
  group: RoleGroup;
  manifest: Manifest;
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
    const policy = manifest.roles[role];
    return [
      ...(policy.large ? [{ role, kind: "large" as const }] : []),
      ...Object.keys(policy.callers ?? {}).map((caller) => ({ role, kind: caller })),
    ];
  });
  const largeChoices = [
    ...new Map(
      group.roles.flatMap((role) => {
        const large = manifest.roles[role].large;
        return large ? [[`${large.model}:${large.effort}`, large] as const] : [];
      }),
    ).values(),
  ];
  const add = (model: CatalogModel) => {
    const [next, alias] = ensureModel(manifest, model);
    const effort = effortFor(model.efforts);
    onChange(addEntry(next, group.list, { model: alias, effort }));
  };
  const unused = catalog.filter(
    (model) =>
      !entries.some((entry) => {
        const binding = manifest.models[entry.model];
        return (
          binding?.driverKind === model.binding.driverKind && binding.model === model.binding.model
        );
      }),
  );
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <Collapsible>
        <CollapsibleTrigger className="group/job flex w-full items-center gap-3 px-3 py-2.5 text-left sm:px-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
              {group.roles.map((role) => (
                <span key={role} className="flex items-center gap-1.5">
                  <AgentRoleChip role={role} />
                  {UNAVAILABLE_ROLES.has(role) ? (
                    <Badge variant="outline" size="sm">
                      not available yet
                    </Badge>
                  ) : null}
                </span>
              ))}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {group.roles.map((role) => ROLE_DESCRIPTIONS[role]).join(" · ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {entries.map((entry, index) => (
              <span key={entry.model} className="flex items-center gap-1">
                {index > 0 ? <span className="text-xs text-muted-foreground">→</span> : null}
                <Badge variant={entry === firstAvailable ? "secondary" : "outline"}>
                  {reasons.get(entry.model) === null ? (
                    label(entry.model)
                  ) : (
                    <s>{label(entry.model)}</s>
                  )}
                </Badge>
              </span>
            ))}
            {largeChoices.map((large) => (
              <span
                key={`${large.model}:${large.effort}`}
                className="ml-1.5 flex items-center gap-1 text-xs text-muted-foreground"
              >
                large:
                <Badge variant="outline">
                  {label(large.model)} · {large.effort}
                </Badge>
              </span>
            ))}
          </div>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/job:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 px-3 pb-4 sm:px-4">
            {entries.map((entry, index) => {
              const binding = manifest.models[entry.model];
              const reason = reasons.get(entry.model) ?? null;
              const efforts = effortChoices(binding, providers);
              return (
                <div
                  key={entry.model}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5"
                >
                  <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {label(entry.model)}
                    {reason ? <span className="ml-2 text-xs text-warning">{reason}</span> : null}
                  </span>
                  <Choice
                    label={`${label(entry.model)} effort`}
                    value={entry.effort}
                    values={[...new Set([entry.effort, ...efforts])].map((value) => ({
                      value,
                      label: value,
                    }))}
                    onChange={(effort) =>
                      onChange(setEntryEffort(manifest, group.list, entry.model, effort))
                    }
                  />
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
                </div>
              );
            })}
            {exceptions.map(({ role, kind }) => (
              <ExceptionLine
                key={`${role}:${kind}`}
                role={group.roles.length > 1 ? role : undefined}
                kind={kind}
                policy={manifest.roles[role]}
                entries={entries}
                label={label}
                providers={providers}
                manifest={manifest}
                onChange={(edit) => onChange(edit(manifest, role))}
              />
            ))}
            <div className="flex flex-wrap items-center gap-1.5">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled || unused.length === 0}
                    />
                  }
                >
                  <PlusIcon />
                  Add model
                </MenuTrigger>
                <MenuPopup align="start">
                  {unused.map((model) => (
                    <MenuItem key={model.key} onClick={() => add(model)}>
                      {model.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              {single && !manifest.roles[single].large && entries.length > 0 ? (
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
                <CallerMenu
                  manifest={manifest}
                  role={single}
                  catalog={catalog}
                  disabled={disabled}
                  onChange={onChange}
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
                {group.roles.length > 1 ? `${role}: ` : ""}Prefer a different provider from the
                author. Never defaults to the author&apos;s own model.
              </label>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function ExceptionLine({
  role,
  kind,
  policy,
  entries,
  label,
  providers,
  manifest,
  onChange,
}: {
  role: AgentRole | undefined;
  kind: "large" | string;
  policy: Manifest["roles"][AgentRole];
  entries: Manifest["lists"][string];
  label: (alias: string) => string;
  providers: ReadonlyArray<ServerProvider>;
  manifest: Manifest;
  onChange: (edit: (manifest: Manifest, role: AgentRole) => Manifest) => void;
}) {
  const models = entries.map((entry) => ({ value: entry.model, label: label(entry.model) }));
  let body: ReactNode;
  let remove: (manifest: Manifest, role: AgentRole) => Manifest;
  if (kind === "large" && policy.large) {
    const large = policy.large;
    const efforts = effortChoices(manifest.models[large.model], providers);
    body = (
      <>
        For large tasks, use
        <Choice
          label="Large-task model"
          value={large.model}
          values={models}
          onChange={(model) =>
            onChange((m, r) =>
              setLarge(m, r, {
                model,
                effort: effortFor(effortChoices(m.models[model], providers), large.effort),
              }),
            )
          }
        />
        at
        <Choice
          label="Large-task effort"
          value={large.effort}
          values={[...new Set([large.effort, ...efforts])].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(effort) => onChange((m, r) => setLarge(m, r, { ...large, effort }))}
        />
      </>
    );
    remove = (m, r) => setLarge(m, r, undefined);
  } else {
    const first = policy.callers?.[kind] ?? "";
    body = (
      <>
        When {label(kind)} asks, use
        <Choice
          label={`Model for ${label(kind)}`}
          value={first}
          values={models}
          onChange={(model) => onChange((m, r) => setCaller(m, r, kind, model))}
        />
      </>
    );
    remove = (m, r) => setCaller(m, r, kind, undefined);
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-l-2 border-border py-1 pl-3 text-xs text-muted-foreground">
      {role ? <span className="font-mono">{role}:</span> : null}
      {body}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Remove exception"
        onClick={() => onChange(remove)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Adds a per-agent first choice: the asking model starts with the job's last listed model. */
function CallerMenu({
  manifest,
  role,
  catalog,
  disabled,
  onChange,
}: {
  manifest: Manifest;
  role: AgentRole;
  catalog: ReadonlyArray<CatalogModel>;
  disabled: boolean;
  onChange: (manifest: Manifest) => void;
}) {
  const policy = manifest.roles[role];
  const entries = manifest.lists[policy.list] ?? [];
  const callers = catalog.filter((model) => {
    const alias = Object.entries(manifest.models).find(
      ([, binding]) =>
        binding.driverKind === model.binding.driverKind && binding.model === model.binding.model,
    )?.[0];
    return alias === undefined || policy.callers?.[alias] === undefined;
  });
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost-muted" disabled={disabled || callers.length === 0} />
        }
      >
        Different model for one agent
      </MenuTrigger>
      <MenuPopup align="start">
        {callers.map((model) => (
          <MenuItem
            key={model.key}
            onClick={() => {
              const [next, alias] = ensureModel(manifest, model);
              onChange(setCaller(next, role, alias, entries[entries.length - 1]!.model));
            }}
          >
            When {model.label} asks
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
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
        description="Closes advisors whose result was delivered. Closed advisors stay readable in Previous agents."
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
