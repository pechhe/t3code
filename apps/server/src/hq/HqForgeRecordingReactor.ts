import {
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import { boundedRef } from "./boundedRef.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** A child that reviews is recorded as its own run, never as work its lead delegated. */
const REVIEWER_ROLES = new Set(["reviewer", "spec-reviewer", "ticket-reviewer"]);

/** The longest session reference Weave accepts. */
const SESSION_REF_MAX_LENGTH = 200;

/** One workspace a session's work happened in, as Weave shows it beside the session. */
interface BuildSessionWorkspace {
  /** Null until delivery resolves the Spec's own repository. */
  readonly repository: string | null;
  readonly host: string;
  readonly workspaceRef: string;
}

/** What a record is for: the Spec, and the link whose Weave it belongs to. */
interface RecordingTarget {
  /** Absent when the thread is linked but Weave has not said which Spec its item names yet. */
  readonly specId: string | null;
  readonly origin: string | null;
  readonly project: string | null;
  readonly leadThreadId: ThreadId | null;
}

const isoOf = (at: DateTime.Utc | null | undefined): string | null =>
  at == null ? null : DateTime.formatIso(at);

/**
 * Records in Weave what T3 itself knows about a thread's work (Spec #4395): the lead's Forge
 * session, every delegated helper at any depth, and a reviewer's own run times. No agent makes
 * these calls, so a person never depends on a model remembering to report.
 *
 * A lead's session is queued when its thread links a Forge item, because the link is what says
 * which Spec the work counts toward. A helper's or reviewer's record is queued from
 * `recordCompletion`, which the agent lifecycle reactor calls before it queues the thread's own
 * end: a record has to reach Weave while the thread is still the agent that made it.
 */
export class HqForgeRecordingReactor extends Context.Service<
  HqForgeRecordingReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /**
     * Queues what a finished delegated run owes Weave. The caller runs it in the fiber that queues
     * the thread's end, before that end, so the order is fixed rather than raced.
     */
    readonly recordCompletion: (threadId: ThreadId, run: OrchestrationV2Run) => Effect.Effect<void>;
  }
