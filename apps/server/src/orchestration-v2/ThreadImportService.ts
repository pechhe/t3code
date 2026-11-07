import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2LinkOrigin,
  type OrchestratorMcpThreadImportInput,
  type OrchestratorMcpThreadImportResult,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const IMPORT_EVENT_PREFIX = "thread-import:v1";

/** The imported thread's events could not be written. */
export class ThreadImportWriteError extends Schema.TaggedError<ThreadImportWriteError>()(
  "ThreadImportWriteError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "The thread could not be imported.";
  }
}

/** A retried import named another project than the one the thread landed in. */
export class ThreadImportProjectMismatchError extends Schema.TaggedError<ThreadImportProjectMismatchError>()(
  "ThreadImportProjectMismatchError",
  { threadId: ThreadId, existingProjectId: ProjectId },
) {
  override get message(): string {
    return `This handoff was already imported into another project (${this.existingProjectId}).`;
  }
}

/**
 * The thread was imported, but its continuation prompt could not start a run.
 * `rejection` is the orchestrator's own reason when it refused the message.
 */
export class ThreadImportContinuationError extends Schema.TaggedError<ThreadImportContinuationError>()(
  "ThreadImportContinuationError",
  { threadId: ThreadId, rejection: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.rejection === undefined
      ? "The thread was imported, but its first message could not start."
      : `The thread was imported, but its first message could not start: ${this.rejection}`;
  }
}

export type ThreadImportError =
  | ThreadImportWriteError
  | ThreadImportProjectMismatchError
  | ThreadImportContinuationError;

/** A checkout an import prepared for its thread. */
export interface ImportedWorkspace {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly undo: Effect.Effect<void>;
}

/**
 * Creates a thread seeded with a moved thread's conversation, runless and marked
 * imported so its first run gets it as a text handoff. Ids derive from the source
 * thread and handoff, so a retried import returns the thread the first created.
 */
export class ThreadImportService extends Context.Service<
  ThreadImportService,
  {
    readonly importThread: <E = never>(
      input: OrchestratorMcpThreadImportInput & {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
        /**
         * Prepares the checkout the thread works in, run only when this import
         * creates the thread; `undo` runs if the thread then cannot be written.
         */
        readonly workspace?: Effect.Effect<ImportedWorkspace, E>;
      },
    ) => Effect.Effect<OrchestratorMcpThreadImportResult, ThreadImportError | E>;
  }
>()("t3/orchestration-v2/ThreadImportService") {}

/**
 * The thread an import of `source` creates, the same on every retry and on
 * either side of a move, so the moving side can ask whether it landed.
 */
export const importedThreadId = Effect.fn("ThreadImportService.importedThreadId")(function* (
  source: OrchestratorMcpThreadImportInput["source"],
) {
  const digest = yield* Digest.Digest;
  const hash = yield* digest
    .digest(
      Digest.sha256,
      new TextEncoder().encode(`${source.environmentId}\n${source.threadId}\n${source.handoffId}`),
    )
    .pipe(Effect.orDie);
  return ThreadId.make(`thread:import:${Hex.encode(hash).slice(0, 32)}`);
});

