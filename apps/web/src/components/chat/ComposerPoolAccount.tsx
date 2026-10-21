import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { pickPoolMember, pickPoolSwitchMember } from "@t3tools/shared/providerPools";
import type { CSSProperties } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { momentaryKeyProps } from "~/lib/interfaceSounds";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "~/hooks/useSettings";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
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
  /**
   * What a click does. On a thread that has run, it moves the thread to this
   * account (null: no other account has usage left). On a new thread it moves
   * the pool's preference: Auto, then each account in turn, then Auto.
   */
  readonly following: PoolAccount | null;
  /** The thread has run, so a click switches its account instead of the preference. */
  readonly started: boolean;
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
  /** The thread a started composer switches; its selection keeps the model and options. */
  thread: { readonly id: ThreadId; readonly modelSelection: ModelSelection } | undefined;
}): ComposerPoolAccountState | null {
  // The draft's choice can name a member once a thread has run, since the server stores the
  // member a pooled turn ran on; a started thread finds its pool through that member.
  const pool =
    input.providers.find(
      (provider) =>
        provider.instanceId === input.selectedInstanceId && provider.poolMembers !== undefined,
    ) ??
    (input.current === undefined
      ? undefined
      : input.providers.find((provider) => provider.poolMembers?.includes(input.current!)));
  const poolConfig = useEnvironmentSettings(input.environmentId, (settings) =>
    pool === undefined ? undefined : settings.providerInstances?.[pool.instanceId],
  );
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    input.environmentId,
  );
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread account switch",
  );
  // Ticks each minute, so the prediction moves on when an allowance resets.
  const nowMinute = useNowMinute();
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
  const started = input.current !== undefined && input.thread !== undefined;
  const followingId = started
    ? pickPoolSwitchMember({
        pool: {
          driver: pool.driver,
          members: memberIds,
          preferredMember: pool.poolPreferredMember,
          policy: pool.poolPolicy,
        },
        providers: input.providers,
        nowMs: Date.parse(`${nowMinute}Z`),
        current: next.instanceId,
      })
    : members[preferredIndex + 1]?.instanceId;
  const followingProvider = members.find((member) => member.instanceId === followingId);
  const following = followingProvider === undefined ? null : toAccount(followingProvider);
  const config: ProviderInstanceConfig = poolConfig;

  return {
    next: toAccount(next),
    preferred: preferred === null ? null : toAccount(preferred),
    following,
    started,
    ordered: pool.poolPolicy?.strategy === "order",
    cycle: () => {
      if (started) {
        if (following === null || input.thread === undefined) return;
        void updateThreadMetadata({
          environmentId: input.environmentId,
          input: {
            threadId: input.thread.id,
            modelSelection: { ...input.thread.modelSelection, instanceId: following.instanceId },
          },
        });
        return;
      }
      const { preferredMember: _previous, ...rest } = config;
      void persistProviderInstance({
        operation: "upsert",
        instanceId: pool.instanceId,
        instance: following === null ? rest : { ...rest, preferredMember: following.instanceId },
      });
    },
  };
}

function poolAccountTooltip(state: ComposerPoolAccountState, isNew: boolean): string {
  if (state.started) {
    return state.following === null
      ? `This thread uses ${state.next.name}. No other account has usage left.`
      : `This thread uses ${state.next.name}. Click to switch it to ${state.following.name}.`;
  }
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
                aria-pressed={state.started ? undefined : state.preferred !== null}
                disabled={state.started && state.following === null}
                {...momentaryKeyProps(state.cycle)}
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
            disabled={state.started && state.following === null}
            onClick={state.cycle}
          />
        }
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-(--account-light)" />
        {state.next.name}
        {state.started || state.preferred !== null ? null : (
          <span className="text-muted-foreground/70">auto</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
