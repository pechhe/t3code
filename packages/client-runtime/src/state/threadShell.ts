import { championNeedsInbox } from "./threadInbox.ts";
import type {
  AgentRole,
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2Subagent,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  AGENT_ROLE_TITLE_LABEL,
  isListedThreadLineage,
  hiddenSideChatIds,
  isProviderNativeSubagentThread,
  isSideChatThread,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";
import { presentThreadShell, threadRuntimeIsActive } from "./models.ts";
import { hiddenThreadKeys, NO_HIDDEN_THREADS } from "./threadTagFilter.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";
import { threadWatchers } from "./shellThreadWatches.ts";

export type ThreadWatcher = Pick<OrchestrationV2ThreadShell, "id" | "title">;

const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map();
const EMPTY_SUBAGENT_REQUESTS: ReadonlyMap<ThreadId, PendingSubagentRequest> = new Map();
const EMPTY_SIDE_CHATS_BY_PARENT: ReadonlyMap<
  ThreadId,
  ReadonlyArray<OrchestrationV2ThreadShell>
> = new Map();
const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

// An async question outlives the subagent's run, but once that run ends the
// parent is no longer waiting on the answer, so it stops counting as input.
// The activity run stays set when a follow-up is queued behind a blocked run;
// older servers omit it, so fall back to the latest run's status.
const isChildRunLive = (
  thread: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running" ||
      thread.status === "waiting";

/**
 * Whether a thread shows under its parent rather than in thread lists: a
 * subagent, a side chat, or a task a linked environment delegated here whose parent the
 * client lists (`delegatedUnderParent`, by thread key). A task whose parent
 * the client cannot list stays in the lists, so its work is never out of reach.
 */
export function isShownUnderParent(
  ref: ScopedThreadRef,
  lineage: OrchestrationV2ThreadShell["lineage"],
  delegatedUnderParent: ReadonlySet<string>,
): boolean {
  return !isListedThreadLineage(lineage) || delegatedUnderParent.has(threadKey(ref));
}

/** Provider-native
    subagents ask on their parent, so they are skipped. */
function subagentRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (
    kind === undefined ||
    kind === "auth_refresh" ||
    (thread.lineage.relationshipToParent !== "subagent" && thread.delegatedFrom === undefined) ||
    isProviderNativeSubagentThread(thread) ||
    !isChildRunLive(thread)
  ) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/** A side chat asks its user directly, so questions roll up to the parent as well as approvals. */
function sideChatRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (kind === undefined || kind === "auth_refresh" || !isSideChatThread(thread)) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/**
 * The threads to flag for a subagent's live approval, up its
 * subagent chain and through a side chat to its parent. `delegated` are tasks this
 * environment's threads delegated to linked environments, with what each one, or its
 * own subagents, asks.
 */
function pendingSubagentRequestsByThread(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  delegated: ReadonlyArray<{
    readonly parentThreadId: ThreadId;
    readonly request: PendingSubagentRequest;
  }> = [],
): ReadonlyMap<ThreadId, PendingSubagentRequest> {
  const requests = new Map<ThreadId, PendingSubagentRequest>();
  let byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> | undefined;
  const flag = (
    firstParentId: ThreadId | null,
    request: PendingSubagentRequest,
    seen: Set<ThreadId>,
  ) => {
    // The coordinator answers child questions; only approvals need user attention.
    if (request === "user_input") return;
    byId ??= new Map(threads.map((thread) => [thread.id, thread] as const));
    let parentId = firstParentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (requests.get(parentId) !== "approval") requests.set(parentId, request);
      const parent = byId.get(parentId);
      parentId =
        parent?.lineage.relationshipToParent === "subagent" || parent?.lineage.sideChat === true
          ? parent.lineage.parentThreadId
          : null;
    }
  };
  for (const child of threads) {
    const parentId = child.lineage.parentThreadId;
    if (child.lineage.sideChat === true) {
      const request = sideChatRequest(child);
      if (parentId !== null && request !== null && requests.get(parentId) !== "approval") {
        requests.set(parentId, request);
      }
      continue;
    }
    if (child.lineage.relationshipToParent !== "subagent") continue;
    const request = subagentRequest(child);
    if (request !== null) flag(parentId, request, new Set([child.id]));
  }
  for (const task of delegated) flag(task.parentThreadId, task.request, new Set());
  return requests.size === 0 ? EMPTY_SUBAGENT_REQUESTS : requests;
}

const FINISHED_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type SubagentStatus = "approval" | "input" | "working" | "waiting";

/** What a thread's subagents are doing, for a parent that is only waiting on them. */
export interface SubagentActivity {
  readonly status: SubagentStatus;
  /** The role the status speaks for; null when several roles share it. */
  readonly role: AgentRole | null;
  readonly count: number;
  /** When the lone subagent's run started; null for several, whose timers differ. */
  readonly startedAt: string | null;
}

export interface SubagentLiveState {
  /** Each subagent's own status, raised by anything below it: a lead waiting on a working reviewer is working. */
  readonly statuses: ReadonlyMap<ThreadId, SubagentStatus>;
  readonly activity: ReadonlyMap<ThreadId, SubagentActivity>;
  /** Parent of each subagent with a status, for finding which child of a thread a request came through. */
  readonly parents: ReadonlyMap<ThreadId, ThreadId>;
}

const SUBAGENT_STATUS_RANK: Record<SubagentStatus, number> = {
  approval: 3,
  input: 2,
  working: 1,
  waiting: 0,
};

function ownSubagentStatus(thread: OrchestrationV2ThreadShell): SubagentStatus | null {
  const request = subagentRequest(thread);
  if (request !== null) return request === "approval" ? "approval" : "input";
  if (thread.blockedOnThreadWait === true) return "waiting";
  if (isChildRunLive(thread)) return "working";
  return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) ? "waiting" : null;
}

