import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  explainPoolPick,
  pickPoolMember,
  pickPoolSwitchMember,
  type AccountStanding,
  type PoolPickReason,
} from "@t3tools/shared/providerPools";
import type { CSSProperties } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { useNowMinute } from "~/hooks/useNowMinute";
import { momentaryKeyProps } from "~/lib/interfaceSounds";
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

interface PoolAccountRow {
  readonly account: PoolAccount;
  readonly standing: AccountStanding;
  /** Of the account's most used window that has not reset. */
  readonly percentLeft?: number | undefined;
  readonly resetsAtMs?: number | undefined;
  readonly outUntilMs?: number | undefined;
}

export interface ComposerPoolAccountState {
  /** The pool's own instance, where the model slider stays whichever account the lamp shows. */
  readonly pool: ProviderInstanceId;
  /** The account the next turn on the pool runs on. */
  readonly next: PoolAccount;
  /** The account Auto would use; a new thread's per-thread choice leaves it unchanged. */
  readonly auto: PoolAccount;
  /** A new thread set to one account with the lamp, instead of the pool's automatic pick. */
  readonly chosen: boolean;
  /** The thread has run, so a click switches its account. */
  readonly started: boolean;
  /** Why the pool picks `next`, from the same rule the server routes by. */
  readonly reason: PoolPickReason;
  /** Every account in the pool is out; the lamp goes dark until the first returns. */
  readonly outUntilMs: number | undefined;
  /** Each account the pool can use, soonest back first when every one is out. */
  readonly accounts: ReadonlyArray<PoolAccountRow>;
  /**
   * What a click does. On a thread that has run, it moves the thread to this account (null: no
   * other account has usage left). On a new thread it walks Auto, each other account with usage
   * left, then Auto again (null: back to Auto).
   */
  readonly following: PoolAccount | null;
  /** On a new thread on Auto, no other account has usage left, so a click does nothing. */
  readonly stuck: boolean;
  readonly nowMs: number;
  readonly cycle: () => void;
  /** Where a model choice lands: a new thread keeps its chosen account when that account offers the model. */
  readonly keepAccount: (instanceId: ProviderInstanceId, model: string) => ProviderInstanceId;
}

const toAccount = (provider: ServerProvider): PoolAccount => ({
  instanceId: provider.instanceId,
  name: provider.displayName ?? provider.instanceId,
  color: provider.accentColor,
});

