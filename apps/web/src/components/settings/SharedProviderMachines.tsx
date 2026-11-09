import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsRow } from "./settingsLayout";
import { type SharedEnvironment, useSharedProviderSetup } from "./SharedProviderSetup";

/** A row per machine: its sign-in and secrets, the two things that can't be shared. */
export function SharedProviderMachines({
  instanceId,
  readOnly,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}) {
  const { members } = useSharedProviderSetup();
  const providers = useEnvironmentProviders();
  return (
    <>
      {members.map((member) => (
        <SharedMachineRow
          key={member.environmentId}
          member={member}
          instanceId={instanceId}
          provider={providers
            .get(member.environmentId)
            ?.find((candidate) => candidate.instanceId === instanceId)}
          readOnly={readOnly}
        />
      ))}
    </>
  );
}

function SharedMachineRow({
  member,
  instanceId,
  provider,
  readOnly,
}: {
  readonly member: SharedEnvironment;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const label = member.environment.label;
  const canManage = useEnvironmentScope(member.environmentId, AuthProvidersManageScope);
  const missing = member.state.missingSecrets?.[instanceId] ?? [];
  if (!member.online) {
    return <SettingsRow title={label} description="Offline. It catches up when it's back." />;
  }
  if (!canManage) {
    return (
      <SettingsRow
        title={label}
        description="This connection can't manage providers on this machine."
      />
    );
  }
  if (missing.length > 0) {
    return (
      <>
        {missing.map((name) =>
          name === "credential" ? (
            <SettingsRow
              key={name}
              title={label}
              description={
                <span className="text-destructive">
                  A saved credential isn't set on this machine.
                </span>
              }
            />
          ) : (
            <MissingKeyRow
              key={name}
              member={member}
              instanceId={instanceId}
              variable={name}
              readOnly={readOnly}
            />
          ),
        )}
      </>
    );
  }
  if (!provider) {
    return <SettingsRow title={label} description="Setting up this provider…" />;
  }
  if (!provider.installed) {
    return (
      <SettingsRow
        title={label}
        description={
          <span className="text-destructive">
            {provider.message ?? "Not installed on this machine."}
          </span>
        }
      />
    );
  }
  if (provider.setup?.canAuthenticate) {
    return (
      <ProviderAuthenticationSection
        key={`${member.environmentId}:${instanceId}`}
        environmentId={member.environmentId}
        environmentLabel={label}
        instanceId={instanceId}
        provider={provider}
        readOnly={readOnly}
        title={label}
      />
    );
  }
  return (
    <SettingsRow
      title={label}
      description={
        provider.auth.status === "unauthenticated" ? (
          <span className="text-destructive">Not signed in. This provider can't run here.</span>
        ) : provider.auth.status === "authenticated" ? (
          `Signed in${provider.auth.label ? ` · ${provider.auth.label}` : ""}`
        ) : (
          "Ready."
        )
      }
    />
  );
}

function MissingKeyRow({
  member,
  instanceId,
  variable,
  readOnly,
}: {
  readonly member: SharedEnvironment;
  readonly instanceId: ProviderInstanceId;
  readonly variable: string;
  readonly readOnly: boolean;
}) {
  const persist = usePersistEnvironmentProviderInstanceMutation(member.environmentId);
  const [value, setValue] = useState("");
  const instance = member.settings.providerInstances[instanceId];
  const save = () => {
    if (!instance || !value) return;
    void persist({
      operation: "upsert",
      instanceId,
      instance: {
        ...instance,
        environment: (instance.environment ?? []).map((entry) => {
          if (entry.name !== variable) return entry;
          const { valueRedacted: _set, ...rest } = entry;
          return { ...rest, value, sensitive: true };
        }),
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setValue("");
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not add ${variable} on ${member.environment.label}`,
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    });
  };
  return (
    <SettingsRow
      title={member.environment.label}
      description={<span className="text-destructive">{variable} isn't set on this machine.</span>}
      control={
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            size="sm"
            aria-label={`${variable} on ${member.environment.label}`}
            value={value}
            disabled={readOnly}
            onChange={(event) => setValue(event.target.value)}
            className="w-40"
          />
          <Button size="sm" variant="outline" disabled={readOnly || !value} onClick={save}>
            Add key
          </Button>
        </div>
      }
    />
  );
}
