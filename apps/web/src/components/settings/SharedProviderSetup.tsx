import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettings,
  type SharedProviderSetupState,
} from "@t3tools/contracts";
import {
  planSharedSetupSync,
  type SharedSetupMember,
  applySharedSetupPlan,
} from "@t3tools/shared/sharedProviderSetup";
import { Atom } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const syncFailuresAtom = Atom.make<ReadonlyMap<EnvironmentId, string>>(new Map()).pipe(
  Atom.keepAlive,
);

const settingsByEnvironmentAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const settings = new Map<EnvironmentId, ServerSettings>();
    for (const id of key.split("\n") as EnvironmentId[]) {
      const value = id && get(serverEnvironment.settingsValueAtom(id));
      if (value) settings.set(id, value);
    }
    return settings;
  }),
);

export interface SharedEnvironment extends SharedSetupMember {
  readonly environment: EnvironmentPresentation;
  readonly settings: ServerSettings;
  readonly online: boolean;
}

function useSharedEnvironments() {
  const { environments } = useEnvironments();
  const settings = useAtomValue(
    settingsByEnvironmentAtom(environments.map((env) => env.environmentId).join("\n")),
  );
  const known: SharedEnvironment[] = [];
  for (const environment of environments) {
    const current = settings.get(environment.environmentId);
    const state: SharedProviderSetupState | undefined = current?.sharedProviderSetup;
    // A server without this state can't take part, so it isn't offered.
    if (!current || !state) continue;
    known.push({
      environmentId: environment.environmentId,
      environment,
      settings: current,
      state,
      online: environment.connection.phase === "connected",
    });
  }
  return known;
}

export function useSharedProviderSetup() {
  const known = useSharedEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const failures = useAtomValue(syncFailuresAtom);
  const members = known.filter((entry) => entry.state.shared);
  const candidates = known.filter((entry) => !entry.state.shared);
  const onlineMembers = members.filter((member) => member.online);
  const editing =
    onlineMembers.find((member) => member.environmentId === primaryEnvironmentId) ??
    onlineMembers[0];
  return {
    members,
    candidates,
    failures,
    primaryEnvironmentId,
    editingEnvironmentId: editing?.environmentId ?? null,
  };
}

const withoutSecretValues = (settings: ServerSettings) => settings.providerInstances;

