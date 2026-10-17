import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useEnvironmentProviders } from "~/state/environments";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getDisplayModelName, getProviderRowLabel } from "./chat/providerIconUtils";

/**
 * A model named the way the composer's model picker names it: the model, then the
 * provider's icon and name in a quieter tone. Use it wherever a model is shown outside
 * that picker. A policy binding names only the provider kind, so `instanceId` is optional
 * and the kind's default instance stands in.
 */
export function ModelLabel(props: {
  environmentId: EnvironmentId | null;
  model: string;
  instanceId?: ProviderInstanceId | undefined;
  driverKind?: ProviderDriverKind | undefined;
  effort?: string | null | undefined;
  /** `chip`: a compact pill of the provider icon and model, for rows of several models. */
  variant?: "full" | "chip";
  className?: string | undefined;
}) {
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    props.environmentId === null ? null : (providersByEnvironment.get(props.environmentId) ?? null);
  const entry = useMemo(() => {
    const entries = deriveProviderInstanceEntries(providers ?? []);
    return (
      entries.find((candidate) => candidate.instanceId === props.instanceId) ??
      entries.find(
        (candidate) => candidate.driverKind === props.driverKind && candidate.isDefault,
      ) ??
      entries.find((candidate) => candidate.driverKind === props.driverKind)
    );
  }, [props.driverKind, props.instanceId, providers]);
  const model = entry?.models.find((candidate) => candidate.slug === props.model);
  const name = model ? getDisplayModelName(model) : formatModelSlugName(props.model);
  const driverKind = entry?.driverKind ?? props.driverKind;
  const icon = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={entry?.displayName ?? driverKind}
      acpRegistryAgentId={entry?.acpRegistryAgentId}
      acpRegistryIconUrl={entry?.acpRegistryIconUrl}
      className="size-3"
      iconClassName="size-3"
    />
  ) : null;
  if (props.variant === "chip") {
    return (
      <span
        className={cn(
          "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-1.5 text-xs",
          props.className,
        )}
      >
        {icon}
        <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
        {props.effort ? (
          <span className="shrink-0 text-muted-foreground">{props.effort}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}>
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
      {props.effort ? <span className="shrink-0 text-muted-foreground">{props.effort}</span> : null}
      {entry || driverKind ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground/70">
          {icon}
          {entry ? (
            <span className="min-w-0 truncate">
              {getProviderRowLabel(entry.displayName, model?.subProvider)}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
