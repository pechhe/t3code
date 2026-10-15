import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import {
  AgentPolicyManifest,
  AgentRole,
  AgentTaskClass,
  AgentModelPool,
  type AgentPolicySettings,
  type AgentPolicyPreview,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const valid = Schema.is(AgentPolicyManifest);
const isRole = Schema.is(AgentRole);
const isTaskClass = Schema.is(AgentTaskClass);
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
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
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
    </label>
  );
}
function Check({
  children,
  checked,
  onChange,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {children}
    </label>
  );
}
function Order({
  values,
  allowed,
  onChange,
}: {
  values: readonly string[];
  allowed: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const next = [...values];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Preference order (first wins after eligibility and provider rules)
      </p>
      {values.map((alias, index) => (
        <div key={alias} className="flex items-center gap-2 text-sm">
          <span className="min-w-24">
            {index + 1}. {alias}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={`Move ${alias} earlier`}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            ↑
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={`Move ${alias} later`}
            disabled={index === values.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => onChange(values.filter((value) => value !== alias))}
          >
            Remove preference
          </Button>
        </div>
      ))}
      {allowed
        .filter((alias) => !values.includes(alias))
        .map((alias) => (
          <Button
            key={alias}
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => onChange([...values, alias])}
          >
            Prefer {alias}
          </Button>
        ))}
    </div>
  );
}
function efforts(providers: readonly ServerProvider[], binding: Manifest["models"][string]) {
  return [
    ...new Set(
      providers
        .filter((provider) => provider.driver === binding.driverKind)
        .flatMap((provider) => provider.models.filter((model) => model.slug === binding.model))
        .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
        .filter((option) => option.id === binding.effortOption)
        .flatMap((option) =>
          option.type === "select" ? option.options.map((value) => value.id) : [],
        ),
    ),
  ];
}