>()("t3/hq/HqForgeRecordingReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const buildSpec = yield* ForgeSpecOfThread.ForgeSpecOfThread;
  const records = yield* HqForgeRecords.HqForgeRecords;
  const environmentId = yield* environment.getEnvironmentId;
  const crypto = yield* Crypto.Crypto;

  /**
   * The session reference Weave files a helper's run under. A lead's is its bare thread id, which is
   * how a lead reports itself to Forge, so the session T3 opens and the one the lead starts are one.
   */
  const helperSessionRefOf = (threadId: ThreadId, runId: string) =>
    boundedRef(crypto, `t3:${environmentId}/${threadId}/${runId}`, SESSION_REF_MAX_LENGTH);

  /** Where the thread's work happened, as Weave shows it beside the session. */
  const workspacesOf = Effect.fn("HqForgeRecordingReactor.workspacesOf")(function* (
    thread: OrchestrationV2AppThread,
    specProject: string | null,
  ): Effect.fn.Return<ReadonlyArray<BuildSessionWorkspace>> {
    const project = yield* projects.get(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const workspaceRef = thread.worktreePath ?? project?.workspaceRoot;
    if (workspaceRef === undefined) return [];
    const descriptor = yield* environment.getDescriptor;
    // Weave files a workspace under a repository: the project's, else the Spec's, which delivery
    // reads from Weave when this thread's item could not be read yet.
    const repository = project?.hqRepositoryKey ?? specProject;
    return [{ repository, host: descriptor.label, workspaceRef }];
  });

  /**
   * The Spec a record is for: `undefined` when the thread's work records nothing, and a target with
   * no `specId` when the thread is linked but Weave cannot answer for its item yet. That record is
   * still owed, so it is queued without a Spec and the delivery pass resolves one when it sends; it
   * keeps the Weave its link belongs to, which is known without reading the item.
   */
  const recordingTarget = Effect.fn("HqForgeRecordingReactor.recordingTarget")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<RecordingTarget | undefined> {
    return yield* buildSpec.of(threadId).pipe(
      Effect.map((spec) =>
        Option.isNone(spec)
          ? undefined
          : {
              specId: spec.value.specId,
              origin: spec.value.origin,
              project: spec.value.project,
              leadThreadId: spec.value.leadThreadId,
            },
      ),
      Effect.catchTags({
        BuildSpecUnavailable: (error) =>
          Effect.succeed({ specId: null, origin: error.origin, project: null, leadThreadId: null }),
      }),
    );
  });

  /** A lead's Forge item bind and the session it opens, queued as one record. */
  const recordLeadLink = Effect.fn("HqForgeRecordingReactor.recordLeadLink")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    // A child records helpers under its lead's session; only the root thread opens one.
    if (thread.lineage.rootThreadId !== thread.id) return;
    if (thread.workItem == null && thread.workspaceIssue == null) return;
    const target = yield* recordingTarget(thread.id);
    if (target === undefined) return;
    const specId = target.specId ?? undefined;
    const workspaces = yield* workspacesOf(thread, target.project);
    yield* records.enqueue({
      kind: "session",
      // Linking another item opens another session; the same item stays the one already queued,
      // whether or not Weave could be read for it at the time.
      recordKey: `session:${thread.id}:${thread.workItem?.itemId ?? `#${thread.workspaceIssue}`}`,
      threadId: thread.id,
      // The link knows which Weave it belongs to even when its item cannot be read yet.
      origin: target.origin,
      specId,
      // A link Weave could not be read for is queued without its Spec, which delivery adds.
      bind: specId === undefined ? {} : { specId },
      startSession: {
        ...(specId === undefined ? {} : { specId }),
        harness: "t3code",
        sessionRef: thread.id,
        modelRef: thread.modelSelection.model,
        workspaces,
      },
    });
  });

  /** The run a reviewer's own `weave_forge_run` reported, which is what its times belong to. */
  const reviewerRunIdOf = Effect.fn("HqForgeRecordingReactor.reviewerRunIdOf")(function* (
    threadId: ThreadId,
    t3RunId: string,
  ) {
    const runs = yield* records.reviewerRuns.pipe(Effect.orElseSucceed(() => []));
    // The report made during this very T3 run: a follow-up round that reported nothing must not
    // borrow an earlier round's run.
    const own = runs.findLast(
      (run) => run.reviewerThreadId === threadId && run.t3RunId === t3RunId,
    );
    return own === undefined ? Option.none<string>() : Option.some(own.runId);
  });

  const recordCompletion: HqForgeRecordingReactor["Service"]["recordCompletion"] = Effect.fn(
    "HqForgeRecordingReactor.recordCompletion",
  )(
    function* (threadId, run) {
      // Only a delegate_task child is a helper: it is an app-owned subagent with a thread of its
      // own, whose record carries the times the work took.
      const subagent = yield* projections
        .getSubagentByChildThread(threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (subagent === undefined || subagent.origin !== "app_owned") return;
      const thread = yield* projections
        .getThread(threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (thread === undefined) return;
      // The queue delivers as the thread's own agent, so a thread with no Weave role has nothing to
      // record as; its lead's rows are unaffected.
      const role = HqAgentConnections.hqAgentRole(thread);
      if (role === undefined) return;
      const target = yield* recordingTarget(threadId);
      if (target === undefined) return;

      if (REVIEWER_ROLES.has(role)) {
        const runId = yield* reviewerRunIdOf(threadId, run.id);
        // A reviewer that has not reported a run yet is not guessed at: there is nothing to name.
        if (Option.isNone(runId)) return;
        yield* records.enqueue({
          kind: "runtimes",
          recordKey: `runtimes:${threadId}:${runId.value}`,
          threadId,
          origin: target.origin,
          specId: target.specId,
          args: {
            runId: runId.value,
            startedAt: isoOf(run.startedAt ?? subagent.startedAt),
            endedAt: isoOf(run.completedAt ?? subagent.completedAt),
          },
        });
        return;
      }

      // Its lead's session may not be queued yet (a lead linked before this server ran, still in
      // its first run), and this helper's rows wait for it.
      if (target.leadThreadId !== null) {
        // The helper's own record is owed whether or not that session could be queued.
        yield* projections.getThread(target.leadThreadId).pipe(
          Effect.flatMap(recordLeadLink),
          Effect.catchCause(() => Effect.void),
        );
      }

      // One Forge helper per finished run: a follow-up run, or one under another model, is its own.
      yield* records.enqueue({
        kind: "helper",
        recordKey: `helper:${threadId}:${run.id}`,
        threadId,
        ...(target.leadThreadId === null ? {} : { leadThreadId: target.leadThreadId }),
        // The run's own turns are attributed to what this record opened, not to the thread's latest.
        t3RunId: run.id,
        origin: target.origin,
        specId: target.specId,
        args: {
          harness: "t3code",
          sessionRef: yield* helperSessionRefOf(threadId, run.id),
          modelRef: run.modelSelection.model,
          scope: subagent.title ?? thread.agentTask?.workId ?? thread.title,
          // The run that finished has its own times; the task node keeps the first run's.
          startedAt: isoOf(run.startedAt ?? subagent.startedAt),
          endedAt: isoOf(run.completedAt ?? subagent.completedAt),
          transcriptRef: `t3-thread://v1/${threadId}`,
        },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record what a delegated task owes Weave", {
            threadId,
            cause,
          }),
        ),
      ),
  );

  const handle: HqForgeRecordingReactor["Service"]["handle"] = Effect.fn(
    "HqForgeRecordingReactor.handle",
  )(
    function* (event) {
      switch (event.type) {
        case "thread.created":
        case "thread.metadata-updated":
          return yield* recordLeadLink(event.payload);
        // A lead linked before this server ran has no event of its own left to queue its session
        // from, and its turns' usage waits for that session, so the end of a run queues it.
        case "run.updated": {
          if (!TERMINAL_RUN_STATUSES.has(event.payload.status)) return;
          const thread = yield* projections.getThread(event.threadId);
          return yield* recordLeadLink(thread);
        }
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a thread's Forge session", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: HqForgeRecordingReactor["Service"]["start"] = Effect.fn(
    "HqForgeRecordingReactor.start",
  )(function* () {
    // Resolving a link asks Weave, so one slow read must not hold up the events behind it.
    const recordings = yield* FiberSet.make<void, never>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.created" ||
        event.type === "thread.metadata-updated" ||
        event.type === "run.updated"
          ? FiberSet.run(recordings, handle(event)).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Forge recording event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle, recordCompletion } satisfies HqForgeRecordingReactor["Service"];
});

export const layer = Layer.effect(HqForgeRecordingReactor, make);
