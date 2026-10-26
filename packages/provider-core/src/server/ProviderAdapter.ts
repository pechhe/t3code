import type { OrchestrationV2HistoricalMessage } from "@t3tools/contracts";
import {
  ChatAttachment,
  ChatAttachmentId,
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderInstanceId,
  PositiveInt,
  ProviderUserInputAnswers,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeMode,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "./selectionTransition.ts";

export const ProviderAdapterV2RuntimePolicy = Schema.Struct({
  managedAgent: Schema.optional(Schema.Boolean),
  /** A managed read-only agent that may also search and fetch the web. */
  webResearch: Schema.optional(Schema.Boolean),
  /**
   * The directory a managed sandboxed writer may write as its own temp root, outside its
   * workspace. Set for managed writers with a workspace sandbox; absent for every other task.
   */
  sandboxTempRoot: Schema.optional(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
  /**
   * The thread's own compact-at point, in context tokens; absent or null follows the provider
   * instance's "Auto-compact after" setting. Only Claude and Codex compact natively and read
   * it; every other adapter ignores it.
   */
  compactAt: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * The point set for this thread's model in the server settings, before any thread override.
   * Read by adapters that can only compact per model, such as Pi, whose provider hands the point
   * to its own settings rather than accepting one per session.
   */
  modelCompactAt: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ProviderAdapterV2RuntimePolicy = typeof ProviderAdapterV2RuntimePolicy.Type;

/**
 * A still sampled from a video attachment on the server host. Frames are derived
 * from `attachments`, not attachments themselves, so they never count toward the
 * user's attachment limits; `path` is a JPEG on the host the provider runs on.
 */
export const ProviderAdapterV2VideoFrame = Schema.Struct({
  videoAttachmentId: ChatAttachmentId,
  videoName: Schema.String,
  timestampMs: Schema.Number,
  /** The screen changed at this frame, so the moments around it deserve a closer look. */
  changed: Schema.optional(Schema.Boolean),
  path: Schema.String,
  mimeType: Schema.Literal("image/jpeg"),
  sizeBytes: Schema.Number,
});
export type ProviderAdapterV2VideoFrame = typeof ProviderAdapterV2VideoFrame.Type;

export const ProviderAdapterV2TurnMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  /** Ordered by video, then timestamp. Absent when no video was attached or ffmpeg is unavailable. */
  videoFrames: Schema.optional(Schema.Array(ProviderAdapterV2VideoFrame)),
  createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
  creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
  scheduledTaskId: OrchestrationV2ConversationMessage.fields.scheduledTaskId,
  senderThreadId: OrchestrationV2ConversationMessage.fields.senderThreadId,
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2SessionStatus = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type ProviderAdapterV2SessionStatus = typeof ProviderAdapterV2SessionStatus.Type;

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app_thread.created"),
    driver: ProviderDriverKind,
    appThread: OrchestrationV2AppThread,
    createOnly: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    driver: ProviderDriverKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    driver: ProviderDriverKind,
    providerThread: OrchestrationV2ProviderThread,
    retainedNativeTurnIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    providerTurn: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    driver: ProviderDriverKind,
    node: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.updated"),
    driver: ProviderDriverKind,
    subagent: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    driver: ProviderDriverKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    driver: ProviderDriverKind,
    turnItem: OrchestrationV2TurnItem,
  }),
  /** Unpersisted deltas go only to clients showing the row; final output arrives in turn_item.updated. */
  Schema.Struct({
    type: Schema.Literal("command_output.delta"),
    driver: ProviderDriverKind,
    threadId: ThreadId,
    itemId: TurnItemId,
    chunk: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    driver: ProviderDriverKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    status: Schema.Literals(["completed", "interrupted", "cancelled"]),
    failure: Schema.Null,
    threadDisposition: Schema.Literals(["reusable", "broken"]),
    /**
     * What ended an `interrupted` turn when the adapter knows it was not the provider
     * aborting on its own. The server adds `user` and `move` from its own records, so an
     * adapter never claims either; absent means the provider aborted.
     */
    interruptCause: Schema.optional(Schema.Literal("server-close")),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    failureItemOrdinal: PositiveInt,
    status: Schema.Literal("failed"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
    retryStartedAt: Schema.optional(Schema.DateTimeUtc),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
    /** Child turns outlive root failure and report their own terminals; otherwise open children settle. */
    childTurnsContinue: Schema.optional(Schema.Literal(true)),
  }),
]);
export type ProviderAdapterV2Event = typeof ProviderAdapterV2Event.Type;

export class ProviderAdapterCapabilitiesError extends Schema.TaggedError<ProviderAdapterCapabilitiesError>()(
  "ProviderAdapterCapabilitiesError",
  {
    driver: ProviderDriverKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider capabilities.`;
  }
}

export class ProviderAdapterOpenSessionError extends Schema.TaggedError<ProviderAdapterOpenSessionError>()(
  "ProviderAdapterOpenSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterCloseSessionError extends Schema.TaggedError<ProviderAdapterCloseSessionError>()(
  "ProviderAdapterCloseSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterResumeThreadError extends Schema.TaggedError<ProviderAdapterResumeThreadError>()(
  "ProviderAdapterResumeThreadError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resume ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterEnsureThreadError extends Schema.TaggedError<ProviderAdapterEnsureThreadError>()(
  "ProviderAdapterEnsureThreadError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.driver} provider thread for app thread ${this.threadId}.`;
  }
}

export class ProviderAdapterReadThreadSnapshotError extends Schema.TaggedError<ProviderAdapterReadThreadSnapshotError>()(
  "ProviderAdapterReadThreadSnapshotError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider thread snapshot ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterRollbackThreadError extends Schema.TaggedError<ProviderAdapterRollbackThreadError>()(
  "ProviderAdapterRollbackThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to roll back ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterForkThreadError extends Schema.TaggedError<ProviderAdapterForkThreadError>()(
  "ProviderAdapterForkThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to fork ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterTurnStartError extends Schema.TaggedError<ProviderAdapterTurnStartError>()(
  "ProviderAdapterTurnStartError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start run ${this.runId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterSteerRunUnsupportedError extends Schema.TaggedError<ProviderAdapterSteerRunUnsupportedError>()(
  "ProviderAdapterSteerRunUnsupportedError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
  },
) {
  override get message(): string {
    return `${this.driver} provider thread ${this.providerThreadId} does not support active-run steering.`;
  }
}

