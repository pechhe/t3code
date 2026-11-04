import { useAtomValue } from "@effect/atom-react";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { BotIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** A subagent's harness logo, short model name and tokens, as one piece of a row. */
export function SubagentModelMeta(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver?: ProviderDriverKind | undefined;
  readonly model: string | null;
  readonly totalTokens?: number | undefined;
  readonly className?: string;
}) {
  const { providerInstanceId, model } = props;
  const providersAtom = serverEnvironment.providersValueAtom(props.environmentId);
  // Select strings; status pushes replace providers even when these fields are unchanged.
  const label = useAtomValue(
    providersAtom,
    (providers) =>
      resolveSubagentMetadata({
        model,
        provider: providers?.find((provider) => provider.instanceId === providerInstanceId),
      }).modelLabel,
  );
  const displayName = useAtomValue(
    providersAtom,
    (providers) => providers?.find((p) => p.instanceId === providerInstanceId)?.displayName,
  );
  const iconUrl = useAtomValue(
    providersAtom,
    (providers) => providers?.find((p) => p.instanceId === providerInstanceId)?.iconUrl,
  );
  const providerDriver = useAtomValue(
    providersAtom,
    (providers) => providers?.find((p) => p.instanceId === providerInstanceId)?.driver,
  );
  const driver = providerDriver ?? props.driver;
  return (
    <span
      className={cn(
        "hidden flex-none items-center gap-1.5 text-muted-foreground tabular-nums sm:inline-flex",
        props.className,
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={displayName ?? driver}
          acpRegistryIconUrl={iconUrl}
          className="z-auto"
          iconClassName="size-3 shrink-0"
        />
      ) : (
        <BotIcon aria-hidden className="size-3 shrink-0" />
      )}
      {label}
      {props.totalTokens === undefined ? null : ` · ${formatTokens(props.totalTokens)}`}
    </span>
  );
}
