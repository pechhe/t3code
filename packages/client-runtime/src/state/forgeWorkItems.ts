import {
  WS_METHODS,
  type ForgeArcRunDetail,
  type ForgeArcRunSpec,
  type ForgeArcRunSummary,
  type OrchestrationV2ThreadArcRun,
  type ForgeWorkItemCard,
  type ForgeWorkItemSession,
  type ForgeWorkItemSummary,
  type ForgeWorkItemView,
  type ForgeWorkItemWait,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Clients ask once a minute while visible; the server backs off unchanged Weave reads to five
 * minutes and expires them after proxied agent writes. No mounted reader means no polling.
 */
export function createForgeWorkItemAtoms<R, E>(
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
      tag: WS_METHODS.forgeWorkItemRead,
      ...polling,
    }),
    /** Mounted only while a card or sheet is open, so a closed card costs nothing. */
    card: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:work-item-card",
      tag: WS_METHODS.forgeWorkItemCard,
      ...polling,
    }),
    /** The Arc run chip's counts, mounted while a thread holding a run is on screen. */
    arcRunSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:arc-run-summary",
      tag: WS_METHODS.forgeArcRunSummary,
      ...polling,
    }),
    /** Mounted only while the Arc run popover is open: the whole Arc's Specs. */
    arcRunDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:arc-run-detail",
      tag: WS_METHODS.forgeArcRunDetail,
      ...polling,
    }),
    /** Mounted only while a mention is on screen; the same item in many chips is one query. */
    mentions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:mentions",
      tag: WS_METHODS.forgeWorkItemMentions,
      ...polling,
    }),
    connection: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:connection",
      tag: WS_METHODS.buildConnectionRead,
      staleTimeMs: 60_000,
    }),
    /** Connect to Weave: returns the Weave page to open; the result arrives through `connection`. */
    signInStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:weave:sign-in",
      tag: WS_METHODS.weaveSignInStart,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:weave:disconnect",
      tag: WS_METHODS.weaveDisconnect,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:work-item:link",
      tag: WS_METHODS.forgeWorkItemLink,
    }),
    /** Forge Home for the Forge button; the server paces its own reads of Weave. */
    home: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:home",
      tag: WS_METHODS.forgeHomeRead,
      ...polling,
    }),
    homeDecide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:home:decide",
      tag: WS_METHODS.forgeHomeDecide,
    }),
  };
}

export type ForgeStatusTone =
  | "not-started"
  | "in-progress"
  | "landed"
  | "accepted"
  | "dropped"
  | "unknown";

export function buildStatusTone(item: { readonly status: string } | null): ForgeStatusTone {
  switch (item?.status) {
    case "inbox":
    case "shaping":
    case "ready":
      return "not-started";
    case "in_progress":
    case "open":
      return "in-progress";
    case "landed":
    case "achieved":
      return "landed";
    case "accepted":
      return "accepted";
    case "dropped":
      return "dropped";
    default:
      return "unknown";
  }
}

const BUILD_STATUS_LABELS: Record<string, string> = {
  inbox: "Inbox",
  shaping: "Shaping",
  ready: "Ready",
  in_progress: "In progress",
  landed: "Landed",
  accepted: "Accepted",
  open: "Open",
  achieved: "Achieved",
  dropped: "Dropped",
  proposed: "Proposed",
  superseded: "Superseded",
};

export const buildStatusLabel = (status: string) => BUILD_STATUS_LABELS[status] ?? status;

const buildKindGlyph = (kind: ForgeWorkItemSummary["kind"] | undefined) =>
  kind === "ticket" ? "▢" : kind === "arc" ? "◈" : "◇";

/**
 * How every surface names an item: its friendly ref such as `YS-12` when Forge has told T3 one,
 * else `#<number>`. `number` is the canonical identity, which a ref's tooltip shows.
 */
export const forgeItemLabel = (item: {
  readonly number: number;
  readonly ref?: string | null | undefined;
}) => item.ref ?? `#${item.number}`;

/** The canonical `#<number>` for a tooltip; nothing when the label already is the number. */
export const forgeItemNumberHint = (item: {
  readonly number: number;
  readonly ref?: string | null | undefined;
}) => (item.ref ? `#${item.number}` : undefined);

/** What a header segment or subtitle shows for a linked item, on web and mobile alike. */
export function presentForgeWorkItem(link: ForgeWorkItemView) {
  const item = link.item;
  return {
    label: forgeItemLabel({ number: link.number, ref: item?.ref }),
    numberHint: forgeItemNumberHint({ number: link.number, ref: item?.ref }),
    glyph: buildKindGlyph(item?.kind),
    // With nothing read yet, the number is all that is known; never a spinner.
    title: item?.title ?? `Forge ${link.number}`,
    tone: buildStatusTone(item),
    statusLabel: item === null ? null : buildStatusLabel(item.status),
    held: (item?.holds.length ?? 0) > 0,
    blocked: (item?.waits.length ?? 0) > 0,
    unavailable: link.unavailable,
  };
}
export type ForgeWorkItemPresentation = ReturnType<typeof presentForgeWorkItem>;

/** Ticket statuses in the order a Spec's progress bar fills. */
const TICKET_PROGRESS_ORDER = ["landed", "in_progress", "ready", "dropped"];

