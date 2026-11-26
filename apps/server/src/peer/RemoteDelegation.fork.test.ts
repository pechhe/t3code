import * as CustodyPeer from "../workspace/custodyPeerProtocol.ts";
import * as EnvironmentAdvice from "../agents/AdviceService.ts";
import * as AdviceService from "../agents/AdviceService.ts";
import * as RemoteDelegationLayer from "./RemoteDelegationLayer.ts";
import * as ContextExperimentService from "../experiments/ExperimentService.ts";
import * as ContextForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ContextWeaveAgentConnections from "../weave/WeaveAgentConnections.ts";
import * as ContextReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AgentTaskBinding,
  type AgentTaskHandoff,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type Project,
  type RepositoryIdentity,
  RunId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { boundedBrowserEligible } from "../mcp/ManagedBrowserAccess.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import * as ThreadImportService from "../orchestration-v2/ThreadImportService.ts";
import * as ThreadHandoff from "./handoff/ThreadHandoff.ts";
import * as HandoffImport from "./handoff/HandoffImport.ts";

// The laptop's agent delegates a task to the box through a link. The box is
// its real /mcp behind real OAuth, with one thread the test finishes; the
// laptop is its real orchestrator and toolkits. The parent here wakes as it
// would for a local child.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

type LaunchedWith = Pick<
  ThreadLaunch.ThreadLaunchInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

/** The thread the box launches for the task, which the test finishes. */
interface TimelineEntry {
  readonly id: TurnItemId;
  readonly runId: RunId;
  readonly text: string;
  readonly type: "assistant_message" | "error";
}

interface BoxThread {
  readonly custodyReceipts: Ref.Ref<ReadonlyArray<typeof CustodyPeer.Input.Type>>;
  readonly custodyAcknowledged: Deferred.Deferred<void>;
  readonly custodyFailures: Ref.Ref<number>;
  readonly timeline: Ref.Ref<ReadonlyArray<TimelineEntry> | null>;
  readonly pageSize: Ref.Ref<number>;
  readonly holdRefill: Ref.Ref<boolean>;
  readonly beforeTail: Ref.Ref<Effect.Effect<void>>;
  readonly launched: Ref.Ref<ThreadId | null>;
  /** The link session that launched it, as the box stamps it. */
  readonly linkOrigin: Ref.Ref<{ readonly sessionId: string; readonly label: string } | null>;
  /** The parent the launch names, so the thread there can link back to it. */
  readonly delegatedFrom: Ref.Ref<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>;
  /** The model and modes it was launched with. */
  readonly launchedWith: Ref.Ref<LaunchedWith | null>;
  /** The first message the thread there was launched with. */
  readonly message: Ref.Ref<string | null>;
  readonly status: Ref.Ref<OrchestrationV2Run["status"]>;
  readonly reply: Ref.Ref<string | null>;
  readonly error: Ref.Ref<string | null>;
  readonly laterError: Ref.Ref<string | null>;
  /** A later run's reply, after the task's own, as a follow-up message would leave. */
  readonly laterReply: Ref.Ref<string | null>;
  /** The reply of a run queued there behind the later one; once set, the thread settles on it. */
  readonly queuedReply: Ref.Ref<string | null>;
  /** A run there restarted, which its continuation finished with this reply. */
  readonly restart: Ref.Ref<{ readonly of: RunId; readonly reply: string } | null>;
  /** The model the provider there reported running the task's run. */
  readonly executedModel: Ref.Ref<string | null>;
  /** The run each wait asked for, in order. */
  readonly waitedFor: Ref.Ref<ReadonlyArray<RunId | undefined>>;
  /** The thread's run ends with a task of its own still running, whose result wakes it again. */
  readonly nested: Ref.Ref<boolean>;
  /** Completed once a wait there blocks on that task. */
  readonly nestedWaiting: Deferred.Deferred<void>;
  /** That task settled and the run it woke answered, with `laterReply`. */
  readonly nestedSettled: Deferred.Deferred<void>;
  /** Waiting there fails with this, as a thread deleted there does. */
  readonly gone: Ref.Ref<boolean>;
  readonly interrupted: Ref.Ref<number>;
  /** What each interrupt or stop there did, once per command id. */
  readonly stops: Ref.Ref<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>;
  /** The launch starts no run, as one recorded before its run was kept. */
  readonly runless: Ref.Ref<boolean>;
  /** Completed on the first interrupt there. */
  readonly interruptedOnce: Deferred.Deferred<void>;
  readonly finished: Deferred.Deferred<void>;
  /** Ends the later run a message sent there started, for a wait pinned to it. */
  readonly laterFinished: Deferred.Deferred<void>;
  readonly custodyWaitEntered: Deferred.Deferred<void>;
  /** While set, reading the thread there waits: completed once a read starts, released by `releaseRead`. */
  readonly holdRead: Ref.Ref<boolean>;
  readonly readStarted: Deferred.Deferred<void>;
  readonly releaseRead: Deferred.Deferred<void>;
  readonly holdFirstStop: Ref.Ref<boolean>;
  readonly stopStarted: Deferred.Deferred<void>;
  readonly releaseStop: Deferred.Deferred<void>;
  /** Messages sent to the thread there after its launch, each starting a later run. */
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  /** Runs as the launch there is answered, before the laptop hears back. */
  readonly afterLaunch: Ref.Ref<Effect.Effect<void>>;
  /** The role binding the box resolved for the launch, if any. */
  readonly agentTask: Ref.Ref<AgentTaskBinding | null>;
  /** The thread there waits on a question or an approval. */
  readonly pendingRequest: Ref.Ref<boolean>;
}