const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const digest = yield* Digest.Digest;
  const importLock = yield* KeyedLock.make<ThreadId>();

  const historyEvents = (
    threadId: ThreadId,
    messages: OrchestratorMcpThreadImportInput["messages"],
  ): ReadonlyArray<OrchestrationV2DomainEvent> =>
    messages.flatMap((message, index) => {
      const suffix = String(index).padStart(6, "0");
      const messageId = MessageId.make(`${threadId}:${suffix}`);
      const turnItemId = TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`);
      const at = DateTime.makeUnsafe(message.createdAt);
      const common = {
        id: turnItemId,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // Imported items are numbered before any run here by the position store.
        ordinal: index + 1,
        status: "completed" as const,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      return [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${threadId}:${suffix}`),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            createdBy: message.role === "user" ? "user" : "agent",
            creationSource: "server",
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload:
            message.role === "user"
              ? {
                  ...common,
                  createdBy: "user",
                  creationSource: "server",
                  type: "user_message",
                  messageId,
                  inputIntent: "turn_start",
                  text: message.text,
                  attachments: [],
                }
              : {
                  ...common,
                  type: "assistant_message",
                  messageId,
                  text: message.text,
                  streaming: false,
                },
        },
      ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    });

  const importThread: ThreadImportService["Service"]["importThread"] = Effect.fn(
    "ThreadImportService.importThread",
  )(function* (input) {
    const threadId = yield* importedThreadId(input.source).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
    // One import of a handoff at a time here, so a resend waits for the first and reuses its thread and workspace.
    const created = yield* importLock.withLock(
      threadId,
      Effect.gen(function* () {
        const existing = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (existing === null) {
          const workspace = input.workspace === undefined ? undefined : yield* input.workspace;
          const now = yield* DateTime.now;
          const thread: OrchestrationV2AppThread = {
            createdBy: "agent",
            creationSource: "mcp",
            id: threadId,
            projectId: input.projectId,
            title: input.title,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: workspace === undefined ? (input.branch ?? null) : workspace.branch,
            worktreePath:
              workspace === undefined ? (input.worktreePath ?? null) : workspace.worktreePath,
            activeProviderThreadId: null,
            historyOrigin: "v1_import",
            ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* sink
            .write({
              events: [
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                  type: "thread.created",
                  threadId,
                  providerInstanceId: input.modelSelection.instanceId,
                  occurredAt: now,
                  payload: thread,
                },
                ...historyEvents(threadId, input.messages),
              ],
            })
            .pipe(
              // A concurrent retry may have written the same events first.
              Effect.catchCause((cause) =>
                threads.getThreadShell(threadId).pipe(
                  Effect.orElseSucceed(() => null),
                  // The thread that won keeps its own workspace; this attempt's is undone.
                  Effect.flatMap((raced) =>
                    raced === null ? Effect.failCause(cause) : (workspace?.undo ?? Effect.void),
                  ),
                ),
              ),
              Effect.tapError(() => workspace?.undo ?? Effect.void),
              Effect.mapError((cause) => new ThreadImportWriteError({ threadId, cause })),
            );
          return true;
        } else if (existing.projectId !== input.projectId) {
          return yield* new ThreadImportProjectMismatchError({
            threadId,
            existingProjectId: existing.projectId,
          });
        }
        return false;
      }),
    );
    const runId = yield* startContinuation(threadId, input);
    return { threadId, projectId: input.projectId, created, runId };
  });

  /** Sends the continuation prompt once; a retry replays the same command. */
  const startContinuation = (
    threadId: ThreadId,
    input: OrchestratorMcpThreadImportInput,
  ): Effect.Effect<RunId | null, ThreadImportContinuationError> =>
    input.continuationPrompt === undefined
      ? Effect.succeed(null)
      : threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:thread-import:${threadId}:continue`),
            threadId,
            messageId: MessageId.make(`${threadId}:continue`),
            text: input.continuationPrompt,
            attachments: [],
            modelSelection: input.modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.flatMap(() => threads.getThreadRecords(threadId, ["runs"])),
            Effect.map((records) => Option.fromNullishOr(records.runs.at(-1)?.id)),
            Effect.map(Option.getOrNull),
            Effect.mapError(
              (cause) =>
                new ThreadImportContinuationError({
                  threadId,
                  // Decider refusals are public; storage and other causes are not.
                  ...((cause._tag === "OrchestratorDispatchError" ||
                    cause._tag === "OrchestratorCommandRejectedError") &&
                  typeof cause.cause === "string" &&
                  cause.cause.length > 0
                    ? { rejection: Array.from(cause.cause).slice(0, 1000).join("") }
                    : {}),
                  cause,
                }),
            ),
          );

  return ThreadImportService.of({ importThread });
});

export const layer = Layer.effect(ThreadImportService, make);
