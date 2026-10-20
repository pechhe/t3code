import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { pickPoolMember } from "@t3tools/shared/providerPools";
import type { CSSProperties } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "~/hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { DeviceUnit } from "./device/DeviceUnit";

interface PoolAccount {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly color: string | undefined;
}

export interface ComposerPoolAccountState {
  /** The account the next turn on the pool runs on. */
  readonly next: PoolAccount;
  /** The account new threads use first, or null when the pool picks. */
  readonly preferred: PoolAccount | null;
  /** The preference a click moves to: Auto, then each account in turn, then Auto. */
  readonly following: PoolAccount | null;
  /** The pool picks by the user's own account order rather than by spending allowance. */
  readonly ordered: boolean;
  readonly cycle: () => void;
}

const toAccount = (provider: ServerProvider): PoolAccount => ({
  instanceId: provider.instanceId,
  name: provider.displayName ?? provider.instanceId,
  color: provider.accentColor,
});

/**
 * When the composer is on an account pool: which account the next turn uses,
 * mirroring the server's routing, and a way to change the pool's preferred account.
 * `current` is the account the thread already runs on; a draft has none.
 */
export function useComposerPoolAccount(input: {
  environmentId: EnvironmentId;
  selectedInstanceId: ProviderInstanceId;
  providers: ReadonlyArray<ServerProvider>;
  current: ProviderInstanceId | undefined;
}): ComposerPoolAccountState | null {
  const poolConfig = useEnvironmentSettings(
    input.environmentId,
    (settings) => settings.providerInstances?.[input.selectedInstanceId],
  );
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    input.environmentId,
  );
  // Ticks each minute, so the prediction moves on when an allowance resets.
  const nowMinute = useNowMinute();
  const pool = input.providers.find((provider) => provider.instanceId === input.selectedInstanceId);
  const memberIds = pool?.poolMembers;
  if (pool === undefined || memberIds === undefined || poolConfig?.pool === undefined) return null;
  const disabledMembers = pool.poolPolicy?.disabledMembers ?? [];
  const members = memberIds.flatMap((id) => {
    if (disabledMembers.includes(id)) return [];
    const provider = input.providers.find((candidate) => candidate.instanceId === id);
    return provider === undefined ? [] : [provider];
  });
  const nextId = pickPoolMember({
    pool: {
      driver: pool.driver,
      members: memberIds,
      preferredMember: pool.poolPreferredMember,
      policy: pool.poolPolicy,
    },
    providers: input.providers,
    nowMs: Date.parse(`${nowMinute}Z`),
    current: input.current,
  });
  const next = members.find((member) => member.instanceId === nextId) ?? members[0];
  if (next === undefined) return null;
  const preferredIndex = members.findIndex(
    (member) => member.instanceId === pool.poolPreferredMember,
  );
  const preferred = preferredIndex < 0 ? null : members[preferredIndex]!;
  const followingProvider = members[preferredIndex + 1] ?? null;
  const following = followingProvider === null ? null : toAccount(followingProvider);
  const config: ProviderInstanceConfig = poolConfig;

  return {
    next: toAccount(next),
    preferred: preferred === null ? null : toAccount(preferred),
    following,
    ordered: pool.poolPolicy?.strategy === "order",
    cycle: () => {
      const { preferredMember: _previous, ...rest } = config;
      void persistProviderInstance({
        operation: "upsert",
        instanceId: input.selectedInstanceId,
        instance: following === null ? rest : { ...rest, preferredMember: following.instanceId },
      });
    },
  };
}

function poolAccountTooltip(state: ComposerPoolAccountState, isNew: boolean): string {
  const target = isNew ? "This thread" : "The next message";
  const now =
    state.preferred === null
      ? `${target} uses ${state.next.name}, ${
          state.ordered
            ? "the first account in your order with usage left."
            : "picked to spend allowance before it resets."
        }`
      : state.preferred.instanceId === state.next.instanceId
        ? `${target} uses ${state.next.name}, the preferred account.`
        : `${target} stays on ${state.next.name}; new threads use ${state.preferred.name}.`;
  const click =
    state.following === null
      ? "Click to let the pool pick the account."
      : `Click to prefer ${state.following.name}.`;
  return `${now} ${click}`;
}

/**
 * The pooled account in the composer: the account the next turn uses, in its colour,
 * and a click to cycle the account the pool prefers for new threads.
 */
export function ComposerPoolAccount(props: {
  state: ComposerPoolAccountState;
  isNew: boolean;
  size?: ComposerControlSize;
  /** Render as a lamp cap on the machined composer, the account's name engraved beneath. */
  device?: boolean;
}) {
  const { state } = props;
  const tooltip = poolAccountTooltip(state, props.isNew);
  const light = { "--account-light": state.next.color ?? "currentColor" } as CSSProperties;

  if (props.device) {
    return (
      <DeviceUnit caption={state.next.name}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="device-cap device-cap--account"
                style={light}
                aria-label={tooltip}
                aria-pressed={state.preferred !== null}
                onPointerDown={(event) => event.preventDefault()}
                onClick={state.cycle}
              />
            }
          >
            <span className="device-cap__lamp" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">{tooltip}</TooltipPopup>
        </Tooltip>
      </DeviceUnit>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={props.size ?? "sm"}
            className="shrink-0 whitespace-nowrap"
            style={light}
            aria-label={tooltip}
            onClick={state.cycle}
          />
        }
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-(--account-light)" />
        {state.next.name}
        {state.preferred === null ? <span className="text-muted-foreground/70">auto</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