const makeBoxThread = Effect.gen(function* () {
  return {
    custodyReceipts: yield* Ref.make<ReadonlyArray<typeof CustodyPeer.Input.Type>>([]),
    custodyAcknowledged: yield* Deferred.make<void>(),
    custodyFailures: yield* Ref.make(0),
    timeline: yield* Ref.make<ReadonlyArray<TimelineEntry> | null>(null),
    pageSize: yield* Ref.make(1),
    holdRefill: yield* Ref.make(false),
    beforeTail: yield* Ref.make<Effect.Effect<void>>(Effect.void),
    launched: yield* Ref.make<ThreadId | null>(null),
    linkOrigin: yield* Ref.make<{ readonly sessionId: string; readonly label: string } | null>(
      null,
    ),
    delegatedFrom: yield* Ref.make<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>(null),
    launchedWith: yield* Ref.make<LaunchedWith | null>(null),
    message: yield* Ref.make<string | null>(null),
    status: yield* Ref.make<OrchestrationV2Run["status"]>("running"),
    reply: yield* Ref.make<string | null>("Working…"),
    error: yield* Ref.make<string | null>(null),
    laterError: yield* Ref.make<string | null>(null),
    laterReply: yield* Ref.make<string | null>(null),
    queuedReply: yield* Ref.make<string | null>(null),
    restart: yield* Ref.make<{ readonly of: RunId; readonly reply: string } | null>(null),
    executedModel: yield* Ref.make<string | null>(null),
    waitedFor: yield* Ref.make<ReadonlyArray<RunId | undefined>>([]),
    nested: yield* Ref.make(false),
    nestedWaiting: yield* Deferred.make<void>(),
    nestedSettled: yield* Deferred.make<void>(),
    gone: yield* Ref.make(false),
    interrupted: yield* Ref.make(0),
    stops: yield* Ref.make<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>([]),
    runless: yield* Ref.make(false),
    interruptedOnce: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<void>(),
    laterFinished: yield* Deferred.make<void>(),
    custodyWaitEntered: yield* Deferred.make<void>(),
    holdRead: yield* Ref.make(false),
    readStarted: yield* Deferred.make<void>(),
    releaseRead: yield* Deferred.make<void>(),
    holdFirstStop: yield* Ref.make(false),
    stopStarted: yield* Deferred.make<void>(),
    releaseStop: yield* Deferred.make<void>(),
    sent: yield* Ref.make<ReadonlyArray<string>>([]),
    afterLaunch: yield* Ref.make<Effect.Effect<void>>(Effect.void),
    agentTask: yield* Ref.make<AgentTaskBinding | null>(null),
    pendingRequest: yield* Ref.make(false),
  } satisfies BoxThread;
});