export class ProviderAdapterSteerRunError extends Schema.TaggedError<ProviderAdapterSteerRunError>()(
  "ProviderAdapterSteerRunError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to steer active run ${this.providerTurnId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedError<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.driver} provider turn ${this.providerTurnId}.`;
  }
}

export class ProviderAdapterRuntimeRequestResponseError extends Schema.TaggedError<ProviderAdapterRuntimeRequestResponseError>()(
  "ProviderAdapterRuntimeRequestResponseError",
  {
    driver: ProviderDriverKind,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to respond to ${this.driver} runtime request ${this.requestId}.`;
  }
}

export class ProviderAdapterEventStreamError extends Schema.TaggedError<ProviderAdapterEventStreamError>()(
  "ProviderAdapterEventStreamError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while streaming ${this.driver} provider session ${this.providerSessionId} events.`;
  }
}

// A deliberate detach (workspace handoff, archive) ends the session under a live
// run. Subscribers settle that run as interrupted; it is not a stream failure.
export class ProviderSessionDetachedError extends Schema.TaggedError<ProviderSessionDetachedError>()(
  "ProviderSessionDetachedError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

// Only fixed reasons reach failure messages; detail can contain private configuration.
const ProviderAdapterFailureReason = Schema.Literals([
  "previous_turn_active",
  "attachment_unreadable",
]);
export type ProviderAdapterFailureReason = typeof ProviderAdapterFailureReason.Type;

export class ProviderAdapterProtocolError extends Schema.TaggedError<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    driver: ProviderDriverKind,
    detail: Schema.String,
    reason: Schema.optional(ProviderAdapterFailureReason),
    cause: Schema.optional(Schema.Defect()),
    payload: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.driver} provider protocol error: ${this.detail}.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterCloseSessionError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterEventStreamError,
  ProviderSessionDetachedError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2OpenSessionInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly resumeFromSession?: OrchestrationV2ProviderSession;
  readonly initialNativeThreadId?: string;
  readonly initialProviderItemIdentityVersion?: 2;
}

export interface ProviderAdapterV2EnsureThreadInput {
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerSessionId?: ProviderSessionId;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2TurnInput {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly providerTurnOrdinal: number;
  readonly restartContinuationOfRunId?: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  /**
   * The instruction experiment variant assigned to this thread, delivered on top of the
   * agent's usual instructions. Only adapters that support an overlay receive one.
   */
  readonly instructionOverlay?: { readonly text: string; readonly sha256: string };
  /**
   * Set on a `/compact` turn whose summary a model other than the conversation's writes. That
   * model never travels as `modelSelection`: the run, the thread and the recorded context window
   * stay the conversation's, and only the adapter reads this when it opens the summary.
   */
  readonly compaction?: {
    readonly modelSelection?: ModelSelection;
    /** The setting's model was passed over because its window is smaller than the thread. */
    readonly windowTooSmall?: boolean;
  };
}

export interface ProviderAdapterV2SteerInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly message: ProviderAdapterV2TurnMessage;
}

