import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkIsOnlyWatches } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  for (const thread of threads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function relatedThreadIds(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const edge of graph.edges) {
    if (edge.sourceThreadId === threadId) ids.add(edge.targetThreadId);
    if (edge.targetThreadId === threadId) ids.add(edge.sourceThreadId);
  }
  return [...ids];
}

export function walkThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>([threadId]);
  const pending: Array<{ readonly threadId: ThreadId; readonly depth: number }> = [
    { threadId, depth: 0 },
  ];
  const rows: ThreadRelationshipWalkRow[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const edge of graph.edges) {
      const relatedId =
        edge.sourceThreadId === current.threadId
          ? edge.targetThreadId
          : edge.targetThreadId === current.threadId
            ? edge.sourceThreadId
            : null;
      if (relatedId === null || visited.has(relatedId)) continue;
      visited.add(relatedId);
      const depth = current.depth + 1;
      rows.push({ threadId: relatedId, fromThreadId: current.threadId, depth, edge });
      pending.push({ threadId: relatedId, depth });
    }
  }

  return rows;
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  return threadShellRelationshipStatus(graph.nodes.get(row.threadId)?.thread);
}

/** The live status a relationship row shows for a thread, whichever way it is related. */
export function threadShellRelationshipStatus(
  thread:
    | Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks" | "activityRunStatus" | "status">
    | null
    | undefined,
): string | null {
  if (backgroundWorkIsOnlyWatches(thread?.pendingBackgroundTasks ?? [])) return "watching";
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

export type ThreadWatchRelationshipKind = "watching" | "watchedBy" | "watched";

export interface ThreadWatchRelationshipRow {
  readonly threadId: ThreadId;
  readonly kind: ThreadWatchRelationshipKind;
}

/**
 * The threads this one watches and the threads watching it. Kept beside the relationship graph,
 * not in it: a watch is not a parent/child edge, and the graph's other consumers (mobile, the
 * running count) would otherwise start treating watched threads as work this thread owns.
 * Build-item and pull-request watches are not threads and stay out.
 */
export function deriveThreadWatchRelationships(input: {
  readonly threadId: ThreadId;
  readonly threadWatches: OrchestrationV2ThreadShell["threadWatches"];
  readonly endedThreadWatches: OrchestrationV2ThreadShell["endedThreadWatches"];
  readonly watcherThreadIds: ReadonlyArray<ThreadId>;
}): {
  readonly watching: ReadonlyArray<ThreadWatchRelationshipRow>;
  readonly watchedBy: ReadonlyArray<ThreadWatchRelationshipRow>;
  /** Threads this one finished watching, newest first, minus any it watches again. */
  readonly watched: ReadonlyArray<ThreadWatchRelationshipRow>;
} {
  const watching = new Set<ThreadId>();
  for (const watch of input.threadWatches ?? []) {
    if (watch.target.kind === "thread" && watch.target.threadId !== input.threadId) {
      watching.add(watch.target.threadId);
    }
  }
  const watched = new Set<ThreadId>();
  for (const ended of input.endedThreadWatches ?? []) {
    if (ended.threadId !== input.threadId && !watching.has(ended.threadId)) {
      watched.add(ended.threadId);
    }
  }
  return {
    watching: [...watching].map((threadId) => ({ threadId, kind: "watching" })),
    watched: [...watched].map((threadId) => ({ threadId, kind: "watched" })),
    watchedBy: [...new Set(input.watcherThreadIds)].map((threadId) => ({
      threadId,
      kind: "watchedBy",
    })),
  };
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web-specific by design: the panel pins the parent row first and a distinct
 * merge-back target second so their actions stay where the user expects, and
 * only then falls back to newest-created-first. Mobile does not share that
 * exception, so this is not the canonical relationship order and should not be
 * reused as one.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
