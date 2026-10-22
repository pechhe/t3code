import {
  WS_METHODS,
  type BuildWorkItemCard,
  type BuildWorkItemSession,
  type BuildWorkItemSummary,
  type BuildWorkItemView,
  type BuildWorkItemWait,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Clients ask once a minute while visible; the server backs off unchanged HQ reads to five
 * minutes and expires them after proxied agent writes. No mounted reader means no polling.
 */
export function createBuildWorkItemAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const visible = Atom.make((get) => {
    if (typeof document === "undefined") return true;
    const update = () => get.setSelf(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    get.addFinalizer(() => document.removeEventListener("visibilitychange", update));
    return document.visibilityState === "visible";
  }).pipe(Atom.setIdleTTL(0));
  // Dispose polling immediately when the last reader unmounts, including the timer wrapper.
  const polling = {
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    idleTtlMs: 0,
    refreshWhile: visible,
  };
  return {
    item: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:work-item",
      tag: WS_METHODS.buildWorkItemRead,
      ...polling,
    }),
    /** Mounted only while a card or sheet is open, so a closed card costs nothing. */
    card: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:work-item-card",
      tag: WS_METHODS.buildWorkItemCard,
      ...polling,
    }),
    /** Mounted only while a mention is on screen; the same item in many chips is one query. */
    mentions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:mentions",
      tag: WS_METHODS.buildWorkItemMentions,
      ...polling,
    }),
    connection: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:connection",
      tag: WS_METHODS.buildConnectionRead,
      staleTimeMs: 60_000,
    }),
    /** Connect to HQ: returns the HQ page to open; the result arrives through `connection`. */
    signInStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:hq:sign-in",
      tag: WS_METHODS.hqSignInStart,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:hq:disconnect",
      tag: WS_METHODS.hqDisconnect,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:work-item:link",
      tag: WS_METHODS.buildWorkItemLink,
    }),
    /** Build Home for the Build button; the server paces its own reads of HQ. */
    home: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:home",
      tag: WS_METHODS.buildHomeRead,
      ...polling,
    }),
    homeDecide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:home:decide",
      tag: WS_METHODS.buildHomeDecide,
    }),
    homeAnswer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:home:answer",
      tag: WS_METHODS.buildHomeAnswer,
    }),
  };
}

export type BuildStatusTone =
  | "not-started"
  | "in-progress"
  | "landed"
  | "accepted"
  | "dropped"
  | "unknown";

export function buildStatusTone(item: { readonly status: string } | null): BuildStatusTone {
  switch (item?.status) {
    case "inbox":
    case "shaping":
    case "ready":
      return "not-started";
    case "in_progress":
      return "in-progress";
    case "landed":
      return "landed";
    case "accepted":
      return "accepted";
    case "dropped":
      return "dropped";
    default:
      return "unknown";
  }
}

export const BUILD_STATUS_LABELS: Record<string, string> = {
  inbox: "Inbox",
  shaping: "Shaping",
  ready: "Ready",
  in_progress: "In progress",
  landed: "Landed",
  accepted: "Accepted",
  dropped: "Dropped",
  proposed: "Proposed",
  superseded: "Superseded",
};

export const buildStatusLabel = (status: string) => BUILD_STATUS_LABELS[status] ?? status;

export const buildKindGlyph = (kind: BuildWorkItemSummary["kind"] | undefined) =>
  kind === "ticket" ? "▢" : "◇";

/**
 * How every surface names an item: its friendly ref such as `YS-12` when Build has told T3 one,
 * else `#<number>`. `number` is the canonical identity, which a ref's tooltip shows.
 */
export const buildItemLabel = (item: {
  readonly number: number;
  readonly ref?: string | null | undefined;
}) => item.ref ?? `#${item.number}`;

/** The canonical `#<number>` for a tooltip; nothing when the label already is the number. */
export const buildItemNumberHint = (item: {
  readonly number: number;
  readonly ref?: string | null | undefined;
}) => (item.ref ? `#${item.number}` : undefined);

/** What a header segment or subtitle shows for a linked item, on web and mobile alike. */
export function presentBuildWorkItem(link: BuildWorkItemView) {
  const item = link.item;
  return {
    label: buildItemLabel({ number: link.number, ref: item?.ref }),
    numberHint: buildItemNumberHint({ number: link.number, ref: item?.ref }),
    glyph: buildKindGlyph(item?.kind),
    // With nothing read yet, the number is all that is known; never a spinner.
    title: item?.title ?? `Build ${link.number}`,
    tone: buildStatusTone(item),
    statusLabel: item === null ? null : buildStatusLabel(item.status),
    held: (item?.holds.length ?? 0) > 0,
    blocked: (item?.waits.length ?? 0) > 0,
    unavailable: link.unavailable,
  };
}
export type BuildWorkItemPresentation = ReturnType<typeof presentBuildWorkItem>;

/** Ticket statuses in the order a Spec's progress bar fills. */
const TICKET_PROGRESS_ORDER = ["landed", "in_progress", "ready", "dropped"];

/** A Spec card's progress bar and "+N more", from its Tickets by status. */
export function presentSpecTickets(detail: Extract<BuildWorkItemCard["detail"], { kind: "spec" }>) {
  const total = Object.values(detail.ticketCounts).reduce((sum, count) => sum + count, 0);
  const statuses = [
    ...TICKET_PROGRESS_ORDER,
    ...Object.keys(detail.ticketCounts).filter((status) => !TICKET_PROGRESS_ORDER.includes(status)),
  ];
  return {
    total,
    segments: statuses
      .map((status) => ({
        status,
        label: buildStatusLabel(status),
        tone: buildStatusTone({ status }),
        count: detail.ticketCounts[status] ?? 0,
      }))
      .filter((segment) => segment.count > 0),
    more: Math.max(0, total - detail.tickets.length),
  };
}

/** "⛓ Blocked by YS-12 Title (In progress). Starts when it is landed." */
export const describeBuildWait = (wait: BuildWorkItemWait) => ({
  blocker: `${buildItemLabel(wait)} ${wait.title}`,
  status: buildStatusLabel(wait.status),
  startsWhen: `Starts when it is ${wait.required}.`,
});

/** A card footer's session, as plain text until it can open a T3 thread. */
export const buildSessionLabel = (session: BuildWorkItemSession) =>
  `${session.harness === "t3" ? "T3 thread" : `${session.harness} session`} · ${session.activity}`;
