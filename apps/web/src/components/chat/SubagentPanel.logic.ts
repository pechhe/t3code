import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import type {
  AgentRole,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadStanding,
  OrchestrationV2ThreadWatch,
  ThreadId,
} from "@t3tools/contracts";

/** One thing the thread waits on that is not a subagent row of the panel. */
export interface PanelWait {
  readonly item: PendingBackgroundWorkItem;
  readonly awaited: boolean;
  readonly startedAtMs: number | null;
  readonly task: OrchestrationV2PendingBackgroundTask | undefined;
  readonly role?: AgentRole | undefined;
}

export type PanelWaitKind = "agent" | "watch" | "command";

/** Which panel section and header count a wait belongs to. */
export function panelWaitKind(group: PendingBackgroundWorkItem["group"]): PanelWaitKind {
  switch (group) {
    case "subagent":
      return "agent";
    case "thread":
    case "pull_request":
    case "build_item":
    case "landing":
      return "watch";
    default:
      return "command";
  }
}

export interface PanelSummaryCounts {
  /** Delegated subagents in the panel, live and recently finished, plus provider-native agents. */
  readonly subagents: number;
  readonly working: number;
  readonly stalled: number;
  readonly watches: number;
  readonly commands: number;
  /** Waits that do not hold the thread; never counted as working. */
  readonly parked?: number;
  /** The server answered where the thread stands; older servers keep today's wording. */
  readonly hasStanding: boolean;
}

export interface PanelSummaryPart {
  readonly text: string;
  readonly tone: "default" | "quiet" | "stalled" | "parked";
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The header's words: the first part reads at full weight, the rest quietly, a stall in amber. */
export function panelSummaryParts(counts: PanelSummaryCounts): ReadonlyArray<PanelSummaryPart> {
  const parts: Array<{ text: string; tone: PanelSummaryPart["tone"] }> = [];
  if (counts.hasStanding) {
    // A stalled child is counted on its own, so it is not also one of the plain subagents.
    const idle = counts.subagents - counts.stalled;
    if (counts.working > 0)
      parts.push({ text: `${plural(counts.working, "subagent")} working`, tone: "quiet" });
    else if (idle > 0) parts.push({ text: plural(idle, "subagent"), tone: "quiet" });
  } else {
    if (counts.subagents > 0)
      parts.push({ text: plural(counts.subagents, "subagent"), tone: "quiet" });
    if (counts.working > 0) parts.push({ text: `${counts.working} working`, tone: "quiet" });
  }
  if (counts.stalled > 0) parts.push({ text: `${counts.stalled} stalled`, tone: "stalled" });
  if (counts.watches > 0)
    parts.push({ text: plural(counts.watches, "watch", "watches"), tone: "quiet" });
  if (counts.commands > 0) parts.push({ text: plural(counts.commands, "command"), tone: "quiet" });
  if ((counts.parked ?? 0) > 0) parts.push({ text: `${counts.parked} parked`, tone: "parked" });
  return parts.map((part, index) =>
    index === 0 && part.tone === "quiet" ? { ...part, tone: "default" } : part,
  );
}

export interface PanelWaitsOnYou {
  readonly number: number;
  readonly ref: string;
  readonly need: "acceptance";
}

/**
 * What waits on the person: the server's standing says so when it answers, and an older server's
 * Forge watch still carries the same fact on the watch itself.
 */
export function panelWaitsOnYou(input: {
  readonly standing: OrchestrationV2ThreadStanding | undefined;
  readonly threadWatches: ReadonlyArray<OrchestrationV2ThreadWatch> | undefined;
}): PanelWaitsOnYou | null {
  const waits = input.standing?.waitsOnPerson;
  if (waits?.need === "acceptance") {
    return { number: waits.number, ref: waits.ref ?? `#${waits.number}`, need: waits.need };
  }
  if (input.standing !== undefined) return null;
  for (const watch of input.threadWatches ?? []) {
    if (watch.waitsOnPerson?.need === "acceptance" && watch.target.kind === "build_item") {
      return {
        number: watch.target.number,
        ref: watch.waitsOnPerson.ref ?? `#${watch.target.number}`,
        need: watch.waitsOnPerson.need,
      };
    }
  }
  return null;
}

export function waitsOnYouText(waits: PanelWaitsOnYou): string {
  return `${waits.ref} awaits your acceptance`;
}

/** A stalled child the panel has no row for (it sits below a direct child) still gets one. */
export function stalledChildWithoutRow(
  stalled: OrchestrationV2ThreadStanding["stalled"],
  rowThreadIds: ReadonlyArray<ThreadId>,
) {
  return stalled !== undefined && !rowThreadIds.includes(stalled.childThreadId) ? stalled : null;
}

/**
 * The children the panel already shows a row for: live shells, plus agent waits that name their
 * child. A stalled child among them must not get a second row or a second count.
 */
export function panelRowThreadIds(
  subagentIds: ReadonlyArray<ThreadId>,
  agentWaits: ReadonlyArray<Pick<PanelWait, "item">>,
): ReadonlyArray<ThreadId> {
  return [
    ...subagentIds,
    ...agentWaits.flatMap((wait) =>
      wait.item.childThreadId === undefined ? [] : [wait.item.childThreadId],
    ),
  ];
}
