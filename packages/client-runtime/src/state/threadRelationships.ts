import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
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

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
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
  /** A linked environment's thread; absent means the watcher's own environment. */
  readonly environmentId?: EnvironmentId;
  readonly kind: ThreadWatchRelationshipKind;
}

/** A local and a remote thread may share an id, so rows are told apart by environment too. */
export const threadWatchRowKey = (row: {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId | undefined;
}): string => `${row.environmentId ?? ""}\u0000${row.threadId}`;

/**
 * The threads this one watches and the threads watching it. A watch is not a graph edge: the graph's
 * other consumers would count watched threads as work this thread owns. Only thread watches appear;
 * one in a linked environment keeps its `environmentId`, and only watchers here are known.
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
  const rowOf = (
    threadId: ThreadId,
    environmentId: EnvironmentId | undefined,
    kind: ThreadWatchRelationshipKind,
  ): ThreadWatchRelationshipRow => ({
    threadId,
    ...(environmentId === undefined ? {} : { environmentId }),
    kind,
  });
  const isSelf = (threadId: ThreadId, environmentId: EnvironmentId | undefined) =>
    environmentId === undefined && threadId === input.threadId;
  const watching = new Map<string, ThreadWatchRelationshipRow>();
  for (const watch of input.threadWatches ?? []) {
    if (watch.target.kind !== "thread") continue;
    const { threadId, environmentId } = watch.target;
    if (isSelf(threadId, environmentId)) continue;
    const row = rowOf(threadId, environmentId, "watching");
    watching.set(threadWatchRowKey(row), row);
  }
  const watched = new Map<string, ThreadWatchRelationshipRow>();
  for (const ended of input.endedThreadWatches ?? []) {
    const row = rowOf(ended.threadId, ended.environmentId, "watched");
    const key = threadWatchRowKey(row);
    if (!isSelf(ended.threadId, ended.environmentId) && !watching.has(key)) watched.set(key, row);
  }
  return {
    watching: [...watching.values()],
    watched: [...watched.values()],
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
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
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