/** The box's projects: more than a page, with this repository's last. */
const boxProjects: ReadonlyArray<Project> = [
  ...Array.from({ length: 120 }, (_, index) => ({
    id: ProjectId.make(`project:box-other-${index}`),
    title: `other ${index}`,
    workspaceRoot: `/srv/other-${index}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  })),
  {
    id: boxProject,
    title: "app",
    workspaceRoot: "/srv/app",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/app.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  },
];

/** A box with a role policy runs a version that resolves roles a link delegates. */
const serveBox = (thread: BoxThread, policy?: Layer.Layer<ManagedAgent.ManagedAgentService>) =>
  servePeer(
    policy === undefined
      ? box
      : descriptorOf("environment-box", "Box", { linkedRoleDelegation: true }),
    boxToolkitLayer(thread, policy),
  );

const boxRunId = RunId.make("run:box");
const boxLaterRunId = RunId.make("run:box-later");
const boxQueuedRunId = RunId.make("run:box-queued");
const continuationOf = (runId: RunId) => RunId.make(`${runId}:restarted`);

const boxToolkitLayer = (
  thread: BoxThread,
  policy?: Layer.Layer<ManagedAgent.ManagedAgentService>,
) => {
  const runId = boxRunId;
  const interrupts = new Set<string>();
  const shellOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(thread.launched)) !== threadId) return null;
      const linkOrigin = yield* Ref.get(thread.linkOrigin);
      const agentTask = yield* Ref.get(thread.agentTask);
      const delegatedFrom = yield* Ref.get(thread.delegatedFrom);
      // A managed task runs in the mode the box resolved for it, within the link.
      const runtimeMode =
        agentTask === null
          ? "full-access"
          : ((yield* Ref.get(thread.launchedWith))?.runtimeMode ?? "full-access");
      return {
        ...liveThreadShell(threadId, { runtimeMode }),
        projectId: boxProject,
        ...(linkOrigin === null ? {} : { linkOrigin }),
        ...(agentTask === null ? {} : { agentTask }),
        ...(delegatedFrom == null ? {} : { delegatedFrom }),
      };
    });
  const runOf = (status: OrchestrationV2Run["status"]) =>
    ({
      id: runId,
      threadId: ThreadId.make("thread:box"),
      ordinal: 1,
      status,
      modelSelection,
      activeAttemptId: "attempt:box",
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: DateTime.makeUnsafe(0),
      completedAt: ["completed", "failed", "cancelled", "interrupted"].includes(status)
        ? DateTime.makeUnsafe(1)
        : null,
    }) as unknown as OrchestrationV2Run;
  const projectionOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      const status = yield* Ref.get(thread.status);
      const runless = yield* Ref.get(thread.runless);
      const model = yield* Ref.get(thread.executedModel);
      const pending = yield* Ref.get(thread.pendingRequest);
      return shell === null
        ? (null as never)
        : {
            ...idleThreadProjection(shell),
            runs: runless ? [] : [runOf(status)],
            runtimeRequests: (pending ? [{ status: "pending" }] : []) as never,
            providerTurns: (model === null
              ? []
              : [{ runAttemptId: "attempt:box", ordinal: 1, model }]) as never,
          };
    });
  // One record per command id, as its receipt replays a repeat.
  const recordStop = (commandId: string, kind: "interrupt" | "thread.stop" | "delegated-tasks") =>
    Effect.gen(function* () {
      if (interrupts.has(`${kind}:${commandId}`)) return;
      interrupts.add(`${kind}:${commandId}`);
      yield* Ref.update(thread.stops, (seen) => [...seen, kind]);
      if (kind !== "delegated-tasks") {
        yield* Ref.update(thread.interrupted, (count) => count + 1);
        yield* Deferred.succeed(thread.interruptedOnce, undefined);
      }
    });
  const layerBoxThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    acknowledgeRemoteCustody: (input, peer) =>
      Effect.gen(function* () {
        expect(peer.sessionId).toBe((yield* Ref.get(thread.linkOrigin))?.sessionId);
        expect(peer.parentThreadId).toBe((yield* Ref.get(thread.delegatedFrom))?.threadId);
        expect(peer.environmentId).toBe((yield* Ref.get(thread.delegatedFrom))?.environmentId);
        yield* Ref.update(thread.custodyReceipts, (receipts) => [...receipts, input]);
        if (
          (yield* Ref.getAndUpdate(thread.custodyFailures, (count) => Math.max(0, count - 1))) > 0
        )
          return yield* new Orchestrator.OrchestratorProjectionError({
            threadId: input.threadId,
            cause: "Lost acknowledgement reply",
          });
        yield* Deferred.succeed(thread.custodyAcknowledged, undefined);
      }),
    getThreadShell: shellOf,
    isProviderInstanceEnabledForProject: () => Effect.succeed(true),
    listProjectThreads: () => Effect.succeed([] as never),
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    getRunCount: (threadId) =>
      projectionOf(threadId).pipe(Effect.map((projection) => projection.runs.length)),
    waitForThread: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(thread.waitedFor, (seen) => [...seen, input.runId]);
        // A thread with no run has nothing to wait for.
        if (yield* Ref.get(thread.runless)) {
          return { threadId: input.threadId, run: null, timedOut: false };
        }
        if (yield* Ref.get(thread.gone)) {
          return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
            projectId: boxProject,
            threadId: input.threadId,
          });
        }
        // The queued run's own task stays open while the follow-up ahead of it settles.
        if (input.runId === boxQueuedRunId) return yield* Effect.never;
        if (input.runId === boxLaterRunId) {
          if ((yield* Ref.get(thread.interrupted)) >= 2)
            yield* Deferred.succeed(thread.custodyWaitEntered, undefined);
          const laterDone = yield* Deferred.await(thread.laterFinished).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          // Settled, the thread's answer is the run queued behind it, once there is one.
          const queued =
            Option.isSome(laterDone) &&
            input.untilDelegatedWorkSettled === true &&
            (yield* Ref.get(thread.queuedReply)) !== null;
          // A restarted run is reported as its continuation, as the box follows the chain.
          const restarted = (yield* Ref.get(thread.restart))?.of;
          const latest = (runId: RunId) => (runId === restarted ? continuationOf(runId) : runId);
          return {
            threadId: input.threadId,
            run: {
              id: latest(boxLaterRunId),
              status: Option.isSome(laterDone) ? "completed" : "running",
            } as OrchestrationV2Run,
            timedOut: Option.isNone(laterDone),
            ...(queued
              ? {
                  resultRun: {
                    id: latest(boxQueuedRunId),
                    status: "completed",
                  } as OrchestrationV2Run,
                }
              : {}),
          };
        }
        const done = yield* Deferred.await(thread.finished).pipe(
          Effect.timeoutOption(input.timeoutMs),
        );
        // Only a waiter that asks waits past the run for the thread's own task.
        if (
          Option.isSome(done) &&
          input.untilDelegatedWorkSettled === true &&
          (yield* Ref.get(thread.nested))
        ) {
          yield* Deferred.succeed(thread.nestedWaiting, undefined);
          const settled = yield* Deferred.await(thread.nestedSettled).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          return {
            threadId: input.threadId,
            run: { id: runId, status: yield* Ref.get(thread.status) } as OrchestrationV2Run,
            timedOut: Option.isNone(settled),
            ...(Option.isSome(settled)
              ? { resultRun: { id: boxLaterRunId, status: "completed" } as OrchestrationV2Run }
              : {}),
          };
        }
        // Unpinned, a wait reports the latest run: a later one once there is one.
        const later = input.runId === undefined && (yield* Ref.get(thread.laterReply)) !== null;
        return {
          threadId: input.threadId,
          run: {
            id: later ? boxLaterRunId : runId,
            status: later ? "completed" : yield* Ref.get(thread.status),
          } as OrchestrationV2Run,
          timedOut: Option.isNone(done),
        };
      }),
    getTimelinePage: (threadId, options) =>
      Effect.gen(function* () {
        if (options.afterPosition === 299 && options.itemId === undefined) {
          yield* Ref.getAndSet(thread.beforeTail, Effect.void).pipe(Effect.flatten);
        }
        if (
          (yield* Ref.get(thread.holdRead)) ||
          (options.itemId !== undefined && (yield* Ref.get(thread.holdRefill)))
        ) {
          yield* Deferred.succeed(thread.readStarted, undefined);
          yield* Deferred.await(thread.releaseRead);
        }
        const reply = yield* Ref.get(thread.reply);
        const later = yield* Ref.get(thread.laterReply);
        const queued = yield* Ref.get(thread.queuedReply);
        const error = yield* Ref.get(thread.error);
        const laterError = yield* Ref.get(thread.laterError);
        const restart = yield* Ref.get(thread.restart);
        // One item per page, with errors available only in the activity view.
        const replies = (
          (yield* Ref.get(thread.timeline)) ?? [
            ...(reply === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:reply"),
                    runId,
                    text: reply,
                    type: "assistant_message",
                  },
                ]),
            ...(error === null
              ? []
              : [{ id: TurnItemId.make("item:error"), runId, text: error, type: "error" }]),
            ...(later === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:later-reply"),
                    runId: boxLaterRunId,
                    text: later,
                    type: "assistant_message",
                  },
                ]),
            ...(laterError === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:later-error"),
                    runId: boxLaterRunId,
                    text: laterError,
                    type: "error",
                  },
                ]),
            ...(queued === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:queued-reply"),
                    runId: boxQueuedRunId,
                    text: queued,
                    type: "assistant_message",
                  },
                ]),
            ...(restart === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:restarted-reply"),
                    runId: continuationOf(restart.of),
                    text: restart.reply,
                    type: "assistant_message",
                  },
                ]),
          ]
        )
          // Position 0 is the task's prompt, which the follower reads past.
          .map((entry, index) => ({ ...entry, position: index + 1 }));
        const visible =
          options.itemId === undefined
            ? replies.filter(
                (entry) => options.view === "activity" || entry.type === "assistant_message",
              )
            : replies.filter((entry) => entry.id === options.itemId);
        const matching = visible
          .filter((entry) => entry.position > (options.afterPosition ?? -1))
          .slice(0, yield* Ref.get(thread.pageSize));
        return {
          items: matching.map(({ id, runId: itemRunId, text, position, type }) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: threadId,
            sourceItemId: id,
            item: {
              id,
              threadId,
              runId: itemRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed" as const,
              title: null,
              startedAt: DateTime.makeUnsafe(0),
              completedAt: DateTime.makeUnsafe(0),
              updatedAt: DateTime.makeUnsafe(0),
              ...(type === "error"
                ? { type, failure: { message: text } }
                : {
                    type: "assistant_message" as const,
                    messageId: MessageId.make(`message:${id}`),
                    text,
                    streaming: false,
                  }),
            } as never,
          })),
          totalItems: replies.length + 1,
          hasMore:
            options.itemId === undefined &&
            matching.length > 0 &&
            visible.some((entry) => entry.position > matching.at(-1)!.position),
          hasEarlier: false,
        };
      }),
    interruptThread: (input) =>
      recordStop(input.commandId, "interrupt").pipe(
        Effect.as({ type: "interrupt_requested", run: runOf("running") } as never),
      ),
    dispatch: (command) =>
      command.type === "thread.stop"
        ? recordStop(command.commandId, "thread.stop").pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (!(yield* Ref.getAndSet(thread.holdFirstStop, false))) return;
                yield* Deferred.succeed(thread.stopStarted, undefined);
                yield* Deferred.await(thread.releaseStop);
              }),
            ),
            Effect.as({ sequence: 0, storedEvents: [] } as never),
          )
        : Effect.die(`The box does not expect ${command.type}`),
    stopDelegatedTasks: (input) => recordStop(input.commandId, "delegated-tasks"),
    sendToThread: (input) =>
      Ref.update(thread.sent, (seen) => [...seen, input.text]).pipe(
        Effect.as(
          (input.mode === "queue"
            ? { run: { id: boxQueuedRunId, status: "queued" }, delivery: "queued" }
            : { run: { id: boxLaterRunId, status: "running" }, delivery: "started" }) as never,
        ),
      ),
  });
  const layerBoxLaunches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.get(thread.runless).pipe(
        Effect.flatMap((runless) =>
          Ref.set(thread.launched, input.threadId!).pipe(
            Effect.andThen(Ref.set(thread.linkOrigin, input.linkOrigin ?? null)),
            Effect.andThen(Ref.set(thread.delegatedFrom, input.delegatedFrom ?? null)),
            Effect.andThen(Ref.set(thread.agentTask, input.agentTask ?? null)),
            Effect.andThen(Ref.set(thread.message, input.initialMessage?.text ?? null)),
            Effect.andThen(
              Ref.set(thread.launchedWith, {
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
              }),
            ),
            Effect.andThen(Effect.flatten(Ref.get(thread.afterLaunch))),
            Effect.as({
              threadId: input.threadId,
              projection: {
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  title: input.title,
                  modelSelection: input.modelSelection,
                  ...(input.agentTask === undefined ? {} : { agentTask: input.agentTask }),
                },
                runs:
                  input.initialMessage?.messageId && !runless
                    ? [
                        {
                          id: runId,
                          status: "running",
                          userMessageId: input.initialMessage.messageId,
                        },
                      ]
                    : [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult),
          ),
        ),
      ),
  });
  return Layer.merge(
    McpHttpServer.layerOrchestratorToolkit.pipe(Layer.provide(EnvironmentAdvice.layer)),
    McpHttpServer.layerProjectRegistration,
  ).pipe(
    Layer.provide(
      DocumentText.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerBoxThreads),
    Layer.provide(layerBoxLaunches),
    // Services the toolkits declare that these calls never reach.
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(PeerForwarding.PeerForwarding)({}),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
        Layer.mock(PeerLinks.PeerLinks)({}),
        Layer.mock(ThreadImportService.ThreadImportService)({}),
        Layer.mock(ThreadHandoff.ThreadHandoff)({}),
        Layer.mock(HandoffImport.HandoffImport)({}),
        Layer.mock(ContextExperimentService.ExperimentService)({
          assignForTask: () => Effect.succeed([]),
          assignments: () => Effect.succeed([]),
        }),
        Layer.mock(ContextForgeWorkItems.ForgeWorkItems)({}),
        Layer.mock(ContextWeaveAgentConnections.WeaveAgentConnections)({}),
        Layer.mock(ContextReleaseApprovals.ReleaseApprovals)({}),
      ),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-delegation-box-" }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([boxClaude]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([boxClaude.instanceId]),
      }),
    ),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(policy ?? Layer.empty),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(Option.fromUndefinedOr(boxProjects.find((p) => p.id === id))),
        listShells: () => Effect.succeed([]),
        // More than a page, so finding the project with this repository pages.
        listPage: ({ cursor, limit }) =>
          Effect.succeed({
            projects: boxProjects.slice(cursor, cursor + limit),
            nextCursor: cursor + limit < boxProjects.length ? cursor + limit : null,
          }),
      }),
    ),
    Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "remote-delegation", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "remote-delegation", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The box's only provider: a Claude instance, under its own id. */
const boxClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-box"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/**
 * The laptop: a real orchestrator (in-memory SQLite) whose parent thread has
 * a live run, the real orchestrator toolkit, and RemoteDelegation. Built in
 * its own scope so a test can tear it down and build it again on the same
 * database, as a restart does.
 */
const makeLaptop = (
  database: Context.Context<SqlClient.SqlClient>,
  offers: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
  >,
  /** The laptop's links from before a restart, which keep their sessions there. */
  kept?: Context.Context<Layer.Success<ReturnType<typeof layerLinkingEnvironment>>>,
  /** Runs as each follow attempt here starts, on its follower's fiber. */
  beforeFollow: Effect.Effect<void, Orchestrator.OrchestratorV2Error> = Effect.void,
) =>
  Effect.gen(function* () {
    const linking = kept ?? (yield* layerLinkingEnvironment(laptop).pipe(Layer.build));
    const layerDatabase = Layer.succeedContext(database);
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "remote-delegation-laptop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => SubscriptionRef.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    );
    const layerHere = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(
        RemoteDelegationLayer.layer.pipe(
          Layer.provide(
            Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.gen(function* () {
                const threads = yield* ThreadManagement.ThreadManagementService;
                return {
                  ...threads,
                  getThreadEventSequence: (threadId: ThreadId) =>
                    beforeFollow.pipe(Effect.andThen(threads.getThreadEventSequence(threadId))),
                };
              }),
            ),
          ),
          Layer.provideMerge(PeerForwarding.layer),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              // A cold enrichment cache: the project itself reports no identity yet.
              getById: () =>
                Effect.succeedSome({
                  workspaceRoot: "/home/me/app",
                  repositoryIdentity: null,
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) =>
                Effect.succeed(
                  cwd === "/home/me/app"
                    ? ({ canonicalKey: "github.com/acme/app" } as RepositoryIdentity)
                    : null,
                ),
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(Layer.mock(ThreadHandoff.ThreadHandoff)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome({ id, workspaceRoot: "/home/me/app" } as never),
        }),
      ),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(layerDatabase),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ContextExperimentService.ExperimentService)({
            assignForTask: () => Effect.succeed([]),
            assignments: () => Effect.succeed([]),
          }),
          Layer.mock(ContextForgeWorkItems.ForgeWorkItems)({}),
          Layer.mock(ContextWeaveAgentConnections.WeaveAgentConnections)({}),
          Layer.mock(ContextReleaseApprovals.ReleaseApprovals)({}),
        ),
      ),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      settings: Context.get(linking, ServerSettings.ServerSettingsService),
      orchestrator: Context.get(here, Orchestrator.OrchestratorV2),
      remote: Context.get(here, RemoteDelegation.RemoteDelegation),
      advice: Context.get(here, AdviceService.AdviceService),
      threads: Context.get(here, ThreadManagement.ThreadManagementService),
      projections: Context.get(here, ProjectionStore.ProjectionStoreV2),
      sink: Context.get(here, EventSink.EventSinkV2),
      call: (name: string, args: Record<string, unknown>, scope = parentScope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          ),
    };
  });

const parentThreadId = ThreadId.make("thread:laptop-parent");
const parentRunId = RunId.make("run:laptop-parent");
const parentRootNode = NodeId.make("node:laptop-parent:root");
const parentScope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:laptop-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:laptop-parent",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The laptop's parent thread, mid-turn when its agent delegates. */
const seedParent = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  parentModelSelection: ModelSelection = modelSelection,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:laptop-parent");
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Laptop parent",
      modelSelection: parentModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* laptopEnv.sink.write({
      commandId: CommandId.make("command:seed:laptop-parent"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread:laptop-parent"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: parentThreadId,
            ownerNodeId: parentRootNode,
            nativeThreadRef: { driver, nativeId: "native:laptop-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-node:laptop-parent"),
          type: "node.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRootNode,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId: null,
            rootNodeId: parentRootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run:laptop-parent"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRunId,
            threadId: parentThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: parentModelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user:laptop-parent"),
            rootNodeId: parentRootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

/** Waits until the task here has the result its thread there ended with. */
const taskResult = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>, taskId: NodeId) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.result !== null,
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

const laptopLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      NodeHttpServer.layerTest.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(ContextExperimentService.ExperimentService)({
              assignForTask: () => Effect.succeed([]),
              assignments: () => Effect.succeed([]),
            }),
            Layer.mock(ContextForgeWorkItems.ForgeWorkItems)({}),
            Layer.mock(ContextWeaveAgentConnections.WeaveAgentConnections)({}),
            Layer.mock(ContextReleaseApprovals.ReleaseApprovals)({}),
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory)),
      ),
    ),
  );

const choreRole = {
  role: "implementer",
  taskClass: "non-ui",
  workId: "work:jev-check",
  attemptId: "attempt:jev-check",
  workspacePath: "/home/ubuntu/.t3/scratch/jev-check",
} as const;

/** The box's own model for its roles, which no laptop thread runs. */
const boxModel = { instanceId: ProviderInstanceId.make("pi"), model: "deepseek-box" };

/** What the box's role policy saw, and the binding it gives a scout. */
interface BoxPolicySeen {
  readonly prepared: Ref.Ref<
    ReadonlyArray<{ readonly role: string; readonly workspacePath: string }>
  >;
  readonly selections: Ref.Ref<ReadonlyArray<unknown>>;
  /** What an isolated writer's run there handed back. */
  readonly handoff: Ref.Ref<AgentTaskHandoff | undefined>;
}

/** The box's role policy: a read-only scout and a browser role, each on the box's own model. */
const boxPolicy = (seen: BoxPolicySeen) =>
  Layer.mock(ManagedAgent.ManagedAgentService)({
    configured: () => Effect.succeed(true),
    roles: ({ selection }) =>
      Ref.update(seen.selections, (all) => [...all, selection]).pipe(
        Effect.as({
          policyHash: "b".repeat(64),
          policyRevision: "box-policy",
          roles: ["scout", "browser"].map((role) => ({
            role,
            sourceAccess: "read-only",
            permissionClass: "read-only",
            briefHash: "c".repeat(64),
            selection: boxModel,
            refusal: null,
            models: [{ model: boxModel.model, effort: "low", available: true }],
          })),
        } as never),
      ),
    prepare: ({ request }) =>
      Ref.update(seen.prepared, (all) => [
        ...all,
        { role: request.role, workspacePath: request.workspacePath },
      ]).pipe(
        Effect.as({
          binding: {
            ...request,
            requestFingerprint: "d".repeat(64),
            policyHash: "b".repeat(64),
            policyRevision: "box-policy",
            briefHash: "c".repeat(64),
            sourceAccess: "read-only",
            toolProfile: request.role === "browser" ? "phi" : "source-reader",
            requested: boxModel,
            assigned: null,
            effective: boxModel,
          } as AgentTaskBinding,
          brief: "You are the box's scout.",
        }),
      ),
    validate: () => Effect.void,
    handoff: () => Ref.get(seen.handoff),
  });

const makeBoxPolicySeen = Effect.gen(function* () {
  return {
    prepared: yield* Ref.make<
      ReadonlyArray<{ readonly role: string; readonly workspacePath: string }>
    >([]),
    selections: yield* Ref.make<ReadonlyArray<unknown>>([]),
    handoff: yield* Ref.make<AgentTaskHandoff | undefined>(undefined),
  } satisfies BoxPolicySeen;
});

it.effect("refuses a managed role before anything starts on a box too old to resolve one", () =>
  laptopLayers(
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "auto");
        yield* seedParent(a);

        const result = yield* a.call("delegate_task", {
          task: "Check the box.",
          agentTask: choreRole,
          target: { environmentId: box.environmentId },
          clientRequestId: "old-box",
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("cannot resolve a managed role");
        // No revision of this checkout crosses the link, whatever the box can do.
        const pinned = yield* a.call("delegate_task", {
          task: "Check the box.",
          agentTask: { ...choreRole, role: "scout", sourceRevision: "abc123" },
          target: { environmentId: box.environmentId },
          clientRequestId: "pinned-box",
        });
        expect(JSON.stringify(pinned.content)).toContain("pinned to a source revision");
        // The role would have run there as a plain thread on this parent's model.
        expect(yield* Ref.get(thread.launched)).toBeNull();
      }),
    ),
  ),
);

it.effect(
  "a role delegated to the box runs there as the box's policy resolves it, and the laptop's record names it",
  () =>
    laptopLayers(
      Effect.scoped(
        Effect.gen(function* () {
          const thread = yield* makeBoxThread;
          const seen = yield* makeBoxPolicySeen;
          const b = yield* serveBox(thread, boxPolicy(seen));
          const offers = yield* SubscriptionRef.make<
            ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
          >([]);
          const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
          const a = yield* makeLaptop(database, offers);
          yield* linkTo(a.links, b, "auto");
          yield* seedParent(a);

          // Discovery there answers with the box's roles and models, as a delegation meets them.
          const roles = yield* a.call("agent_roles", {
            environmentId: box.environmentId,
            projectId: boxProject,
            taskClass: "non-ui",
          });
          expect(roles.isError, JSON.stringify(roles.content)).toBe(false);
          expect(roles.structuredContent).toMatchObject({
            environmentId: box.environmentId,
            policyRevision: "box-policy",
            roles: [{ role: "scout", selection: boxModel }, { role: "browser" }],
          });

          const result = yield* a.call("delegate_task", {
            task: "Map the box's checkout.",
            agentTask: { ...choreRole, role: "scout" },
            target: {
              environmentId: box.environmentId,
              projectId: boxProject,
              model: boxModel.model,
            },
            clientRequestId: "scout-on-box",
          });
          expect(result.isError, JSON.stringify(result.content)).toBe(false);
          const delegated = result.structuredContent as {
            readonly taskId: NodeId;
            readonly model: string;
            readonly agentTask?: AgentTaskBinding;
          };
          // The box chose the model and workspace; the laptop only asked for the model.
          expect(yield* Ref.get(thread.launchedWith)).toMatchObject({ modelSelection: boxModel });
          expect(yield* Ref.get(seen.selections)).toContainEqual({ model: boxModel.model });
          expect(yield* Ref.get(seen.prepared)).toEqual([
            { role: "scout", workspacePath: "/srv/app" },
          ]);
          expect(yield* Ref.get(thread.message)).toBe(
            "You are the box's scout.\n\nMap the box's checkout.",
          );
          expect(yield* Ref.get(thread.agentTask)).toMatchObject({
            role: "scout",
            sourceAccess: "read-only",
            effective: boxModel,
          });
          // The laptop's task and its status name the role, model and permissions the box gave it.
          expect(delegated.model).toBe(boxModel.model);
          expect(delegated.agentTask).toMatchObject({
            role: "scout",
            sourceAccess: "read-only",
            policyRevision: "box-policy",
          });
          const status = yield* a.call("task_status", { taskId: delegated.taskId });
          expect(status.structuredContent).toMatchObject({
            agentTask: { role: "scout", effective: boxModel },
            hasPendingQuestion: false,
          });
          // A question or approval waiting there shows in its status here; it is answered there.
          yield* Ref.set(thread.pendingRequest, true);
          const waiting = yield* a.call("task_status", { taskId: delegated.taskId });
          expect(waiting.structuredContent).toMatchObject({ hasPendingQuestion: true });
          yield* Ref.set(thread.pendingRequest, false);

          yield* Ref.set(thread.reply, "The checkout has three packages.");
          yield* Ref.set(thread.status, "completed");
          yield* Deferred.succeed(thread.finished, undefined);
          expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "completed" });

          // A follow-up continues the same thread there, which keeps its role, model and workspace.
          const followed = yield* a.call("delegate_task", {
            task: "Now map its tests.",
            followup: { taskId: delegated.taskId, changes: "Nothing changed here." },
            clientRequestId: "scout-on-box-followup",
          });
          expect(followed.isError, JSON.stringify(followed.content)).toBe(false);
          const next = followed.structuredContent as {
            readonly taskId: NodeId;
            readonly remoteChild: { readonly threadId: ThreadId };
            readonly agentTask?: AgentTaskBinding;
          };
          expect(next.taskId).not.toBe(delegated.taskId);
          expect(next.remoteChild.threadId).toBe(yield* Ref.get(thread.launched));
          expect(next.agentTask).toMatchObject({ role: "scout", effective: boxModel });
          expect(yield* Ref.get(thread.sent)).toEqual([
            "Changes since your previous task: Nothing changed here.\n\nNow map its tests.",
          ]);
          // The box resolved the role once; the follow-up was checked against that binding.
          expect(yield* Ref.get(seen.prepared)).toHaveLength(1);
        }),
      ),
    ),
);

/** The box's thread for a task, as its own server records it. */
const boxShell = (thread: BoxThread) =>
  Effect.gen(function* () {
    const launched = yield* Ref.get(thread.launched);
    const linkOrigin = yield* Ref.get(thread.linkOrigin);
    const delegatedFrom = yield* Ref.get(thread.delegatedFrom);
    const agentTask = yield* Ref.get(thread.agentTask);
    return {
      ...liveThreadShell(launched!),
      ...(linkOrigin === null ? {} : { linkOrigin }),
      ...(delegatedFrom == null ? {} : { delegatedFrom }),
      ...(agentTask === null ? {} : { agentTask }),
    };
  });

const delegateRole = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  role: "scout" | "browser",
  clientRequestId: string,
) =>
  laptopEnv
    .call("delegate_task", {
      task: "Check the box.",
      agentTask: {
        ...choreRole,
        role,
        ...(role === "browser" ? { taskClass: "ui", browser: { backend: "integrated" } } : {}),
      },
      target: { environmentId: box.environmentId, projectId: boxProject },
      clientRequestId,
    })
    .pipe(
      Effect.map((result) => {
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        return result.structuredContent as { readonly taskId: NodeId };
      }),
    );

it.effect(
  "a browser role the box resolves gets bounded browser tasks there; an ordinary linked thread does not",
  () =>
    laptopLayers(
      Effect.scoped(
        Effect.gen(function* () {
          const thread = yield* makeBoxThread;
          const b = yield* serveBox(thread, boxPolicy(yield* makeBoxPolicySeen));
          const offers = yield* SubscriptionRef.make<
            ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
          >([]);
          const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
          const a = yield* makeLaptop(database, offers);
          yield* linkTo(a.links, b, "auto");
          yield* seedParent(a);

          yield* delegateRole(a, "browser", "browser-on-box");
          const shell = yield* boxShell(thread);
          expect(shell.agentTask).toMatchObject({
            role: "browser",
            browser: { backend: "integrated" },
          });
          expect(boundedBrowserEligible(shell)).toBe(true);
          const { agentTask: _role, ...ordinary } = shell;
          expect(boundedBrowserEligible(ordinary)).toBe(false);
        }),
      ),
    ),
);

it.effect("a writer's result here names the workspace and revision it handed back on the box", () =>
  laptopLayers(
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const seen = yield* makeBoxPolicySeen;
        const b = yield* serveBox(thread, boxPolicy(seen));
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "auto");
        yield* seedParent(a);

        const { taskId } = yield* delegateRole(a, "scout", "writer-on-box");
        // The box bound it as an isolated writer in a workspace it allocated.
        yield* Ref.update(thread.agentTask, (binding) => ({
          ...binding!,
          sourceAccess: "scoped-write" as const,
          workspaceAssignment: "isolated" as const,
          workspacePath: "/srv/workspaces/w1",
        }));
        yield* Ref.set(seen.handoff, {
          workspacePath: "/srv/workspaces/w1",
          revision: "abc123",
          quiescent: true,
        });
        yield* Ref.set(thread.reply, "Fixed the flaky test.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        const task = yield* taskResult(a, taskId);
        expect(task?.result).toContain("Fixed the flaky test.");
        expect(task?.result).toContain("Workspace in Box: /srv/workspaces/w1 at abc123");
      }),
    ),
  ),
);

it.effect(
  "a managed task there keeps its role across a laptop restart, and cancel stops it there",
  () =>
    laptopLayers(
      Effect.scoped(
        Effect.gen(function* () {
          const thread = yield* makeBoxThread;
          const b = yield* serveBox(thread, boxPolicy(yield* makeBoxPolicySeen));
          const offers = yield* SubscriptionRef.make<
            ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
          >([]);
          const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
          // The link outlives the restart, so the box knows the same link session.
          const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
          const { taskId } = yield* Effect.scoped(
            Effect.gen(function* () {
              const before = yield* makeLaptop(database, offers, linking);
              yield* linkTo(before.links, b, "auto");
              yield* seedParent(before);
              return yield* delegateRole(before, "scout", "scout-before-restart");
            }),
          );
          const after = yield* makeLaptop(database, offers, linking);
          yield* after.remote.start();
          const status = yield* after.call("task_status", { taskId });
          expect(status.structuredContent).toMatchObject({
            status: "running",
            agentTask: { role: "scout", effective: boxModel },
          });
          const cancel = yield* after.call("task_cancel", { taskId, reason: "Not needed" });
          expect(cancel.structuredContent).toEqual({ taskId, status: "cancel_requested" });
          expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
        }),
      ),
    ),
);

it.effect("a read-only link starts no managed role there", () =>
  laptopLayers(
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const seen = yield* makeBoxPolicySeen;
        const b = yield* serveBox(thread, boxPolicy(seen));
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "read-only");
        yield* seedParent(a);

        const result = yield* a.call("delegate_task", {
          task: "Check the box.",
          agentTask: { ...choreRole, role: "scout" },
          target: { environmentId: box.environmentId, projectId: boxProject },
          clientRequestId: "read-only-link",
        });
        expect(result.isError).toBe(true);
        expect(yield* Ref.get(thread.launched)).toBeNull();
        expect(yield* Ref.get(seen.prepared)).toEqual([]);
      }),
    ),
  ),
);

it.effect("a box with a role policy refuses a task delegated without a role", () =>
  laptopLayers(
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread, boxPolicy(yield* makeBoxPolicySeen));
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "auto");
        yield* seedParent(a);

        const result = yield* a.call("delegate_task", {
          task: "Check the box.",
          target: { environmentId: box.environmentId, projectId: boxProject },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("must name a role");
        expect(yield* Ref.get(thread.launched)).toBeNull();
      }),
    ),
  ),
);

it.effect("a role the box's policy lacks is refused there before anything starts", () =>
  laptopLayers(
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread, boxPolicy(yield* makeBoxPolicySeen));
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "auto");
        yield* seedParent(a);

        for (const [request, cause] of [
          [{ agentTask: choreRole }, "has no `implementer` role"],
          [
            { agentTask: { ...choreRole, role: "scout" }, model: "gpt-5.4" },
            "gpt-5.4 is not on this environment's list",
          ],
        ] as const) {
          const result = yield* a.call("delegate_task", {
            task: "Check the box.",
            agentTask: request.agentTask,
            target: {
              environmentId: box.environmentId,
              projectId: boxProject,
              ...("model" in request ? { model: request.model } : {}),
            },
            clientRequestId: `refused-${cause}`,
          });
          expect(result.isError, cause).toBe(true);
          expect(JSON.stringify(result.content), cause).toContain(cause);
        }
        expect(yield* Ref.get(thread.launched)).toBeNull();
      }),
    ),
  ),
);
