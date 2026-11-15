import type { ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { REMEMBERED_LIMIT_WINDOW_ID } from "@t3tools/shared/providerPools";

import { useNowMinute } from "../../hooks/useNowMinute";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId, useEnvironmentProviders } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function isSlotCooled(
  provider: ServerProvider | undefined,
  accountKey: string,
  nowMs: number,
): boolean {
  const slot = provider?.usageSlots?.find((candidate) => candidate.accountKey === accountKey);
  const cooldown = slot?.usageLimits.windows.find(
    (window) => window.id === REMEMBERED_LIMIT_WINDOW_ID,
  );
  return cooldown?.resetsAt !== undefined && Date.parse(cooldown.resetsAt) > nowMs;
}

export function UsageSlotClearCooldown({ slotId }: { readonly slotId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId === null ? [] : (providersByEnvironment.get(environmentId) ?? []);
  const slot = providers.flatMap((provider) =>
    (provider.usageSlots ?? [])
      .filter((candidate) => `${provider.instanceId}:${candidate.accountKey}` === slotId)
      .map((candidate) => ({ provider, candidate })),
  )[0];
  const clearUsageLimit = useAtomCommand(serverEnvironment.clearUsageLimit, {
    reportFailure: false,
  });
  const canManageProviders = useAtomValue(
    serverEnvironment.clearUsageLimit.permissionAtom(environmentId),
  );
  const [clearing, setClearing] = useState(false);
  // The cooldown expires on its own; the shared minute tick keeps the button from outliving it.
  const nowMs = Date.parse(useNowMinute());

  if (
    !slot ||
    !isSlotCooled(slot.provider, slot.candidate.accountKey, nowMs) ||
    !canManageProviders
  )
    return null;

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={clearing || environmentId === null}
      onClick={async () => {
        if (environmentId === null || clearing) return;
        setClearing(true);
        try {
          await clearUsageLimit({
            environmentId,
            input: {
              instanceId: slot.provider.instanceId,
              accountKey: slot.candidate.accountKey,
            },
          });
        } finally {
          setClearing(false);
        }
      }}
    >
      Clear cooldown
    </Button>
  );
}