export interface ProviderAdapterV2InterruptInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly requestRuntimeRestart?: boolean;
}

export interface ProviderAdapterV2RuntimeRequestResponseInput {
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision;
  readonly feedback?: string;
  readonly answers?: ProviderUserInputAnswers;
  readonly response?: unknown;
}

export interface ProviderAdapterV2ThreadSnapshot {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ReadThreadSnapshotInput {
  readonly providerThread: OrchestrationV2ProviderThread;
}

export type ProviderAdapterV2RollbackTarget =
  | {
      readonly type: "thread_start";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: 0;
    }
  | {
      readonly type: "provider_turn";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: number;
      readonly providerTurn: OrchestrationV2ProviderTurn;
    };

export interface ProviderAdapterV2RollbackThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly target: ProviderAdapterV2RollbackTarget;
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

export interface ProviderAdapterV2ForkThreadInput {
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly sourceProviderTurns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerTurnId?: ProviderTurnId;
  readonly targetThreadId: ThreadId;
  readonly ownerNodeId?: NodeId;
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2EventSubscription {
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderAdapterV2HistoricalContext {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly context: string;
}

export interface ProviderAdapterV2McpTool {
  readonly name: string;
  readonly _meta?: unknown;
  readonly annotations?: unknown;
}

export interface ProviderAdapterV2McpCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

export interface ProviderAdapterV2McpApps {
  readonly listTools: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
  }) => Effect.Effect<ReadonlyArray<ProviderAdapterV2McpTool>, ProviderAdapterV2Error>;
  readonly callTool: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Effect.Effect<ProviderAdapterV2McpCallToolResult, ProviderAdapterV2Error>;
  readonly readResource: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<{ readonly contents: ReadonlyArray<unknown> }, ProviderAdapterV2Error>;
}

export type ProviderAdapterV2SubagentOutcome = {
  readonly status: "completed" | "failed" | "cancelled";
  readonly completedAt: NonNullable<OrchestrationV2Subagent["completedAt"]>;
  readonly result: OrchestrationV2Subagent["result"];
};

export interface ProviderAdapterV2SessionRuntime {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  /** Manager runtimes broadcast independent subscriptions; adapters may expose only a single-consumer stream. */
  readonly subscribeEvents?: Effect.Effect<ProviderAdapterV2EventSubscription>;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  /** Overrides the session-wide probe so sibling threads cannot keep this root subscription open. */
  readonly hasPendingBackgroundWorkForThread?: (
    providerThread: OrchestrationV2ProviderThread,
  ) => Effect.Effect<boolean>;
  /** Set only if all session background tasks end with its process; otherwise threads must keep Waiting. */
  readonly backgroundTasksEndWithProcess?: true;
  readonly getModelContextWindow?: (
    modelSelection: ModelSelection,
    cwd?: string | null,
  ) => number | undefined;
  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly threadId?: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  /** False means the native protocol explicitly does not support history injection. */
  readonly injectHistory?: (
    input: ProviderAdapterV2HistoricalContext & {
      readonly providerThread: OrchestrationV2ProviderThread;
    },
  ) => Effect.Effect<boolean, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly compactThread?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly stopTask?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly taskId: string;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly stopSubagent?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly nativeTaskId: string;
    /** A delayed Stop must not interrupt a task resumed after this request. */
    readonly requestedAt?: NonNullable<OrchestrationV2Subagent["startedAt"]>;
  }) => Effect.Effect<void | ProviderAdapterV2SubagentOutcome, ProviderAdapterV2Error>;
  readonly unloadThread?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly readThreadSnapshot: (
    input: ProviderAdapterV2ReadThreadSnapshotInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly uploadFeedback?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly feedbackId: string }, ProviderAdapterV2Error>;
  /** Absent means non-interactive apps with plain tool rows. */
  readonly mcpApps?: ProviderAdapterV2McpApps;
  readonly rollbackThread: (
    input: ProviderAdapterV2RollbackThreadInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly forkThread: (
    input: ProviderAdapterV2ForkThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
}

export class ProviderAdapterV2 extends Context.Service<
  ProviderAdapterV2,
  {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly getCapabilities: () => Effect.Effect<
      OrchestrationV2ProviderCapabilities,
      ProviderAdapterV2Error
    >;
    readonly planSelectionTransition: (
      input: ProviderSelectionTransitionInput,
    ) => Effect.Effect<ProviderSelectionTransitionPlan, ProviderAdapterV2Error>;
    readonly openSession: (
      input: ProviderAdapterV2OpenSessionInput,
    ) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope.Scope>;
  }
>()("@t3tools/provider-core/server/ProviderAdapter/ProviderAdapterV2") {}