export function deriveSubagentLiveState(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): SubagentLiveState {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const statuses = new Map<ThreadId, SubagentStatus>();
  for (const thread of threads) {
    if (thread.lineage.relationshipToParent !== "subagent") continue;
    const own = ownSubagentStatus(thread);
    if (own === null) continue;
    const seen = new Set<ThreadId>();
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current?.lineage.relationshipToParent === "subagent" && !seen.has(current.id)) {
      seen.add(current.id);
      const held = statuses.get(current.id);
      if (held === undefined || SUBAGENT_STATUS_RANK[held] < SUBAGENT_STATUS_RANK[own]) {
        statuses.set(current.id, own);
      }
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      current = parentId === null ? undefined : byId.get(parentId);
    }
  }
  const parents = new Map<ThreadId, ThreadId>();
  const childrenByParent = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const threadId of statuses.keys()) {
    const child = byId.get(threadId);
    const parentId = child?.lineage.parentThreadId ?? null;
    if (child === undefined || parentId === null) continue;
    parents.set(threadId, parentId);
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(child);
    else childrenByParent.set(parentId, [child]);
  }
  const activity = new Map<ThreadId, SubagentActivity>();
  const statusOf = (child: OrchestrationV2ThreadShell) =>
    statuses.get(child.id) ?? ("waiting" as const);
  const isLead = (child: OrchestrationV2ThreadShell) => child.agentTask?.role === "lead";
  for (const [parentId, children] of childrenByParent) {
    // A lead speaks before other roles at the same status, never above a stronger one.
    const [top] = [...children].sort(
      (a, b) =>
        SUBAGENT_STATUS_RANK[statusOf(b)] - SUBAGENT_STATUS_RANK[statusOf(a)] ||
        Number(isLead(b)) - Number(isLead(a)),
    );
    if (top === undefined) continue;
    const status = statusOf(top);
    const peers = children.filter(
      (child) => statusOf(child) === status && isLead(child) === isLead(top),
    );
    const role = top.agentTask?.role ?? null;
    activity.set(parentId, {
      status,
      role: peers.every((peer) => peer.agentTask?.role === role) ? role : null,
      count: peers.length,
      startedAt:
        peers.length === 1 && top.activityRunStartedAt != null
          ? DateTime.formatIso(top.activityRunStartedAt)
          : null,
    });
  }
  return { statuses, activity, parents };
}