const tightestWindow = (provider: ServerProvider, nowMs: number) =>
  (provider.usageLimits?.windows ?? [])
    .filter((window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs)
    .toSorted((a, b) => b.usedPercent - a.usedPercent)[0];

/**
 * When the composer is on an account pool: which account the next turn uses and why,
 * mirroring the server's routing. On a new thread a click chooses the account for that thread
 * only; on a thread that has run it switches the thread's account.
 * `current` is the account the thread already runs on; a draft has none.
 */
export function useComposerPoolAccount(input: {
  environmentId: EnvironmentId;
  /** The composer's selection: the pool, or on a new thread a member the lamp chose. */
  selection: ModelSelection;
  /** The draft the lamp writes a new thread's choice to. */
  draftTarget: ComposerThreadTarget;
  providers: ReadonlyArray<ServerProvider>;
  current: ProviderInstanceId | undefined;
  /** The thread a started composer switches; its selection keeps the model and options. */
  thread: { readonly id: ThreadId; readonly modelSelection: ModelSelection } | undefined;
}): ComposerPoolAccountState | null {
  const started = input.current !== undefined && input.thread !== undefined;
  const selectedId = input.selection.instanceId;
  // A started thread, and a new thread the lamp set to one account, find their pool through
  // the member they name, since the server stores the member a pooled turn runs on.
  const memberId = started ? input.current : selectedId;
  const pool =
    input.providers.find(
      (provider) => provider.instanceId === selectedId && provider.poolMembers !== undefined,
    ) ??
    (memberId === undefined
      ? undefined
      : input.providers.find((provider) => provider.poolMembers?.includes(memberId)));
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread account switch",
  );
  // Ticks each minute, so the prediction moves on when an allowance resets.
  const nowMinute = useNowMinute();
  const memberIds = pool?.poolMembers;
  if (pool === undefined || memberIds === undefined) return null;
  const nowMs = Date.parse(`${nowMinute}Z`);
  const route = { driver: pool.driver, members: memberIds, policy: pool.poolPolicy };
  const pick = explainPoolPick({ pool: route, providers: input.providers, nowMs });
  if (pick === undefined) return null;
  const chosenMember =
    !started && selectedId !== pool.instanceId
      ? pick.accounts.find((entry) => entry.provider.instanceId === selectedId)
      : undefined;
  const nextId = started
    ? pickPoolMember({ pool: route, providers: input.providers, nowMs, current: input.current })
    : (chosenMember?.provider.instanceId ?? pick.member.instanceId);
  const nextProvider =
    pick.accounts.find((entry) => entry.provider.instanceId === nextId)?.provider ?? pick.member;
  const allOut = pick.reason === "all-out";
  const rows = pick.accounts.map((entry): PoolAccountRow => {
    const window = tightestWindow(entry.provider, nowMs);
    return {
      account: toAccount(entry.provider),
      standing: entry.standing,
      ...(entry.standing === "available" && window !== undefined
        ? {
            percentLeft: Math.max(0, Math.round(100 - window.usedPercent)),
            resetsAtMs: window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt),
          }
        : {}),
      ...(entry.standing === "out" ? { outUntilMs: entry.outUntilMs } : {}),
    };
  });
  // The walk a new thread's clicks take: each account with usage left that Auto would not pick.
  const choices = pick.accounts
    .filter(
      (entry) => entry.standing !== "out" && entry.provider.instanceId !== pick.member.instanceId,
    )
    .map((entry) => entry.provider);
  const followingProvider = started
    ? input.providers.find(
        (provider) =>
          provider.instanceId ===
          pickPoolSwitchMember({
            pool: route,
            providers: input.providers,
            nowMs,
            current: nextProvider.instanceId,
          }),
      )
    : chosenMember === undefined
      ? choices[0]
      : choices[choices.findIndex((provider) => provider === chosenMember.provider) + 1];
  const following = followingProvider === undefined ? null : toAccount(followingProvider);

  return {
    pool: pool.instanceId,
    next: toAccount(nextProvider),
    auto: toAccount(started ? nextProvider : pick.member),
    chosen: chosenMember !== undefined,
    started,
    reason: pick.reason,
    outUntilMs: allOut ? pick.accounts[0]?.outUntilMs : undefined,
    accounts: allOut
      ? rows.toSorted((a, b) => (a.outUntilMs ?? Infinity) - (b.outUntilMs ?? Infinity))
      : rows,
    following,
    stuck: !started && chosenMember === undefined && following === null,
    nowMs,
    keepAccount: (instanceId, model) =>
      chosenMember !== undefined &&
      instanceId === pool.instanceId &&
      chosenMember.provider.models.some((option) => option.slug === model)
        ? chosenMember.provider.instanceId
        : instanceId,
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
      if (chosenMember === undefined && following === null) return;
      // The choice lives in this thread's draft alone; the pool's settings never change.
      useComposerDraftStore
        .getState()
        .setModelSelection(
          input.draftTarget,
          { ...input.selection, instanceId: following?.instanceId ?? pool.instanceId },
          { explicit: true },
        );
    },
  };
}

/** A time in the viewer's zone: "17:30 GMT" today, "Thu 09:00 GMT" within the week. */
function formatPoolTime(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date(nowMs).toDateString();
  const withinWeek = ms - nowMs < 6 * 24 * 60 * 60 * 1000;
  const parts = new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : withinWeek ? { weekday: "short" } : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const day = sameDay
    ? undefined
    : withinWeek
      ? part("weekday")
      : `${part("day")} ${part("month")}`;
  return [day, `${part("hour")}:${part("minute")}`, part("timeZoneName")]
    .filter((entry) => entry !== undefined)
    .join(" ");
}

function rowText(row: PoolAccountRow, nowMs: number): string {
  if (row.standing === "out") {
    return row.outUntilMs === undefined || !Number.isFinite(row.outUntilMs)
      ? "out of usage"
      : `out until ${formatPoolTime(row.outUntilMs, nowMs)}`;
  }
  if (row.standing === "unknown" || row.percentLeft === undefined) return "usage unknown";
  return row.resetsAtMs === undefined
    ? `${row.percentLeft}% left`
    : `${row.percentLeft}% left · resets ${formatPoolTime(row.resetsAtMs, nowMs)}`;
}

const REASONS: Record<Exclude<PoolPickReason, "all-out">, string> = {
  "lapses-soonest": "Its unspent allowance lapses soonest.",
  "pool-order": "It is the first account in your order with usage left.",
  "only-available": "It is the only account with usage left.",
  "no-reading": "No account has a usage reading yet, so your order decides.",
};