/** Spreads the newest setup whenever a member's state changes or one comes back online. */
export function SharedProviderSetupSync() {
  const known = useSharedEnvironments();
  const apply = useAtomCommand(serverEnvironment.applySharedProviderSetup, {
    reportFailure: false,
    reportDefect: false,
  });
  const running = useRef(false);
  const failedPlan = useRef<string | null>(null);
  const [, reconsider] = useState(0);
  const reachable = known.filter(
    (entry) =>
      entry.state.shared &&
      entry.online &&
      readEnvironmentScope(entry.environmentId, AuthProvidersManageScope),
  );
  const plan = planSharedSetupSync(reachable);
  const planKey = plan && JSON.stringify([plan, plan.targets.map((target) => target.state.digest)]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Writes to other servers when their pushed state disagrees; nothing here derives render state.
  useEffect(() => {
    if (!plan && appAtomRegistry.get(syncFailuresAtom).size > 0) {
      appAtomRegistry.set(syncFailuresAtom, new Map());
    }
    // Only the identical plan stays refused, so a machine coming back is tried again.
    if (planKey !== failedPlan.current) failedPlan.current = null;
    if (!plan || running.current || planKey === failedPlan.current) return;
    const source = reachable.find((entry) => entry.environmentId === plan.sourceEnvironmentId);
    if (!source) return;
    running.current = true;
    void (async () => {
      const failures = await applySharedSetupPlan(plan, async (target) => {
        const result = await apply({
          environmentId: target.environmentId,
          input: {
            instances: withoutSecretValues(source.settings),
            version: plan.version,
            changedAt: plan.changedAt,
            expectedDigest: target.state.digest,
            join: false,
          },
        });
        return result._tag === "Success" ? null : describeFailure(result);
      });
      appAtomRegistry.set(syncFailuresAtom, failures);
      failedPlan.current = failures.size > 0 ? planKey : null;
      running.current = false;
      // State pushed during the run was skipped above, and may be what the next plan needs.
      reconsider((count) => count + 1);
    })();
  });
  return null;
}

const describeFailure = (result: unknown): string => {
  const error = (result as { readonly error?: unknown }).error;
  if (error instanceof Error && error.message) return error.message;
  return "This machine didn't take the last change.";
};

function useJoinSharedSetup() {
  const { members, primaryEnvironmentId, candidates } = useSharedProviderSetup();
  const apply = useAtomCommand(serverEnvironment.applySharedProviderSetup);
  const setSharing = useAtomCommand(serverEnvironment.setProviderSetupSharing);
  return async (target: SharedEnvironment) => {
    let source: Pick<SharedEnvironment, "settings" | "state"> | undefined = members
      .filter((member) => member.online)
      .toSorted((a, b) => b.state.version - a.state.version)[0];
    if (!source) {
      const founder = candidates.find(
        (entry) =>
          entry.environmentId === primaryEnvironmentId &&
          entry.environmentId !== target.environmentId,
      );
      if (!founder) return;
      const started = await setSharing({
        environmentId: founder.environmentId,
        input: { shared: true },
      });
      if (started._tag !== "Success") return;
      source = { settings: started.value, state: started.value.sharedProviderSetup! };
    }
    await apply({
      environmentId: target.environmentId,
      input: {
        instances: withoutSecretValues(source.settings as ServerSettings),
        version: source.state.version,
        changedAt: source.state.changedAt,
        expectedDigest: target.state.digest,
        join: true,
      },
    });
  };
}

function useStopSharing() {
  const setSharing = useAtomCommand(serverEnvironment.setProviderSetupSharing);
  return (environmentId: EnvironmentId) => setSharing({ environmentId, input: { shared: false } });
}

/** Stands in for the machine picker on Providers once anything shares a setup. */
export function SharedMachinesMenu({ fallback }: { readonly fallback: ReactNode }) {
  const { members, candidates, primaryEnvironmentId } = useSharedProviderSetup();
  const scope = useOptionalSettingsScope();
  const join = useJoinSharedSetup();
  const stop = useStopSharing();
  const selectedId = scope?.search.machine;
  const viewingOwnSetup =
    selectedId !== undefined && candidates.some((entry) => entry.environmentId === selectedId);
  if (members.length === 0) return fallback;
  const chosen = viewingOwnSetup
    ? candidates.find((entry) => entry.environmentId === selectedId)
    : null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="outline" size="sm" />}
        aria-label="Machines sharing this setup"
        className="min-w-0 max-w-72"
      >
        <span className="min-w-0 truncate">
          {chosen
            ? chosen.environment.label
            : members.length === 1
              ? "1 machine"
              : `all ${members.length} machines`}
        </span>
        <ChevronDownIcon
          aria-hidden
          strokeWidth={1.75}
          className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-[26rem] max-w-[calc(100vw-2rem)]">
        <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">Sharing one provider setup</p>
        {members.map((member) => (
          <MachineRow
            key={member.environmentId}
            entry={member}
            detail={
              member.online
                ? member.environmentId === primaryEnvironmentId
                  ? "This machine · up to date"
                  : "Online · up to date"
                : "Offline. It catches up when it's back"
            }
            action={
              <Button
                size="xs"
                variant="outline"
                disabled={!readEnvironmentScope(member.environmentId, AuthProvidersManageScope)}
                onClick={() => void stop(member.environmentId)}
              >
                Stop sharing
              </Button>
            }
            {...(viewingOwnSetup && scope
              ? { onSelect: () => scope.selectScope({ ...scope.search, machine: undefined }) }
              : {})}
          />
        ))}
        {candidates.length > 0 ? (
          <>
            <MenuSeparator />
            <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">
              Connected, using its own setup
            </p>
            {candidates.map((candidate) => (
              <MachineRow
                key={candidate.environmentId}
                entry={candidate}
                detail="Its providers are left alone until you choose"
                action={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      !readEnvironmentScope(candidate.environmentId, AuthProvidersManageScope)
                    }
                    onClick={() => void join(candidate)}
                  >
                    Use shared setup
                  </Button>
                }
                {...(scope
                  ? {
                      onSelect: () =>
                        scope.selectScope({ ...scope.search, machine: candidate.environmentId }),
                    }
                  : {})}
              />
            ))}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function MachineRow({
  entry,
  detail,
  action,
  onSelect,
}: {
  readonly entry: SharedEnvironment;
  readonly detail: string;
  readonly action: ReactNode;
  readonly onSelect?: () => void;
}) {
  const label = (
    <>
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(entry.environment.serverConfig)}
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm">{entry.environment.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-2 rounded-sm px-2 py-1.5">
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
        >
          {label}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      )}
      <span className="shrink-0">{action}</span>
    </div>
  );
}