/** The direct child of `ancestorId` that `threadId` sits under, or is. */
export function directSubagentUnder(
  parents: ReadonlyMap<ThreadId, ThreadId>,
  ancestorId: ThreadId,
  threadId: ThreadId,
): ThreadId | null {
  const seen = new Set<ThreadId>();
  let current = threadId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (parent === undefined) return null;
    if (parent === ancestorId) return current;
    current = parent;
  }
  return null;
}

/** Roles that carry the work and report progress worth reading; the rest answer and finish. */
export function isSubagentDoer(role: AgentRole | undefined): boolean {
  return (
    role === undefined ||
    role === "lead" ||
    role === "implementation-worker" ||
    role === "ui-worker" ||
    role === "chore-worker"
  );
}

/**
 * Delegated subagents that finished since the user last wrote, newest first. They stay visible
 * while the thread has work in progress, and clear once it has settled.
 */
export function finishedPanelSubagents(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly liveIds: ReadonlyArray<ThreadId>;
  readonly since: DateTime.Utc | null;
  readonly parentBusy: boolean;
}): ReadonlyArray<OrchestrationV2Subagent> {
  if (input.liveIds.length === 0 && !input.parentBusy) return [];
  const sinceMs = input.since === null ? null : DateTime.toEpochMillis(input.since);
  const latestByChild = new Map<ThreadId, OrchestrationV2Subagent>();
  for (const subagent of input.subagents) {
    if (subagent.origin === "app_owned" && subagent.childThreadId !== null) {
      latestByChild.set(subagent.childThreadId, subagent);
    }
  }
  const finished = [...latestByChild.entries()].flatMap(([childThreadId, subagent]) =>
    FINISHED_SUBAGENT_STATUSES.has(subagent.status) &&
    subagent.completedAt !== null &&
    !input.liveIds.includes(childThreadId) &&
    (sinceMs === null || DateTime.toEpochMillis(subagent.completedAt) > sinceMs)
      ? [{ subagent, completedMs: DateTime.toEpochMillis(subagent.completedAt) }]
      : [],
  );
  return finished.sort((a, b) => b.completedMs - a.completedMs).map((entry) => entry.subagent);
}