export function DelegationSettings() {
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Agents · Delegation" variant="plain">
        <p className="text-sm text-muted-foreground">
          Choose which models can perform each role. Changes apply to new tasks; running tasks
          retain their recorded policy. Saving edits agent-config; it does not commit, land or
          publish it.
        </p>
        {environments.length === 0 && <p>Connect an environment to manage delegation.</p>}
        {environments.map((environment) => (
          <EnvironmentDelegation
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            connected={environment.connection.phase === "connected"}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
function EnvironmentDelegation({
  environmentId,
  label,
  connected,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
}) {
  const canEdit = useAtomValue(serverEnvironment.agentPolicySave.permissionAtom(environmentId));
  const liveConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const query = useEnvironmentQuery(
    connected && canEdit ? serverEnvironment.agentPolicyRead({ environmentId, input: {} }) : null,
  );
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection
      title={label}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!connected || !canEdit}
          onClick={query.refresh}
        >
          Reload policy
        </Button>
      }
    >
      <div className="grid gap-4 p-4">
        {!connected ? (
          <p>Reconnect this environment to edit its delegation policy.</p>
        ) : !canEdit ? (
          <p>Owner settings permission is required to manage delegation.</p>
        ) : null}
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? query.error}
          </p>
        )}
        {query.isPending && !query.data && <p>Loading policy…</p>}
        {query.data && (
          <PolicyEditor
            key={query.data.snapshot.hash}
            environmentId={environmentId}
            data={{ ...query.data, providers: liveConfig?.providers ?? query.data.providers }}
            disabled={!connected || !canEdit}
            onSaved={() => {
              setError(null);
              query.refresh();
            }}
            onError={(message) => {
              setError(message);
              query.refresh();
            }}
          />
        )}
      </div>
    </SettingsSection>
  );
}
function PolicyEditor({
  environmentId,
  data,
  disabled,
  onSaved,
  onError,
}: {
  environmentId: EnvironmentId;
  data: AgentPolicySettings;
  disabled: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Manifest>(() => structuredClone(data.snapshot.manifest));
  const [alias, setAlias] = useState("");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<AgentPolicyPreview | null>(null);
  const [role, setRole] = useState<AgentRole>("implementation-worker");
  const [taskClass, setTaskClass] = useState<AgentTaskClass>("non-ui");
  const [caller, setCaller] = useState("");
  const [authorModel, setAuthorModel] = useState("");
  const [demanding, setDemanding] = useState(false);
  const save = useAtomCommand(serverEnvironment.agentPolicySave);
  const resolve = useAtomCommand(serverEnvironment.agentPolicyPreview);
  const catalog = [
    ...new Map(
      data.providers
        .filter(
          (provider) =>
            provider.poolMembers === undefined &&
            (provider.driver === "codex" || provider.driver === "claudeAgent"),
        )
        .flatMap((provider) =>
          provider.models
            .filter((model) =>
              model.capabilities?.optionDescriptors?.some((option) => option.type === "select"),
            )
            .map((model) => [`${provider.driver}:${model.slug}`, { provider, model }] as const),
        ),
    ).entries(),
  ];
  const changed = (edit: (value: Manifest) => Manifest) => {
    setDraft(edit);
    setPreview(null);
  };
  const changeModel = (name: string, choice: string) => {
    const selected = catalog.find(([key]) => key === choice)?.[1];
    if (!selected) return;
    const option = selected.model.capabilities?.optionDescriptors?.find(
      (value) => value.type === "select",
    );
    if (!option || option.type !== "select") return;
    const fallback =
      option.options.find((value) => value.id === "medium")?.id ?? option.options[0]?.id;
    if (!fallback) return;
    changed((value) => ({
      ...value,
      models: {
        ...value.models,
        [name]: {
          driverKind: selected.provider.driver,
          model: selected.model.slug,
          effortOption: option.id,
        },
      },
      roles: Object.fromEntries(
        Object.entries(value.roles).map(([key, policy]) => {
          const previous = policy.effort[name];
          if (previous === undefined) return [key, policy];
          const supported = (effort: string) => option.options.some((value) => value.id === effort);
          return [
            key,
            {
              ...policy,
              effort: {
                ...policy.effort,
                [name]: {
                  default: supported(previous.default) ? previous.default : fallback,
                  ...(previous.demanding !== undefined && supported(previous.demanding)
                    ? { demanding: previous.demanding }
                    : {}),
                },
              },
            },
          ];
        }),
      ) as Manifest["roles"],
    }));
  };
  const poolAlias = (poolName: keyof Manifest["pools"], name: string, allowed: boolean) =>
    changed((value) => {
      const pool = value.pools[poolName];
      const allow = allowed ? [...pool.allow, name] : pool.allow.filter((item) => item !== name);
      const binding = value.models[name]!;
      const options = efforts(data.providers, binding);
      const roles = Object.fromEntries(
        Object.entries(value.roles).map(([key, policy]) => {
          if (policy.pool !== poolName) return [key, policy];
          const effort = { ...policy.effort };
          if (allowed)
            effort[name] = {
              default: options.includes("medium") ? "medium" : (options[0] ?? "medium"),
            };
          else delete effort[name];
          return [
            key,
            {
              ...policy,
              effort,
              restrictions: Object.fromEntries(
                Object.entries(policy.restrictions).map(([kind, aliases]) => [
                  kind,
                  aliases?.filter((item) => item !== name),
                ]),
              ),
            },
          ];
        }),
      ) as Manifest["roles"];
      return {
        ...value,
        roles,
        pools: {
          ...value.pools,
          [poolName]: {
            ...pool,
            allow,
            prefer: pool.prefer.filter((item) => allow.includes(item)),
          },
        },
        ...(value.reviewer && poolName === "workhorse"
          ? {
              reviewer: {
                ...value.reviewer,
                prefer: value.reviewer.prefer.filter((item) => allow.includes(item)),
              },
            }
          : {}),
      };
    });
  const removeModel = (name: string) =>
    changed((value) => {
      const models = { ...value.models };
      delete models[name];
      const pools = { ...value.pools };
      for (const key of AgentModelPool.literals) {
        const pool = pools[key];
        pools[key] = {
          ...pool,
          allow: pool.allow.filter((alias) => alias !== name),
          prefer: pool.prefer.filter((alias) => alias !== name),
        };
      }
      return {
        ...value,
        models,
        pools,
        roles: Object.fromEntries(
          Object.entries(value.roles).map(([key, policy]) => {
            const effort = { ...policy.effort };
            delete effort[name];
            return [
              key,
              {
                ...policy,
                effort,
                restrictions: Object.fromEntries(
                  Object.entries(policy.restrictions).map(([kind, aliases]) => [
                    kind,
                    aliases?.filter((alias) => alias !== name),
                  ]),
                ),
              },
            ];
          }),
        ) as Manifest["roles"],
        ...(value.reviewer
          ? {
              reviewer: {
                ...value.reviewer,
                prefer: value.reviewer.prefer.filter((alias) => alias !== name),
              },
            }
          : {}),
      };
    });
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
  const inspect = async () => {
    setPending(true);
    const provider = data.providers.find((value) => value.instanceId === caller);
    const result = await resolve({
      environmentId,
      input: {
        manifest: draft,
        role,
        taskClass,
        demanding,
        ...(provider ? { callerProviderInstanceId: provider.instanceId } : {}),
        ...(authorModel ? { authorModel } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") setPreview(result.value);
    else onError(String(squashAtomCommandFailure(result)));
  };
  const reviewer = draft.reviewer ?? {
    prefer: draft.pools.workhorse.prefer,
    requireDifferentProvider: false,
  };
  return (
    <fieldset disabled={disabled || pending} className="grid min-w-0 gap-6">
      <p className="text-xs text-muted-foreground">
        Policy {data.snapshot.sourceRevision} · {data.sourceRoot}/roles/policy.json
      </p>
      <p role="status" className="text-sm">
        {data.uncommitted === true
          ? "Uncommitted change in agent-config"
          : data.uncommitted === false
            ? "No uncommitted policy changes"
            : "Source commit status unavailable"}
      </p>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Models and accounts</h3>
        {Object.entries(draft.models).map(([name, binding]) => {
          const accounts = data.providers.filter(
            (provider) =>
              provider.poolMembers === undefined && provider.driver === binding.driverKind,
          );
          const choices: Array<{ value: string; label: string }> = catalog.map(([value, item]) => ({
            value,
            label: `${item.provider.driver} · ${item.model.name}`,
          }));
          const current = `${binding.driverKind}:${binding.model}`;
          if (!choices.some((item) => item.value === current))
            choices.unshift({
              value: current,
              label: `${binding.model} (not currently available)`,
            });
          return (
            <div key={name} className="grid gap-2 rounded-lg border p-3">
              <Choice
                label={name}
                value={current}
                values={choices}
                onChange={(value) => changeModel(name, value)}
              />
              <p className="text-xs text-muted-foreground">
                Effort option: {binding.effortOption}. Set each role’s effort below.
              </p>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={`Remove model ${name}`}
                onClick={() => removeModel(name)}
              >
                Remove model
              </Button>
              {accounts.length === 0 && <p className="text-xs">Provider not installed.</p>}
              {accounts.map((provider) => (
                <p key={provider.instanceId} className="text-xs">
                  {provider.displayName ?? provider.instanceId}:{" "}
                  {provider.installed ? "installed" : "not installed"} · {provider.auth.status} ·{" "}
                  {provider.enabled ? provider.status : "disabled"}
                  {provider.usageLimits?.windows.some(
                    (window) =>
                      window.usedPercent >= 100 &&
                      (window.resetsAt === undefined || Date.parse(window.resetsAt) > Date.now()),
                  )
                    ? " · rate limited"
                    : ""}
                </p>
              ))}
            </div>
          );
        })}
        <div className="flex items-end gap-2">
          <label className="grid gap-1 text-sm">
            New model alias
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="model-alias"
            />
          </label>
          <Button
            size="sm"
            disabled={
              !/^[a-z][a-z0-9-]{0,63}$/.test(alias) ||
              draft.models[alias] !== undefined ||
              catalog.length === 0
            }
            onClick={() => {
              changeModel(alias, catalog[0]![0]);
              setAlias("");
            }}
          >
            Add model
          </Button>
        </div>
      </section>
      <section className="grid gap-4">
        <h3 className="text-sm font-medium">Pools</h3>
        {Object.entries(draft.pools).map(([poolName, pool]) => (
          <div key={poolName} className="grid gap-3 rounded-lg border p-3">
            <h4 className="text-sm font-medium">{poolName}</h4>
            <div className="flex flex-wrap gap-4">
              {Object.keys(draft.models).map((name) => (
                <Check
                  key={name}
                  checked={pool.allow.includes(name)}
                  onChange={(allowed) =>
                    poolAlias(poolName as keyof Manifest["pools"], name, allowed)
                  }
                >
                  {name}
                </Check>
              ))}
            </div>
            <Check
              checked={pool.crossProvider !== false}
              onChange={(crossProvider) =>
                changed((value) => ({
                  ...value,
                  pools: { ...value.pools, [poolName]: { ...pool, crossProvider } },
                }))
              }
            >
              Prefer a different provider from the caller
            </Check>
            <Order
              values={pool.prefer}
              allowed={pool.allow}
              onChange={(prefer) =>
                changed((value) => ({
                  ...value,
                  pools: { ...value.pools, [poolName]: { ...pool, prefer } },
                }))
              }
            />
          </div>
        ))}
      </section>
      <section className="grid gap-4">
        <h3 className="text-sm font-medium">Roles</h3>
        {Object.entries(draft.roles).map(([name, policy]) => (
          <div key={name} className="grid gap-3 rounded-lg border p-3">
            <h4 className="text-sm font-medium">
              {name} · {policy.pool} pool
            </h4>
            <p className="text-xs text-muted-foreground">
              {policy.sourceAccess} · {policy.toolProfile}
            </p>
            {policy.taskClasses.map((kind) => (
              <div key={kind} className="grid gap-2">
                <p className="text-sm">Allowed for {kind}</p>
                <div className="flex flex-wrap gap-4">
                  {draft.pools[policy.pool].allow.map((modelAlias) => (
                    <Check
                      key={modelAlias}
                      checked={(
                        policy.restrictions[kind] ?? draft.pools[policy.pool].allow
                      ).includes(modelAlias)}
                      onChange={(checked) => {
                        const current = policy.restrictions[kind] ?? draft.pools[policy.pool].allow;
                        changed((value) => ({
                          ...value,
                          roles: {
                            ...value.roles,
                            [name]: {
                              ...policy,
                              restrictions: {
                                ...policy.restrictions,
                                [kind]: checked
                                  ? [...current, modelAlias]
                                  : current.filter((item) => item !== modelAlias),
                              },
                            },
                          },
                        }));
                      }}
                    >
                      {modelAlias}
                    </Check>
                  ))}
                </div>
              </div>
            ))}
            {Object.entries(policy.effort).map(([modelAlias, effort]) => {
              const options = [
                ...new Set([
                  effort.default,
                  ...(effort.demanding ? [effort.demanding] : []),
                  ...efforts(data.providers, draft.models[modelAlias]!),
                ]),
              ];
              const update = (next: typeof effort) =>
                changed((value) => ({
                  ...value,
                  roles: {
                    ...value.roles,
                    [name]: { ...policy, effort: { ...policy.effort, [modelAlias]: next } },
                  },
                }));
              return (
                <div key={modelAlias} className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    label={`${name} / ${modelAlias}: default effort`}
                    value={effort.default}
                    values={options.map((value) => ({ value, label: value }))}
                    onChange={(value) => update({ ...effort, default: value })}
                  />
                  <Choice
                    label={`${name} / ${modelAlias}: demanding effort`}
                    value={effort.demanding ?? "__default"}
                    values={[
                      { value: "__default", label: "Not eligible for demanding tasks" },
                      ...options.map((value) => ({ value, label: value })),
                    ]}
                    onChange={(value) =>
                      update(
                        value === "__default"
                          ? { default: effort.default }
                          : { ...effort, demanding: value },
                      )
                    }
                  />
                </div>
              );
            })}
            <details>
              <summary className="cursor-pointer text-sm">Role brief (read-only)</summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs">
                {data.snapshot.briefs[name as AgentRole].text}
              </pre>
            </details>
          </div>
        ))}
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Reviewer</h3>
        <Check
          checked={reviewer.requireDifferentProvider}
          onChange={(requireDifferentProvider) =>
            changed((value) => ({ ...value, reviewer: { ...reviewer, requireDifferentProvider } }))
          }
        >
          Require a different provider from the author
        </Check>
        <Order
          values={reviewer.prefer}
          allowed={draft.pools.workhorse.allow}
          onChange={(prefer) =>
            changed((value) => ({ ...value, reviewer: { ...reviewer, prefer } }))
          }
        />
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Resolution preview</h3>
        <p className="text-xs text-muted-foreground">
          Uses these unsaved choices and the real resolver. Previewing starts no model and changes
          no policy.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice
            label="Role"
            value={role}
            values={AgentRole.literals.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              if (isRole(value)) {
                setRole(value);
                setPreview(null);
              }
            }}
          />
          <Choice
            label="Task class"
            value={taskClass}
            values={AgentTaskClass.literals.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              if (isTaskClass(value)) {
                setTaskClass(value);
                setPreview(null);
              }
            }}
          />
          <Choice
            label="Caller account"
            value={caller}
            values={[
              { value: "", label: "No caller preference" },
              ...data.providers.map((provider) => ({
                value: provider.instanceId,
                label: provider.displayName ?? provider.instanceId,
              })),
            ]}
            onChange={(value) => {
              setCaller(value);
              setPreview(null);
            }}
          />
          <Choice
            label="Author model (reviewer)"
            value={authorModel}
            values={[
              { value: "", label: "Unknown" },
              ...Object.values(draft.models).map((binding) => ({
                value: binding.model,
                label: binding.model,
              })),
            ]}
            onChange={(value) => {
              setAuthorModel(value);
              setPreview(null);
            }}
          />
        </div>
        <Check
          checked={demanding}
          onChange={(value) => {
            setDemanding(value);
            setPreview(null);
          }}
        >
          Demanding task
        </Check>
        <Button size="sm" variant="outline" disabled={!valid(draft)} onClick={() => void inspect()}>
          Preview selection
        </Button>
        {preview && (
          <div role="status" className="grid gap-2 rounded-lg border p-3 text-sm">
            <p>
              {preview.selection
                ? `Selected ${preview.selection.model} (${preview.selection.instanceId})`
                : `Refused: ${preview.refusal}`}
            </p>
            {preview.candidates.map((candidate) => (
              <p
                key={`${candidate.alias}:${candidate.providerInstanceId ?? "unavailable"}`}
                className="text-xs"
              >
                {candidate.alias}
                {candidate.providerInstanceId ? ` / ${candidate.providerInstanceId}` : ""}:{" "}
                {candidate.reason.replaceAll("-", " ")}
              </p>
            ))}
          </div>
        )}
      </section>
      {!valid(draft) && (
        <p role="alert" className="text-sm text-destructive">
          The policy is invalid. Every pool and supported role class needs an allowed model, valid
          effort and consistent preferences.
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={!valid(draft)} onClick={() => void submit()}>
          {pending ? "Working…" : "Save policy"}
        </Button>
        <Button
          variant="ghost-muted"
          onClick={() => {
            setDraft(structuredClone(data.snapshot.manifest));
            setPreview(null);
          }}
        >
          Discard edits
        </Button>
      </div>
    </fieldset>
  );
}
