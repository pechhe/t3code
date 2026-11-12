import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2RemoteThreadWatchOutcome,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { threadsWithWaits } from "../orchestration-v2/parkedWait.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { FollowRetrySchedule } from "./RemoteDelegation.ts";

/** How long one look at a thread in a linked environment waits for it to settle. */
const WAIT_MS = 30_000;
/** A thread that settled but is not yet ended (its delegated work, a watch of its own) is asked again after this. */
const NOT_ENDED_RECHECK = Duration.seconds(10);
/** The sweep finds followers an event missed, such as watches saved before a restart. */
const SWEEP_MINUTES = 5;

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;
type RemoteWatch = {
  readonly watchId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
};

/** The watches and parked waits of `thread` that name a thread in a linked environment. */
const remoteWatchesOf = (
  thread: Pick<OrchestrationV2AppThread, "threadWatches" | "parkedWaits" | "deletedAt">,
): ReadonlyArray<RemoteWatch> =>
  thread.deletedAt !== null
    ? []
    : [...(thread.threadWatches ?? []), ...(thread.parkedWaits ?? [])].flatMap((watch) =>
        watch.target.kind === "thread" && watch.target.environmentId !== undefined
          ? [
              {
                watchId: watch.id,
                environmentId: watch.target.environmentId,
                threadId: watch.target.threadId,
              },
            ]
          : [],
      );

/**
 * Wakes a thread when a thread in a linked environment ends. The other environment decides, with
 * the same rule a local watch uses, and answers through `t3_thread_watch_status`; this service
 * waits on that thread over the link, asks, and fires the watch with what it was told. It keeps
 * asking across restarts and a link that drops, and never wakes on a guess.
 */