/** The tooltip's lines: a headline, a reason, one row per account and what a click does. */
function poolAccountTooltip(state: ComposerPoolAccountState) {
  const name = state.next.name;
  const rows = (
    state.chosen
      ? state.accounts.filter((row) => row.account.instanceId === state.next.instanceId)
      : state.accounts
  ).map((row) => ({ name: row.account.name, text: rowText(row, state.nowMs) }));
  if (state.outUntilMs !== undefined && !state.chosen) {
    return {
      headline: "Every account in this pool is out of usage.",
      reason: "A message sent now waits for the first reset.",
      rows,
      action: null,
    };
  }
  if (state.started) {
    return {
      headline: `This thread uses ${name}.`,
      reason: null,
      rows,
      action:
        state.following === null
          ? "No other account has usage left."
          : `Click to switch it to ${state.following.name}.`,
    };
  }
  if (state.chosen) {
    return {
      headline: `You set this thread to ${name}.`,
      reason: "Other threads still pick automatically.",
      rows,
      action:
        state.following === null
          ? "Click to return to Auto."
          : `Click to use ${state.following.name} for this thread.`,
    };
  }
  return {
    headline: `Auto: this thread uses ${name}.`,
    reason: REASONS[state.reason === "all-out" ? "only-available" : state.reason],
    rows,
    action:
      state.following === null
        ? "No other account to switch to."
        : `Click to use ${state.following.name} for this thread.`,
  };
}

function PoolAccountTooltipBody(props: { tooltip: ReturnType<typeof poolAccountTooltip> }) {
  const { tooltip } = props;
  return (
    <div className="flex max-w-72 flex-col gap-1">
      <p>
        <span className="font-medium">{tooltip.headline}</span>
        {tooltip.reason === null ? null : ` ${tooltip.reason}`}
      </p>
      {tooltip.rows.map((row) => (
        <p key={row.name} className="flex justify-between gap-3 opacity-85">
          <span>{row.name}</span>
          <span>{row.text}</span>
        </p>
      ))}
      {tooltip.action === null ? null : <p className="opacity-70">{tooltip.action}</p>}
    </div>
  );
}

const tooltipLabel = (tooltip: ReturnType<typeof poolAccountTooltip>) =>
  [
    tooltip.headline,
    tooltip.reason,
    ...tooltip.rows.map((row) => `${row.name}: ${row.text}.`),
    tooltip.action,
  ]
    .filter((part) => part !== null)
    .join(" ");

/**
 * The pooled account in the composer: the account the next turn uses, in its colour, ringed
 * when the user chose it for this thread and dark when every account is out.
 */
export function ComposerPoolAccount(props: {
  state: ComposerPoolAccountState;
  size?: ComposerControlSize;
  /** Render as a lamp cap on the machined composer, the account's name engraved beneath. */
  device?: boolean;
}) {
  const { state } = props;
  const tooltip = poolAccountTooltip(state);
  const label = tooltipLabel(tooltip);
  const dark = state.outUntilMs !== undefined && !state.chosen;
  const light = { "--account-light": state.next.color ?? "currentColor" } as CSSProperties;
  const disabled = state.started ? state.following === null : state.stuck;
  const until =
    state.outUntilMs === undefined || !Number.isFinite(state.outUntilMs)
      ? undefined
      : `until ${formatPoolTime(state.outUntilMs, state.nowMs)}`;

  if (props.device) {
    return (
      <DeviceUnit
        caption={dark ? "no usage" : state.next.name}
        {...(dark
          ? until === undefined
            ? {}
            : { detail: until }
          : state.chosen
            ? { detail: "this thread" }
            : {})}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="device-cap device-cap--account"
                style={light}
                aria-label={label}
                aria-pressed={state.started ? undefined : state.chosen}
                data-out={dark || undefined}
                // Not `disabled`: a disabled button opens no tooltip, and the tooltip explains why.
                aria-disabled={disabled || undefined}
                {...momentaryKeyProps(state.cycle)}
              />
            }
          >
            <span className="device-cap__lamp" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PoolAccountTooltipBody tooltip={tooltip} />
          </TooltipPopup>
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
            aria-label={label}
            aria-disabled={disabled || undefined}
            onClick={state.cycle}
          />
        }
      >
        <span
          aria-hidden="true"
          className={
            dark
              ? "size-2 rounded-full bg-muted-foreground/40"
              : state.chosen
                ? "size-2 rounded-full bg-(--account-light) ring-1 ring-(--account-light) ring-offset-1 ring-offset-background"
                : "size-2 rounded-full bg-(--account-light)"
          }
        />
        {dark ? "no usage" : state.next.name}
        {dark ? (
          until === undefined ? null : (
            <span className="text-muted-foreground/70">{until}</span>
          )
        ) : state.started ? null : (
          <span className="text-muted-foreground/70">{state.chosen ? "this thread" : "auto"}</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <PoolAccountTooltipBody tooltip={tooltip} />
      </TooltipPopup>
    </Tooltip>
  );
}