/** A thread's delegated subagents in panel order: leads, then other doers, then helpers. */
export function subagentPanelChildIds(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  parentId: ThreadId,
): ReadonlyArray<ThreadId> {
  const rank = (thread: OrchestrationV2ThreadShell) =>
    thread.agentTask?.role === "lead" ? 0 : isSubagentDoer(thread.agentTask?.role) ? 1 : 2;
  return threads
    .filter(
      (thread) =>
        thread.lineage.relationshipToParent === "subagent" &&
        thread.lineage.parentThreadId === parentId &&
        !isProviderNativeSubagentThread(thread),
    )
    .map((thread, index) => ({ id: thread.id, rank: rank(thread), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}

// The row's spinner and colour already say a subagent is working, so only the other states need a word.
const SUBAGENT_ACTIVITY_SUFFIX: Record<SubagentStatus, string> = {
  approval: " approval",
  input: " input",
  working: "",
  waiting: " waiting",
};

function subagentActivityNoun(role: AgentRole | null): string {
  switch (role) {
    case null:
      return "Agent";
    case "lead":
      return "Lead";
    case "implementation-worker":
      return "Implementer";
    case "reviewer":
      return "Reviewer";
    default:
      return AGENT_ROLE_TITLE_LABEL[role];
  }
}

/** "Lead", "4 implementers", "Advisor input": short enough for a sidebar row beside its timer. */
export function subagentActivityLabel(activity: SubagentActivity): string {
  const noun = subagentActivityNoun(activity.role);
  const suffix = SUBAGENT_ACTIVITY_SUFFIX[activity.status];
  if (activity.count === 1) return `${noun}${suffix}`;
  return `${activity.count} ${noun.toLowerCase()}s${suffix}`;
}
const sameRequests = (
  left: ReadonlyMap<ThreadId, PendingSubagentRequest>,
  right: ReadonlyMap<ThreadId, PendingSubagentRequest>,
) =>
  left.size === right.size &&
  [...right].every(([threadId, request]) => left.get(threadId) === request);

export function childThreadInputsTitle(
  children: ReadonlyArray<Pick<EnvironmentThreadShell, "hasPendingApprovals" | "lineage">>,
): string {
  const approvals = children.filter((child) => child.hasPendingApprovals).length;
  const need = approvals === 0 ? "input" : approvals === children.length ? "approval" : "you";
  const sideChats = children.filter((child) => child.lineage.sideChat === true).length;
  const noun =
    sideChats === children.length ? "side chat" : sideChats === 0 ? "subagent" : "thread";
  return children.length === 1
    ? `${noun === "side chat" ? "Side chat" : "Subagent"} needs ${need}`
    : `${children.length} ${noun}s need ${need}`;
}

const sameWireThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);

// While a run streams, the server bumps the shell's timestamps, item counts and
// latest message several times a second. Only the zero crossing of the counts
// says anything (whether the thread has started). Once the run stops every
// field counts again, so snooze wakes and failure times read the current value.
function sameApartFromStreaming(
  previous: EnvironmentThreadShell,
  next: EnvironmentThreadShell,
): boolean {
  if (
    previous.environmentId !== next.environmentId ||
    previous.pendingSubagentRequest !== next.pendingSubagentRequest ||
    !threadRuntimeIsActive(next.runtime)
  ) {
    return false;
  }
  const before = previous.source;
  const after = next.source;
  return (
    before.itemCount > 0 === after.itemCount > 0 &&
    before.visibleItemCount > 0 === after.visibleItemCount > 0 &&
    sameWireThreadShell(
      {
        ...before,
        updatedAt: after.updatedAt,
        itemCount: after.itemCount,
        visibleItemCount: after.visibleItemCount,
        latestVisibleMessage: after.latestVisibleMessage,
      },
      after,
    )
  );
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  /** Tags whose threads display lists leave out; null while the filter is off. */
  readonly hiddenThreadTagsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<string> | null>;
}) {
  // Point reads and aggregate lists share values without keeping an atom alive
  // for every listed thread. Replaced source objects can be collected.
  const scopedThreads = new WeakMap<
    OrchestrationV2ThreadShell,
    Map<string, EnvironmentThreadShell>
  >();
  const scopedThread = (
    environmentId: EnvironmentId,
    thread: OrchestrationV2ThreadShell,
    subagentRequests: ReadonlyMap<ThreadId, PendingSubagentRequest>,
  ) => {
    let byEnvironment = scopedThreads.get(thread);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      scopedThreads.set(thread, byEnvironment);
    }
    const request = subagentRequests.get(thread.id) ?? null;
    const key = request === null ? environmentId : `${environmentId}:${request}`;
    let value = byEnvironment.get(key);
    if (value === undefined) {
      value = presentThreadShell(environmentId, thread, request);
      byEnvironment.set(key, value);
    }
    return value;
  };

  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationV2ThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  // Every list reads this: side chats show only in their parent's side chat card,
  // so they are reachable by id but never listed.
  const environmentListedThreadsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<OrchestrationV2ThreadShell> = EMPTY_THREADS;
    return Atom.make((get): ReadonlyArray<OrchestrationV2ThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      const hidden = hiddenSideChatIds(threads);
      if (hidden.size === 0) return threads;
      const next = threads.filter((thread) => !hidden.has(thread.id));
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-listed-threads:${environmentId}`));
  });

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  // Side chats by parent, built once per change for every parent's row. Without side chats
  // it stays the same empty map, so those rows do no work.
  const environmentSideChatsByParentAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      let byParent: Map<ThreadId, OrchestrationV2ThreadShell[]> | undefined;
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        const parentId = thread.lineage.parentThreadId;
        if (!isSideChatThread(thread) || parentId === null) continue;
        byParent ??= new Map();
        const siblings = byParent.get(parentId);
        if (siblings) siblings.push(thread);
        else byParent.set(parentId, [thread]);
      }
      return byParent ?? EMPTY_SIDE_CHATS_BY_PARENT;
    }).pipe(Atom.withLabel(`environment-side-chats-by-parent:${environmentId}`)),
  );

  // What an environment's own subagents ask. Kept apart from the tasks other
  // environments run for it, so two environments delegating to each other
  // never read each other's totals.
  const localSubagentRequestsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_SUBAGENT_REQUESTS;
    return Atom.make((get) => {
      const next = pendingSubagentRequestsByThread(get(environmentThreadsAtom(environmentId)));
      if (sameRequests(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-local-subagent-requests:${environmentId}`));
  });

  // Flags for environments whose threads delegated tasks, counting what each task
  // or anything it delegated on asks. Each pass settles one more hop of a chain;
  // flags only grow, so environments delegating to each other settle too.
  const delegatedSubagentRequestsAtom = Atom.make((get) => {
    const tasksByDelegator = new Map<
      EnvironmentId,
      Array<{
        readonly runsIn: EnvironmentId;
        readonly thread: OrchestrationV2ThreadShell;
        readonly parentThreadId: ThreadId;
      }>
    >();
    for (const runsIn of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      for (const thread of get(environmentThreadsAtom(runsIn))) {
        const from = thread.delegatedFrom;
        if (from === undefined || from.environmentId === runsIn) continue;
        const task = { runsIn, thread, parentThreadId: from.threadId };
        const tasks = tasksByDelegator.get(from.environmentId);
        if (tasks === undefined) tasksByDelegator.set(from.environmentId, [task]);
        else tasks.push(task);
      }
    }
    let flags = new Map<EnvironmentId, ReadonlyMap<ThreadId, PendingSubagentRequest>>();
    const requestsOf = (environmentId: EnvironmentId) =>
      flags.get(environmentId) ?? get(localSubagentRequestsAtom(environmentId));
    for (let changed = tasksByDelegator.size > 0; changed;) {
      changed = false;
      const next = new Map(flags);
      for (const [environmentId, tasks] of tasksByDelegator) {
        const delegated = tasks.flatMap(({ runsIn, thread, parentThreadId }) => {
          const own = subagentRequest(thread);
          const nested = requestsOf(runsIn).get(thread.id);
          const request = own === "approval" ? own : (nested ?? own);
          return request === null ? [] : [{ parentThreadId, request }];
        });
        if (delegated.length === 0) continue;
        const requests = pendingSubagentRequestsByThread(
          get(environmentThreadsAtom(environmentId)),
          delegated,
        );
        if (sameRequests(requestsOf(environmentId), requests)) continue;
        next.set(environmentId, requests);
        changed = true;
      }
      flags = next;
    }
    return flags;
  }).pipe(Atom.withLabel("environment-delegated-subagent-requests"));

  const pendingSubagentRequestsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_SUBAGENT_REQUESTS;
    return Atom.make((get) => {
      const next =
        get(delegatedSubagentRequestsAtom).get(environmentId) ??
        get(localSubagentRequestsAtom(environmentId));
      if (sameRequests(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-pending-subagent-requests:${environmentId}`));
  });

  const subagentLiveStateAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => deriveSubagentLiveState(get(environmentThreadsAtom(environmentId)))).pipe(
      Atom.withLabel(`environment-subagent-live-state:${environmentId}`),
    ),
  );

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const next = get(environmentListedThreadsAtom(environmentId)).map((thread) => ({
        environmentId,
        threadId: thread.id,
      }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      for (const thread of get(environmentListedThreadsAtom(environmentId))) {
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        next.set(
          projectId,
          previousRefs !== undefined && threadRefsEqual(previousRefs, refs) ? previousRefs : refs,
        );
      }
      const previousProjectIds = [...previous.keys()];
      if (
        next.size === previous.size &&
        [...next].every(
          ([projectId, refs], index) =>
            previousProjectIds[index] === projectId && previous.get(projectId) === refs,
        )
      ) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ?? null;
      return source === null
        ? null
        : scopedThread(
            ref.environmentId,
            source,
            get(pendingSubagentRequestsAtom(ref.environmentId)),
          );
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  // Keeps the previous shell while only streaming ticks changed. During a run,
  // its timestamps, item counts and latest message are as of the last kept
  // change; anything that needs them current reads threadShellAtom.
  const quietThreadShellAtomFamily = Atom.family((key: string) => {
    let previous: EnvironmentThreadShell | null = null;
    return Atom.make((get) => {
      const next = get(threadShellAtomFamily(key));
      if (previous !== null && next !== null && sameApartFromStreaming(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-quiet-thread-shell:${key}`));
  });

  const subagentActivityAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: SubagentActivity | null = null;
    return Atom.make((get) => {
      const next = get(subagentLiveStateAtom(ref.environmentId)).activity.get(ref.threadId) ?? null;
      if (
        previous !== null &&
        next !== null &&
        previous.status === next.status &&
        previous.role === next.role &&
        previous.count === next.count &&
        previous.startedAt === next.startedAt
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-subagent-activity:${key}`));
  });

  // The panel above the composer has a row per subagent, so only a change of subagents re-renders the thread.
  const subagentPanelChildIdsAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: ReadonlyArray<ThreadId> = [];
    return Atom.make((get) => {
      const next = subagentPanelChildIds(
        get(environmentThreadsAtom(ref.environmentId)),
        ref.threadId,
      );
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-subagent-panel-child-ids:${key}`));
  });

  // Child approvals and questions are hidden with their sidebar rows. Read their
  // shell summaries, without subscribing to every child transcript. A task
  // delegated to a linked environment is a child too, with its own subagents.
  const childThreadInputsAtomFamily = Atom.family((key: string) => {
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const children = new Map<
        string,
        Array<{ environmentId: EnvironmentId; thread: OrchestrationV2ThreadShell }>
      >();
      const addChild = (
        parent: ScopedThreadRef,
        environmentId: EnvironmentId,
        thread: OrchestrationV2ThreadShell,
      ) => {
        const siblings = children.get(threadKey(parent));
        if (siblings) siblings.push({ environmentId, thread });
        else children.set(threadKey(parent), [{ environmentId, thread }]);
      };
      for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
        for (const thread of get(environmentThreadsAtom(environmentId))) {
          const parent = thread.lineage.parentThreadId;
          if (
            parent !== null &&
            (thread.lineage.relationshipToParent === "subagent" || thread.lineage.sideChat === true)
          ) {
            addChild({ environmentId, threadId: parent }, environmentId, thread);
          } else if (thread.delegatedFrom !== undefined) {
            addChild(thread.delegatedFrom, environmentId, thread);
          }
        }
      }
      const seen = new Set<string>([key]);
      const pending = [key];
      const next: EnvironmentThreadShell[] = [];
      for (const parent of pending) {
        for (const { environmentId, thread } of children.get(parent) ?? []) {
          const childKey = threadKey({ environmentId, threadId: thread.id });
          if (seen.has(childKey)) continue;
          seen.add(childKey);
          pending.push(childKey);
          if (subagentRequest(thread) !== null || sideChatRequest(thread) !== null) {
            next.push(
              scopedThread(environmentId, thread, get(pendingSubagentRequestsAtom(environmentId))),
            );
          }
        }
      }
      // Indicators read only ids, titles and the request kind, so other shell
      // updates keep the old array.
      if (
        previous.length === next.length &&
        previous.every(
          (thread, index) =>
            thread.environmentId === next[index]?.environmentId &&
            thread.id === next[index]?.id &&
            thread.title === next[index]?.title &&
            thread.hasPendingApprovals === next[index]?.hasPendingApprovals,
        )
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-child-thread-inputs:${key}`));
  });

  // Who watches a thread, read from the watchers' shells. Only ids and titles,
  // so other shell updates do not re-render the thread that shows them.
  const threadWatchersAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: ReadonlyArray<ThreadWatcher> = [];
    return Atom.make((get) => {
      const next = threadWatchers(get(environmentThreadsAtom(ref.environmentId)), ref.threadId);
      if (
        previous.length === next.length &&
        previous.every(
          (watcher, index) =>
            watcher.id === next[index]?.id && watcher.title === next[index]?.title,
        )
      ) {
        return previous;
      }
      previous = next.map(({ id, title }) => ({ id, title }));
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-watchers:${key}`));
  });

  // The newest open side chat of a thread. An id, so other shell updates do
  // not re-render the composer that hosts it.
  const sideChatThreadIdAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      let latest: OrchestrationV2ThreadShell | null = null;
      for (const thread of get(environmentThreadsAtom(ref.environmentId))) {
        if (
          isSideChatThread(thread) &&
          thread.lineage.parentThreadId === ref.threadId &&
          thread.archivedAt === null &&
          (latest === null ||
            DateTime.toEpochMillis(thread.createdAt) > DateTime.toEpochMillis(latest.createdAt))
        ) {
          latest = thread;
        }
      }
      return latest?.id ?? null;
    }).pipe(Atom.withLabel(`environment-side-chat-thread-id:${key}`));
  });

  const sideChatsAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous = EMPTY_THREAD_SHELLS;
    return Atom.make((get) => {
      const sideChats = get(environmentSideChatsByParentAtom(ref.environmentId)).get(ref.threadId);
      if (sideChats === undefined) {
        previous = EMPTY_THREAD_SHELLS;
        return previous;
      }
      const subagentRequests = get(pendingSubagentRequestsAtom(ref.environmentId));
      const next = sideChats.map((thread) =>
        scopedThread(ref.environmentId, thread, subagentRequests),
      );
      if (
        previous.length === next.length &&
        previous.every(
          (thread, index) =>
            thread.id === next[index]?.id &&
            thread.title === next[index]?.title &&
            thread.hasPendingApprovals === next[index]?.hasPendingApprovals &&
            thread.hasPendingUserInput === next[index]?.hasPendingUserInput &&
            thread.pendingSubagentRequest === next[index]?.pendingSubagentRequest,
        )
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-side-chats:${key}`));
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        if (refs.length === 0) continue;
        const threads = get(environmentThreadIndexAtom(projectRef.environmentId));
        const subagentRequests = get(pendingSubagentRequestsAtom(projectRef.environmentId));
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = threads.get(ref.threadId);
          if (thread !== undefined) {
            const scoped = scopedThread(ref.environmentId, thread, subagentRequests);
            if (championNeedsInbox(scoped)) next.push(scoped);
          }
        }
      }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const subagentRequests = get(pendingSubagentRequestsAtom(environmentId));
      for (const thread of get(environmentListedThreadsAtom(environmentId))) {
        const scoped = scopedThread(environmentId, thread, subagentRequests);
        if (championNeedsInbox(scoped)) next.push(scoped);
      }
    }
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  // Point reads and threadShellsAtom stay complete, so code that asks whether a thread
  // exists (outboxes, drafts, removals) never mistakes a hidden thread for a missing one.
  let previousHiddenThreadKeys: ReadonlySet<string> = NO_HIDDEN_THREADS;
  const hiddenThreadKeysAtom = Atom.make((get) => {
    const environments = Array.from(
      enabledEnvironmentIds(get(input.catalogValueAtom)),
      (environmentId) => ({
        environmentId,
        hiddenTags: get(input.hiddenThreadTagsAtom(environmentId)),
      }),
    );
    // Read shells only while some environment hides tags, so streaming ticks cost nothing otherwise.
    if (!environments.some((environment) => environment.hiddenTags !== null)) {
      previousHiddenThreadKeys = NO_HIDDEN_THREADS;
      return NO_HIDDEN_THREADS;
    }
    const next = hiddenThreadKeys(
      environments.map((environment) => ({
        ...environment,
        threads: get(environmentThreadsAtom(environment.environmentId)),
      })),
    );
    if (
      next.size === previousHiddenThreadKeys.size &&
      [...next].every((key) => previousHiddenThreadKeys.has(key))
    ) {
      return previousHiddenThreadKeys;
    }
    previousHiddenThreadKeys = next;
    return next;
  }).pipe(Atom.withLabel("environment-hidden-thread-keys"));

  const anyEnvironmentHidingAtom = Atom.make((get) =>
    Array.from(enabledEnvironmentIds(get(input.catalogValueAtom))).some(
      (environmentId) => get(input.hiddenThreadTagsAtom(environmentId)) !== null,
    ),
  ).pipe(Atom.withLabel("environment-any-hiding-thread-tags"));

  /** threadShellsAtom without the threads the tag filter hides, for pickers and palettes. */
  let previousVisibleThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const visibleThreadShellsAtom = Atom.make((get) => {
    const threads = get(threadShellsAtom);
    const hidden = get(hiddenThreadKeysAtom);
    if (hidden.size === 0) return threads;
    const next = threads.filter(
      (thread) =>
        !hidden.has(threadKey({ environmentId: thread.environmentId, threadId: thread.id })),
    );
    if (arrayElementsEqual(previousVisibleThreadShells, next)) return previousVisibleThreadShells;
    previousVisibleThreadShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-visible-thread-shell-list"));

  // Lists that arrange threads read this, so a running thread's streaming
  // ticks reach only what reads its live shell.
  let previousQuietThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const quietThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    const hidden = get(hiddenThreadKeysAtom);
    for (const ref of get(threadRefsAtom)) {
      if (hidden.has(threadKey(ref))) continue;
      const shell = get(quietThreadShellAtomFamily(threadKey(ref)));
      if (shell !== null && championNeedsInbox(shell)) next.push(shell);
    }
    if (arrayElementsEqual(previousQuietThreadShells, next)) return previousQuietThreadShells;
    previousQuietThreadShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-quiet-thread-shell-list"));

  let previousDelegatedUnderParent: ReadonlySet<string> = new Set();
  const delegatedUnderParentAtom = Atom.make((get) => {
    const environmentIds = new Set(enabledEnvironmentIds(get(input.catalogValueAtom)));
    const next = new Set<string>();
    for (const environmentId of environmentIds) {
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        const parent = thread.delegatedFrom;
        if (
          parent !== undefined &&
          environmentIds.has(parent.environmentId) &&
          // An archived parent leaves navigation; its task there stays listed on its own.
          get(environmentThreadIndexAtom(parent.environmentId)).get(parent.threadId)?.archivedAt ===
            null
        ) {
          next.add(threadKey({ environmentId, threadId: thread.id }));
        }
      }
    }
    if (
      next.size === previousDelegatedUnderParent.size &&
      [...next].every((key) => previousDelegatedUnderParent.has(key))
    ) {
      return previousDelegatedUnderParent;
    }
    previousDelegatedUnderParent = next;
    return next;
  }).pipe(Atom.withLabel("environment-delegated-under-parent"));

  let previousNavigationShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const navigationThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    const underParent = get(delegatedUnderParentAtom);
    const hidden = get(hiddenThreadKeysAtom);
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const subagentRequests = get(pendingSubagentRequestsAtom(environmentId));
      for (const thread of get(environmentListedThreadsAtom(environmentId))) {
        if (
          thread.archivedAt !== null ||
          isShownUnderParent({ environmentId, threadId: thread.id }, thread.lineage, underParent) ||
          hidden.has(threadKey({ environmentId, threadId: thread.id }))
        ) {
          continue;
        }
        const scoped = scopedThread(environmentId, thread, subagentRequests);
        if (championNeedsInbox(scoped)) next.push(scoped);
      }
    }
    if (arrayElementsEqual(previousNavigationShells, next)) return previousNavigationShells;
    previousNavigationShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-navigation-thread-shells"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    visibleThreadShellsAtom,
    hiddenThreadKeysAtom,
    anyEnvironmentHidingAtom,
    quietThreadShellsAtom,
    navigationThreadShellsAtom,
    delegatedUnderParentAtom,
    pendingSubagentRequestsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
    quietThreadShellAtom: (ref: ScopedThreadRef) => quietThreadShellAtomFamily(threadKey(ref)),
    childThreadInputsAtom: (ref: ScopedThreadRef) => childThreadInputsAtomFamily(threadKey(ref)),
    subagentLiveStateAtom,
    subagentActivityAtom: (ref: ScopedThreadRef) => subagentActivityAtomFamily(threadKey(ref)),
    subagentPanelChildIdsAtom: (ref: ScopedThreadRef) =>
      subagentPanelChildIdsAtomFamily(threadKey(ref)),
    sideChatThreadIdAtom: (ref: ScopedThreadRef) => sideChatThreadIdAtomFamily(threadKey(ref)),
    threadWatchersAtom: (ref: ScopedThreadRef) => threadWatchersAtomFamily(threadKey(ref)),
    sideChatsAtom: (ref: ScopedThreadRef) => sideChatsAtomFamily(threadKey(ref)),
  };
}