export class RemoteThreadWatches extends Context.Service<
  RemoteThreadWatches,
  {
    /** Follows every stored watch on a thread in a linked environment, and each one saved later. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteThreadWatches") {}

const make = Effect.gen(function* () {
  const retry = yield* FollowRetrySchedule;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  const followers = yield* Scope.Scope;
  /** One follower per watch. */
  const following = new Set<string>();

  const scopeFor = (thread: Pick<OrchestrationV2AppThread, "id" | "providerInstanceId">) =>
    ({
      environmentId: hereId,
      requestNamespace: `remote-watch:${thread.id}`,
      thread: {
        threadId: thread.id,
        providerSessionId: `remote-watch:${thread.id}`,
        providerInstanceId: thread.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    }) satisfies ThreadScope;

  const read = (watcherId: ThreadId) =>
    threads.getThreadRecords(watcherId, []).pipe(Effect.map(({ thread }) => thread));

  /** Fires the watch with how its thread ended there; a watch that has already ended is done. */
  const fire = (
    watcherId: ThreadId,
    watchId: string,
    key: string,
    remote: OrchestrationV2RemoteThreadWatchOutcome,
  ) =>
    threads
      .dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make(`server:remote-watch-fire:${watcherId}:${watchId}:${key}`),
        threadId: watcherId,
        watchId,
        remote,
      })
      .pipe(
        // Ended meanwhile (unwatched, stopped, or fired by an earlier attempt): nothing is owed.
        Effect.catchTags({ OrchestratorDispatchError: () => Effect.void }),
        Effect.asVoid,
      );

  /**
   * Why following can never succeed, if `error` means that: a link revoked, expired or
   * forgotten, or a thread gone there. A machine asleep or a dropped route is worth retrying.
   */
  const finalOutcome = Effect.fn("RemoteThreadWatches.finalOutcome")(
    function* (environmentId: EnvironmentId, error: OrchestratorMcpFailure) {
      if (error.code === "thread_not_found") {
        return { kind: "unreadable" } satisfies OrchestrationV2RemoteThreadWatchOutcome;
      }
      const forgotten =
        error.code === "invalid_request" && Option.isNone(yield* links.get(environmentId));
      if (error.code !== "capability_denied" && !forgotten) return undefined;
      return {
        kind: "unreachable",
        reason: error.message,
      } satisfies OrchestrationV2RemoteThreadWatchOutcome;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** One look: false while the watch stays, true once it has fired or ended. */
  const followOnce = Effect.fn("RemoteThreadWatches.followOnce")(function* (
    watcherId: ThreadId,
    watchId: string,
  ) {
    const thread = yield* read(watcherId);
    const watch = remoteWatchesOf(thread).find((candidate) => candidate.watchId === watchId);
    if (watch === undefined) return true;
    const scope = scopeFor(thread);
    const { environmentId, threadId } = watch;
    const outcome = yield* Effect.gen(function* () {
      const waited = yield* forwarding.waitForThread(scope, environmentId, {
        threadId,
        timeoutMs: WAIT_MS,
        untilDelegatedWorkSettled: true,
      });
      if (waited.timedOut) return undefined;
      return yield* forwarding.call(
        scope,
        ProjectToolkit.tools.t3_thread_watch_status,
        environmentId,
        {
          threadId,
        },
      );
    }).pipe(
      Effect.catchTags({
        OrchestratorMcpFailure: (error) =>
          finalOutcome(environmentId, error).pipe(
            Effect.flatMap((final) =>
              final === undefined
                ? Effect.fail(error)
                : Effect.succeed({ state: "ended" as const, outcome: final }),
            ),
          ),
      }),
    );
    if (outcome === undefined) return false;
    if (outcome.state === "working") {
      yield* Effect.sleep(NOT_ENDED_RECHECK);
      return false;
    }
    if (outcome.state === "moved") {
      // Where it went: the watch follows it, here if it came to this environment.
      yield* fire(watcherId, watchId, `moved:${outcome.environmentId}:${outcome.threadId}`, {
        kind: "moved",
        movedTo: {
          threadId: outcome.threadId,
          ...(outcome.environmentId === hereId ? {} : { environmentId: outcome.environmentId }),
        },
      });
      return false;
    }
    yield* fire(watcherId, watchId, outcome.outcome.kind, outcome.outcome);
    return true;
  });

  const follow = (watcherId: ThreadId, watchId: string): Effect.Effect<void> =>
    followOnce(watcherId, watchId).pipe(
      Effect.repeat({ while: (done) => !done }),
      Effect.retry(retry),
      Effect.ignoreCause({ log: true }),
    );

  const followOne = (watcherId: ThreadId, watchId: string) => {
    const key = `${watcherId}\u0000${watchId}`;
    if (following.has(key)) return Effect.void;
    following.add(key);
    return follow(watcherId, watchId).pipe(
      Effect.ensuring(Effect.sync(() => following.delete(key))),
      Effect.forkIn(followers),
      Effect.asVoid,
    );
  };

  const followThread = (
    watcher: Parameters<typeof remoteWatchesOf>[0] & { readonly id: ThreadId },
  ) =>
    Effect.forEach(remoteWatchesOf(watcher), ({ watchId }) => followOne(watcher.id, watchId), {
      discard: true,
    });

  const sweep = Effect.gen(function* () {
    const rows = yield* threadsWithWaits(sql);
    yield* Effect.forEach(
      rows,
      (row) =>
        read(row.thread_id as ThreadId).pipe(
          Effect.flatMap(followThread),
          Effect.catchCause((cause) =>
            Effect.logDebug("remote thread watch sweep skipped a thread", { cause }),
          ),
        ),
      { discard: true },
    );
  });

  const start: RemoteThreadWatches["Service"]["start"] = Effect.fn("RemoteThreadWatches.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          // A watch saved from now on starts its follower at once; the sweeps find the rest.
          yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
            event.type === "thread.metadata-updated" ? followThread(event.payload) : Effect.void,
          ).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(followers, { startImmediately: true }),
          );
          yield* sweep.pipe(
            Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)),
            Effect.asVoid,
          );
        }).pipe(Effect.ignoreCause({ log: true })),
      );
    },
  );

  return RemoteThreadWatches.of({ start });
});

export const layer = Layer.effect(RemoteThreadWatches, make);