/** A Spec card's progress bar and "+N more", from its Tickets by status. */
export function presentSpecTickets(detail: Extract<ForgeWorkItemCard["detail"], { kind: "spec" }>) {
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
export const describeForgeWait = (wait: ForgeWorkItemWait) => ({
  blocker: `${forgeItemLabel(wait)} ${wait.title}`,
  status: buildStatusLabel(wait.status),
  startsWhen: `Starts when it is ${wait.required}.`,
});

/** The card header's first line: what the item is, plus what only its kind adds. */
export function presentForgeCardKind(detail: ForgeWorkItemCard["detail"]) {
  switch (detail.kind) {
    case "spec":
      return [`${buildKindGlyph("spec")} Spec`, detail.specKind, detail.horizon]
        .filter(Boolean)
        .join(" · ");
    case "ticket":
      return `${buildKindGlyph("ticket")} Ticket${detail.spec ? ` in ${buildKindGlyph("spec")} ${detail.spec.title}` : ""}`;
    case "arc":
      return `${buildKindGlyph("arc")} Arc`;
  }
}

/** A card footer's session, as plain text until it can open a T3 thread. */
export const buildSessionLabel = (session: ForgeWorkItemSession) =>
  `${session.harness === "t3" ? "T3 thread" : `${session.harness} session`} · ${session.activity}`;

export type ArcRunState = "running" | "paused" | "attention";

/** One Spec row of the Arc run view. Forge's fields are null until the open view has read them. */
export interface ArcRunRow {
  readonly number: number;
  readonly label: string;
  readonly spec: ForgeArcRunSpec | null;
  /** Its place in the lead's plan, from 1; null when the run has no plan or it is not in it. */
  readonly position: number | null;
  readonly current: boolean;
  /** Not one of this run's Specs: the rest of the Arc, shown dimmed. */
  readonly outsideRun: boolean;
}

export interface ArcRunPresentation {
  readonly arcLabel: string;
  readonly state: ArcRunState;
  /** The run answers for named Specs rather than the whole Arc. */
  readonly namedSpecs: boolean;
  readonly planned: boolean;
  /** This run's Specs: in plan order when there is a plan, else as the run names them or Forge lists them. */
  readonly run: ReadonlyArray<ArcRunRow>;
  /** A run of named Specs: the Arc's other Specs. */
  readonly elsewhere: ReadonlyArray<ArcRunRow>;
  /** A whole-Arc run with a plan: member Specs the plan leaves out. */
  readonly notPlanned: ReadonlyArray<ArcRunRow>;
  /** Every Spec in the Arc once, for the Arc bar: Specs done outside the run, the run, then the rest. */
  readonly bar: ReadonlyArray<ArcRunRow>;
  readonly checkpoint: OrchestrationV2ThreadArcRun["checkpoint"] | null;
}

const ARC_RUN_STATE: Record<OrchestrationV2ThreadArcRun["state"], ArcRunState> = {
  active: "running",
  paused: "paused",
  attention: "attention",
};

/**
 * The chip's numbers: the run's Specs Landed or Accepted, out of those not Dropped. `complete` is
 * false when Forge was only partly read, and the chip must then say the count may be short.
 */
export function arcRunChip(
  arcRun: OrchestrationV2ThreadArcRun,
  summary: ForgeArcRunSummary | null,
) {
  return {
    label: summary === null ? forgeItemLabel(arcRun.arc) : forgeItemLabel(summary.arc),
    state: ARC_RUN_STATE[arcRun.state],
    progress: summary === null ? null : { landed: summary.landed, total: summary.total },
    complete: summary?.complete ?? true,
  };
}

/**
 * The Arc run popover. Works from the run alone, so the plan shows at once, and
 * fills in titles, statuses and the rest of the Arc once the open view's detail arrives.
 */
export function presentArcRun(
  arcRun: OrchestrationV2ThreadArcRun,
  detail: ForgeArcRunDetail | null,
): ArcRunPresentation {
  const specs = new Map((detail?.specs ?? []).map((spec) => [spec.number, spec] as const));
  const scope = arcRun.specs;
  const plan = arcRun.plan;
  const inRun = (number: number) => scope === undefined || scope.includes(number);
  const row = (number: number, position: number | null): ArcRunRow => {
    const spec = specs.get(number) ?? null;
    return {
      number,
      label: forgeItemLabel({ number, ref: spec?.ref }),
      spec,
      position,
      current: arcRun.current === number,
      outsideRun: !inRun(number),
    };
  };
  const members = (detail?.specs ?? []).filter((spec) => spec.inArc).map((spec) => spec.number);
  const runNumbers = plan ?? scope ?? members;
  const run = runNumbers.map((number, index) => row(number, plan === undefined ? null : index + 1));
  const listed = new Set(runNumbers);
  const rest = members.filter((number) => !listed.has(number)).map((number) => row(number, null));
  const elsewhere = scope === undefined ? [] : rest;
  const notPlanned = scope === undefined ? rest : [];
  const done = (r: ArcRunRow) => r.spec?.status === "accepted";
  return {
    arcLabel: forgeItemLabel(detail?.arc ?? arcRun.arc),
    state: ARC_RUN_STATE[arcRun.state],
    namedSpecs: scope !== undefined,
    planned: plan !== undefined,
    run,
    elsewhere,
    notPlanned,
    bar: [
      ...elsewhere.filter(done),
      ...run.filter((r) => r.spec?.inArc !== false),
      ...elsewhere.filter((r) => !done(r)),
      ...notPlanned,
    ],
    checkpoint: arcRun.checkpoint ?? null,
  };
}
