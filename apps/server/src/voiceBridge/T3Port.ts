// @effect-diagnostics globalFetchInEffect:off -- The upload POST goes to the signed URL T3's MCP server hands back for one attachment, not to an HTTP endpoint this bridge owns.

import type { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as AgentCliClient from "../cli/AgentCliClient.ts";
import type { ProviderModels } from "./Catalog.ts";
import { encodeModelId } from "./ModelId.ts";

/**
 * Everything the bridge asks of T3. It is a port so the turn logic can be tested
 * without a server, and so the one place that speaks MCP stays small.
 */
export interface VoiceBridgePort {
  readonly capabilities: () => Effect.Effect<ProviderModels, VoiceBridgeError>;
  readonly prepareUpload: (input: {
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }) => Effect.Effect<PreparedUpload, VoiceBridgeError>;
  readonly uploadBytes: (input: {
    readonly relativeUrl: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<void, VoiceBridgeError>;
  readonly launch: (input: {
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly message: string;
    readonly attachment?: AttachmentRef;
  }) => Effect.Effect<TurnResult, VoiceBridgeError>;
  readonly send: (input: {
    readonly threadId: string;
    readonly message: string;
    readonly attachment?: AttachmentRef;
  }) => Effect.Effect<TurnResult, VoiceBridgeError>;
  /** One page of a thread's timeline, from `afterPosition` onwards. */
  readonly readThread: (
    threadId: string,
    options?: { readonly afterPosition?: number },
  ) => Effect.Effect<ThreadPage, VoiceBridgeError>;
  /** The question T3 is waiting on, when it is a question rather than an approval. */
  readonly pendingQuestion: (threadId: string) => Effect.Effect<string | null, VoiceBridgeError>;
  /** The approval T3 is waiting on, as the activity view names it. */
  readonly pendingApproval: (threadId: string) => Effect.Effect<string | null, VoiceBridgeError>;
  /**
   * A URL that opens this thread outside T3: the environment's own web client at
   * `/<environmentId>/<threadId>`, which is the only link form another app can
   * hand to the system.
   */
  readonly threadUrl: (threadId: string) => Effect.Effect<string, VoiceBridgeError>;
}

export type AttachmentRef = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};

export type PreparedUpload = {
  readonly attachmentId: string;
  readonly relativeUrl: string;
};

export type TurnResult = {
  readonly threadId: string;
  readonly runId: string | null;
  readonly status: string | null;
};

export type ThreadItem = {
  readonly position: number;
  readonly type: string;
  readonly title: string | null;
  readonly text: string;
};

/** A page of a thread, as far as a chat completion cares. */
export type ThreadPage = {
  readonly status: string;
  readonly pendingRequestCount: number;
  /** The model the thread runs on, encoded as a `/v1/models` id. */
  readonly modelId: string;
  readonly items: ReadonlyArray<ThreadItem>;
  /** Pass as `afterPosition` to read on. */
  readonly nextPosition: number;
  /** The position of the last item in this page, which may still be growing. */
  readonly lastPosition: number | null;
  readonly hasMore: boolean;
};

export class VoiceBridgeError extends Schema.TaggedError<VoiceBridgeError>()("VoiceBridgeError", {
  reason: Schema.Literals(["capabilities", "upload", "launch", "send", "read", "unauthorized"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `T3 voice bridge failed (${this.reason}).`
      : `T3 voice bridge failed (${this.reason}): ${this.detail}`;
  }
}

const LaunchResult = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const SendResult = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

const PreparedUploadResult = Schema.Struct({
  attachmentId: Schema.String,
  relativeUrl: Schema.String,
});

const ThreadItemSchema = Schema.Struct({
  position: Schema.Number,
  itemId: Schema.String,
  type: Schema.String,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(Schema.Number)),
});

const ThreadReadResult = Schema.Struct({
  thread: Schema.Struct({
    status: Schema.String,
    pendingRequestCount: Schema.Number,
    providerInstanceId: Schema.String,
    model: Schema.String,
  }),
  items: Schema.Array(ThreadItemSchema),
  nextPosition: Schema.NullOr(Schema.Number),
  hasMore: Schema.Boolean,
});

const PendingListResult = Schema.Struct({ requestIds: Schema.Array(Schema.String) });

const PendingReadResult = Schema.Struct({
  questions: Schema.Array(Schema.Struct({ header: Schema.String, question: Schema.String })),
});

/** A page is read with the largest window the tool takes, so a long answer arrives whole. */
const PAGE_LIMIT = 100;
const PAGE_CHARS = 50_000;

const mcpAttachment = (attachment: AttachmentRef) => ({
  type: "image" as const,
  id: attachment.id,
  name: attachment.name,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
});

const decode = <A>(
  schema: Schema.ConstraintDecoder<A>,
  value: unknown,
  reason: VoiceBridgeError["reason"],
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new VoiceBridgeError({
          reason,
          detail: "T3 returned a result this bridge does not understand.",
          cause,
        }),
    ),
  );

const originOf = (endpoint: string): string => new URL(endpoint).origin;

/**
 * The MCP-backed port. It reuses the CLI's own MCP client and credential, so a
 * machine that ran `t3 agent login` once can run the bridge with no extra setup.
 * `endpoint` is the environment's MCP address, ending in `/mcp`.
 */
export const makePort = (
  client: Pick<AgentCliClient.AgentCliClient["Service"], "call">,
  endpoint: string,
): VoiceBridgePort => {
  const call = (tool: string, args: Readonly<Record<string, unknown>>) =>
    client
      .call(endpoint, tool, args)
      .pipe(
        Effect.mapError(
          (cause) => new VoiceBridgeError({ reason: "read", detail: cause.message, cause }),
        ),
      );

  // The environment's id never changes while the bridge runs, and a thread link
  // needs it on every answer, so it is read once.
  let environmentId: string | null = null;
  const readEnvironmentId = Effect.gen(function* () {
    if (environmentId !== null) return environmentId;
    const decoded = yield* call("orchestrator_capabilities", {}).pipe(
      Effect.flatMap((value) =>
        decode(Schema.Struct({ environmentId: Schema.optional(Schema.String) }), value, "capabilities"),
      ),
    );
    environmentId = decoded.environmentId ?? null;
    return environmentId;
  });

  return {
    capabilities: () =>
      call("orchestrator_capabilities", {}).pipe(
        Effect.mapError((error) => new VoiceBridgeError({ reason: "capabilities", detail: error.detail })),
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({
              environmentId: Schema.optional(Schema.String),
              providers: Schema.Array(
                Schema.Struct({
                  providerInstanceId: Schema.String,
                  displayName: Schema.NullOr(Schema.String),
                  models: Schema.Array(
                    Schema.Struct({ id: Schema.String, label: Schema.optional(Schema.String) }),
                  ),
                  constraints: Schema.Array(Schema.String),
                }),
              ),
            }),
            value,
            "capabilities",
          ),
        ),
        Effect.map((decoded) => {
          environmentId = decoded.environmentId ?? null;
          return { environmentId, providers: decoded.providers };
        }),
      ),
    threadUrl: (threadId) =>
      Effect.gen(function* () {
        const id = yield* readEnvironmentId;
        // Without an id the bridge can only offer T3's own link form.
        if (id === null) return `t3-thread://v1/${threadId}`;
        return `${originOf(endpoint)}/${encodeURIComponent(id)}/${encodeURIComponent(threadId)}`;
      }).pipe(Effect.catch(() => Effect.succeed(`t3-thread://v1/${threadId}`))),
    prepareUpload: (input) =>
      call("t3_attachment_prepare_upload", {
        upload: { type: "image", name: input.name, mimeType: input.mimeType, sizeBytes: input.sizeBytes },
      }).pipe(
        Effect.flatMap((value) => decode(PreparedUploadResult, value, "upload")),
        Effect.mapError(
          (error) => new VoiceBridgeError({ reason: "upload", detail: error.detail, cause: error }),
        ),
      ),
    uploadBytes: (input) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL(input.relativeUrl, originOf(endpoint)), {
            method: "POST",
            headers: { "content-type": input.mimeType },
            body: input.bytes,
          });
          if (!response.ok) throw new Error(`upload answered ${response.status}`);
        },
        catch: (cause) =>
          new VoiceBridgeError({ reason: "upload", detail: "The capture could not be uploaded.", cause }),
      }),
    launch: (input) =>
      call("t3_thread_launch", {
        scratch: true,
        title: input.title,
        modelSelection: input.modelSelection,
        message: input.message,
        ...(input.attachment === undefined ? {} : { attachments: [mcpAttachment(input.attachment)] }),
      }).pipe(
        Effect.flatMap((value) => decode(LaunchResult, value, "launch")),
        Effect.map((result) => ({
          threadId: result.threadId,
          runId: result.runId ?? null,
          status: result.status ?? null,
        })),
        Effect.mapError(
          (error) => new VoiceBridgeError({ reason: "launch", detail: error.detail, cause: error }),
        ),
      ),
    send: (input) =>
      call(
        input.attachment === undefined ? "t3_thread_send" : "t3_thread_send_attachments",
        input.attachment === undefined
          ? { threadId: input.threadId, message: input.message, mode: "auto" }
          : { threadId: input.threadId, message: input.message, attachments: [mcpAttachment(input.attachment)] },
      ).pipe(
        Effect.flatMap((value) => decode(SendResult, value, "send")),
        Effect.map((result) => ({
          threadId: result.threadId,
          runId: result.runId ?? null,
          status: result.status ?? null,
        })),
        Effect.mapError(
          (error) => new VoiceBridgeError({ reason: "send", detail: error.detail, cause: error }),
        ),
      ),
    readThread: (threadId, options) =>
      Effect.gen(function* () {
        const page = yield* call("t3_thread_read", {
          threadId,
          view: "messages",
          limit: PAGE_LIMIT,
          maxCharsPerItem: PAGE_CHARS,
          ...(options?.afterPosition === undefined ? {} : { afterPosition: options.afterPosition }),
        }).pipe(Effect.flatMap((value) => decode(ThreadReadResult, value, "read")));

        // An item longer than one read is recovered from its own offsets, so a
        // long answer arrives whole rather than cut at the page's cap.
        const items: Array<ThreadItem> = [];
        for (const item of page.items) {
          let text = item.text ?? "";
          let offset = item.nextTextOffset ?? null;
          let truncated = item.textTruncated;
          for (let guard = 0; truncated && offset !== null && guard < 40; guard += 1) {
            const chunk = yield* call("t3_thread_read", {
              threadId,
              view: "messages",
              itemId: item.itemId,
              textOffset: offset,
              maxCharsPerItem: PAGE_CHARS,
              limit: 1,
            }).pipe(Effect.flatMap((value) => decode(ThreadReadResult, value, "read")));
            const next = chunk.items.find((candidate) => candidate.itemId === item.itemId);
            if (next === undefined) break;
            text += next.text ?? "";
            offset = next.nextTextOffset ?? null;
            truncated = next.textTruncated;
          }
          items.push({ position: item.position, type: item.type, title: item.title, text });
        }

        const lastPosition = items.at(-1)?.position ?? null;
        return {
          status: page.thread.status,
          pendingRequestCount: page.thread.pendingRequestCount,
          modelId: encodeModelId(page.thread.providerInstanceId, page.thread.model),
          items,
          nextPosition:
            page.nextPosition ??
            (lastPosition === null ? (options?.afterPosition ?? 0) : lastPosition + 1),
          lastPosition,
          hasMore: page.hasMore,
        };
      }),
    pendingApproval: (threadId) =>
      Effect.gen(function* () {
        // The current approval is the newest one in the thread, which may sit
        // past the first activity page, so every page is read before choosing.
        let cursor: number | undefined;
        let approval: { readonly title: string | null; readonly text: string | null } | null = null;
        for (let guard = 0; guard < 200; guard += 1) {
          const page = yield* call("t3_thread_read", {
            threadId,
            view: "activity",
            limit: PAGE_LIMIT,
            maxCharsPerItem: PAGE_CHARS,
            ...(cursor === undefined ? {} : { afterPosition: cursor }),
          }).pipe(Effect.flatMap((value) => decode(ThreadReadResult, value, "read")));
          for (const item of page.items) {
            if (item.type === "approval_request") approval = { title: item.title, text: item.text };
          }
          const lastPosition = page.items.at(-1)?.position;
          if (!page.hasMore || lastPosition === undefined) break;
          cursor = lastPosition;
        }
        if (approval === null) return null;
        const named: { readonly title: string | null; readonly text: string | null } = approval;
        const source = (named.title ?? named.text ?? "").trim().split("\n")[0]?.trim() ?? "";
        if (source === "") return null;
        return source.length <= 80 ? source : `${source.slice(0, 79)}…`;
      }).pipe(Effect.catch(() => Effect.succeed(null))),
    pendingQuestion: (threadId) =>
      Effect.gen(function* () {
        const list = yield* decode(PendingListResult, yield* call("t3_pending_request_list", { threadId }), "read");
        const requestId = list.requestIds[0];
        if (requestId === undefined) return null;
        const read = yield* decode(
          PendingReadResult,
          yield* call("t3_pending_request_read", { threadId, requestId }),
          "read",
        );
        const question = read.questions[0];
        if (question === undefined) return null;
        return question.header.trim() === "" ? question.question : question.header;
      }).pipe(Effect.catch(() => Effect.succeed(null))),
  };
};
