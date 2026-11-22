import { useAtomValue } from "@effect/atom-react";
import {
  type AccountBlock,
  type AccountId,
  type EnvironmentId,
  type PooledModelKey,
} from "@t3tools/contracts";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import type {
  AccountAvailability,
  AccountInfo,
  RoutingContext,
} from "@t3tools/shared/accountPools";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const NO_BLOCKS: ReadonlyArray<AccountBlock> = [];

/** Where an account lives: the provider's name, or the Pi instance holding a credential. */
export const accountSource = (account: AccountInfo) =>
  account.source === account.driver
    ? (providerClients.get(account.driver)?.label ?? account.source)
    : account.source;

/**
 * What Model routing reads besides usage: the server's runtime blocks, at this minute. Ticks
 * each minute, so a block drops out when it ends.
 */
export function useRoutingContext(environmentId: EnvironmentId): RoutingContext {
  const query = useEnvironmentQuery(serverEnvironment.accountRouting({ environmentId, input: {} }));
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  return { blocks: query.data?.blocks ?? NO_BLOCKS, nowMs };
}

/** The blocks still in force for one account, across every model. */
const accountBlocksOf = (context: RoutingContext, account: AccountId) =>
  context.blocks.filter(
    (block) => block.account === account && Date.parse(block.until) > context.nowMs,
  );

const BACKOFF_CAUSE: Record<AccountBlock["reason"], string> = {
  "usage-limit": "usage",
  "rate-limit": "rate",
  overload: "overload",
};

/** "Reserved (9% ≤ 10%)", "Exhausted", "Cooling down after a rate limit": why an account waits. */
export function AccountStateBadge({
  availability,
  reserve,
}: {
  availability: AccountAvailability;
  reserve: number | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const until =
    availability.returnsAt === undefined
      ? undefined
      : formatUpcomingTimestamp(
          availability.returnsAt,
          timestampFormat,
          undefined,
          undefined,
          resolve,
        );
  switch (availability.state) {
    case "available":
      return null;
    case "exhausted":
      return (
        <Badge
          variant="error"
          size="sm"
          title={
            until === undefined ? gt("Out of usage.") : gt("Out of usage until {until}.", { until })
          }
        >
          {gt("Exhausted", { $context: "account usage state" })}
        </Badge>
      );
    case "reserved":
      return (
        <Badge
          variant="warning"
          size="sm"
          title={
            until === undefined
              ? gt("Held back for this model at its reserve.")
              : gt("Held back for this model at its reserve until {until}.", { until })
          }
        >
          {gt("Reserved ({remaining}% ≤ {reserve}%)", {
            remaining: Math.round(availability.remainingPercent ?? 0),
            reserve: reserve ?? 0,
          })}
        </Badge>
      );
    case "cooldown": {
      const block = availability.block;
      const cause = block === undefined ? "failure" : BACKOFF_CAUSE[block.reason];
      const reported = block?.reportedReset === true;
      return (
        <Badge
          variant="warning"
          size="sm"
          title={
            until === undefined
              ? reported
                ? gt("The provider reported when it resets.")
                : gt("No reset was reported, so T3 backs off and tries it again.")
              : reported
                ? gt("The provider reported it resets at {until}.", { until })
                : gt("No reset was reported, so T3 backs off and tries it again at {until}.", {
                    until,
                  })
          }
        >
          {until === undefined
            ? gt(
                "{cause, select, usage {Cooling down after a usage limit} rate {Cooling down after a rate limit} overload {Cooling down after an overload} other {Cooling down after a failed run}}",
                { cause },
              )
            : gt(
                "{cause, select, usage {Cooling down after a usage limit until {until}} rate {Cooling down after a rate limit until {until}} overload {Cooling down after an overload until {until}} other {Cooling down after a failed run until {until}}}",
                { cause, until },
              )}
        </Badge>
      );
    }
  }
}

/** Try now: clears an account's block for one model, or for every model, so work may start on it. */
export function TryNowButton({
  environmentId,
  account,
  model,
}: {
  environmentId: EnvironmentId;
  account: AccountId;
  model?: PooledModelKey;
}) {
  const canManage = useAtomValue(serverEnvironment.clearAccountBlock.permissionAtom(environmentId));
  const clear = useAtomCommand(serverEnvironment.clearAccountBlock, { label: "try account now" });
  const [saving, setSaving] = useState(false);
  if (!canManage) return null;
  return (
    <Button
      size="compact"
      variant="outline"
      disabled={saving}
      onClick={() => {
        setSaving(true);
        void clear({
          environmentId,
          input: model === undefined ? { account } : { account, model },
        }).finally(() => setSaving(false));
      }}
    >
      <T>Try now</T>
    </Button>
  );
}

/** One account a Usage card reads, by the routing account its turns run on. */
export interface RoutedAccountRoute {
  readonly environmentId: EnvironmentId;
  readonly accountId: AccountId;
  readonly label: string;
}

function BlockedAccountLine({ route }: { route: RoutedAccountRoute }) {
  const context = useRoutingContext(route.environmentId);
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const blocks = accountBlocksOf(context, route.accountId);
  if (blocks.length === 0) return null;
  const latest = blocks.reduce((a, b) => (Date.parse(b.until) > Date.parse(a.until) ? b : a));
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-foreground">{route.label}</span>
      <Badge variant="warning" size="sm">
        {gt("Cooling down for {models} until {until}", {
          models: blocks.map((block) => block.model).join(", "),
          until: formatUpcomingTimestamp(
            latest.until,
            timestampFormat,
            context.nowMs,
            undefined,
            resolve,
          ),
        })}
      </Badge>
      <TryNowButton environmentId={route.environmentId} account={route.accountId} />
    </div>
  );
}

/** The accounts among a card's that the server is holding back, each with Try now. */
export function BlockedAccounts({ routes }: { routes: ReadonlyArray<RoutedAccountRoute> }) {
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
        <BlockedAccountLine key={`${route.environmentId}/${route.accountId}`} route={route} />
      ))}
    </>
  );
}
