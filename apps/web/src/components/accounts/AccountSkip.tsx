import {
  AuthProvidersManageScope,
  type AccountId,
  type AccountSkip,
  type EnvironmentId,
  type PooledModelKey,
} from "@t3tools/contracts";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { activeSkip, activeSkipsOf, type AccountInfo } from "@t3tools/shared/accountPools";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings, usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Where an account lives: the provider's name, or the Pi instance holding a sub-provider. */
export const accountSource = (account: AccountInfo) =>
  account.source === account.driver
    ? (providerClients.get(account.driver)?.label ?? account.source)
    : account.source;

/**
 * The skip that keeps an account longest: for one model when `model` is given, else across
 * every model it ran out on.
 */
export function useAccountSkip(
  environmentId: EnvironmentId,
  account: AccountId,
  model?: PooledModelKey,
): AccountSkip | undefined {
  const skips = useEnvironmentSettings(environmentId, (settings) => settings.accountSkips);
  // Ticks each minute, so a skip drops out when it ends.
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  if (model !== undefined) return activeSkip(skips, account, model, nowMs);
  return activeSkipsOf(skips, account, nowMs)
    .map(([, skip]) => skip)
    .reduce<AccountSkip | undefined>(
      (latest, skip) =>
        latest === undefined || Date.parse(skip.until) > Date.parse(latest.until) ? skip : latest,
      undefined,
    );
}

/** "skipped until 13:40": why T3 is passing an account over, and for how long. */
export function AccountSkipBadge({ skip }: { skip: AccountSkip }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const until = formatUpcomingTimestamp(skip.until, timestampFormat);
  return (
    <Badge
      variant="warning"
      size="sm"
      title={
        skip.reportedReset
          ? `Out of usage. The provider reported it resets at ${until}.`
          : `Out of usage. No reset was reported, so T3 tries it again at ${until}.`
      }
    >
      skipped until {until}
    </Badge>
  );
}

/** Clears an account's skips, so new threads may start on it at once. */
export function TryAgainNowButton({
  environmentId,
  account,
}: {
  environmentId: EnvironmentId;
  account: AccountId;
}) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "try account again",
  });
  const [saving, setSaving] = useState(false);
  if (!canManage) return null;
  return (
    <Button
      size="compact"
      variant="outline"
      disabled={saving}
      onClick={() => {
        setSaving(true);
        void updateSettings({
          environmentId,
          input: { patch: { accountSkips: { [account]: null } } },
        }).finally(() => setSaving(false));
      }}
    >
      Try again now
    </Button>
  );
}

/** One account a Usage card reads, by the routing account its turns run on. */
export interface SkippableAccountRoute {
  readonly environmentId: EnvironmentId;
  readonly accountId: AccountId;
  readonly label: string;
}

function SkippedAccountLine({ route }: { route: SkippableAccountRoute }) {
  const skip = useAccountSkip(route.environmentId, route.accountId);
  if (skip === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-foreground">{route.label}</span>
      <AccountSkipBadge skip={skip} />
      <TryAgainNowButton environmentId={route.environmentId} account={route.accountId} />
    </div>
  );
}

/** The skipped accounts among a card's, each with until when and Try again now. */
export function SkippedAccounts({ routes }: { routes: ReadonlyArray<SkippableAccountRoute> }) {
  const unique = routes.filter(
    (route, index) =>
      routes.findIndex(
        (other) =>
          other.environmentId === route.environmentId && other.accountId === route.accountId,
      ) === index,
  );
  return (
    <>
      {unique.map((route) => (
        <SkippedAccountLine key={`${route.environmentId}/${route.accountId}`} route={route} />
      ))}
    </>
  );
}