const DISMISS_KEY = "t3:shared-provider-setup:dismissed";

const readDismissed = (): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

/** What taking the shared setup removes from a machine, by the name it has there. */
function providersOnlyOn(
  target: ServerSettings["providerInstances"],
  shared: ServerSettings["providerInstances"],
): ReadonlyArray<string> {
  const homeOf = (config: unknown) =>
    (config as { readonly homePath?: unknown } | null | undefined)?.homePath;
  return Object.entries(target)
    .filter(
      ([id, instance]) =>
        !Object.hasOwn(shared, id) &&
        !Object.values(shared).some(
          (candidate) =>
            candidate.driver === instance.driver &&
            homeOf(candidate.config) !== undefined &&
            homeOf(candidate.config) === homeOf(instance.config),
        ),
    )
    .map(([id, instance]) => instance.displayName ?? id);
}

export function SharedSetupBanners() {
  const { members, candidates, primaryEnvironmentId, failures } = useSharedProviderSetup();
  const join = useJoinSharedSetup();
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = (id: EnvironmentId) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      // Remembering this is a convenience; the banner just returns next time.
    }
  };
  const founder = candidates.find((entry) => entry.environmentId === primaryEnvironmentId);
  const sharedSetup = members[0]?.settings ?? founder?.settings;
  const offered = candidates.filter(
    (entry) =>
      entry.online &&
      !dismissed.includes(entry.environmentId) &&
      entry.environmentId !== (members.length === 0 ? primaryEnvironmentId : null) &&
      sharedSetup !== undefined,
  );
  const failedMembers = members.filter((member) => failures.has(member.environmentId));
  if (offered.length === 0 && failedMembers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {failedMembers.map((member) => (
        <Alert key={member.environmentId} variant="error">
          <AlertTitle>{member.environment.label} didn't take your last change</AlertTitle>
          <AlertDescription>{failures.get(member.environmentId)}</AlertDescription>
        </Alert>
      ))}
      {offered.map((entry) => {
        const removed = providersOnlyOn(
          entry.settings.providerInstances,
          sharedSetup!.providerInstances,
        );
        return (
          <Alert key={entry.environmentId}>
            <AlertTitle>
              {entry.environment.label} is connected but has its own provider setup.
            </AlertTitle>
            <AlertDescription>
              Using the shared setup replaces its providers. Its sign-ins are kept.
              {removed.length > 0 ? ` Removes ${removed.join(", ")}.` : ""}
              {readEnvironmentScope(entry.environmentId, AuthProvidersManageScope)
                ? ""
                : " This connection can't manage its providers."}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => dismiss(entry.environmentId)}>
                Not now
              </Button>
              <Button
                size="xs"
                disabled={!readEnvironmentScope(entry.environmentId, AuthProvidersManageScope)}
                onClick={() => void join(entry)}
              >
                Use shared setup
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </div>
  );
}

/** The line under a provider in the list: which machine, if any, it can't run on. */
export function useSharedInstanceSummary(instanceId: ProviderInstanceId | null, enabled: boolean) {
  const { members } = useSharedProviderSetup();
  const providers = useEnvironmentProviders();
  if (instanceId === null) return null;
  if (!enabled) return { text: "Disabled", problem: false };
  const notSignedIn: string[] = [];
  const missingKey: string[] = [];
  let plan: string | undefined;
  let allSignedIn = true;
  let loaded = true;
  for (const member of members) {
    if (!member.online) continue;
    const provider = providers
      .get(member.environmentId)
      ?.find((candidate) => candidate.instanceId === instanceId);
    if ((member.state.missingSecrets?.[instanceId]?.length ?? 0) > 0) {
      missingKey.push(member.environment.label);
    } else if (provider?.auth.status === "unauthenticated") {
      notSignedIn.push(member.environment.label);
    }
    if (provider === undefined) loaded = false;
    if (provider?.auth.status !== "authenticated") allSignedIn = false;
    plan ??= provider?.auth.label;
  }
  if (missingKey.length > 0) {
    return { text: `API key missing on ${missingKey.join(", ")}`, problem: true };
  }
  if (notSignedIn.length > 0) {
    return { text: `Not signed in on ${notSignedIn.join(", ")}`, problem: true };
  }
  if (!loaded) return { text: "Checking each machine…", problem: false };
  // Providers without a sign-in report an unknown status.
  if (!allSignedIn) return { text: "Ready everywhere", problem: false };
  return {
    text: plan ? `Signed in everywhere · ${plan}` : "Signed in everywhere",
    problem: false,
  };
}
