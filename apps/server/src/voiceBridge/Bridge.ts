import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { CapturedWindow } from "./Capture.ts";
import type { ChatMessage } from "./Conversation.ts";
import {
  answerSignature,
  lastAssistantText,
  lastUserText,
  threadTitle,
  turnMessage,
} from "./Conversation.ts";
import { decodeModelId, encodeModelId } from "./ModelId.ts";
import type { SessionStore } from "./Sessions.ts";
import { pruneSessions, rememberThread, threadFor } from "./Sessions.ts";
import type { AttachmentRef, ThreadPage, VoiceBridgePort } from "./T3Port.ts";
import { VoiceBridgeError } from "./T3Port.ts";

/** A run is over when T3 says so, or when it is waiting on a person. */
const TERMINAL_STATUSES: ReadonlyArray<string> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
];

/** An assistant message is the only thing the answer's text comes from. */
const ASSISTANT_ITEM = "assistant_message";

const MAX_NAMED_REQUEST = 80;

export type TurnRequest = {
  /** The model id FluidVoice asked for, as `/v1/models` handed it out. */
  readonly model: string;
  /** The whole conversation FluidVoice resent, oldest first. */
  readonly messages: ReadonlyArray<ChatMessage>;
};

export type TurnDeps = {
  readonly port: VoiceBridgePort;
  /** Captures the window that has focus, or `null` when capture is off or unavailable. */
  readonly capture: () => Effect.Effect<CapturedWindow | null>;
  readonly sessions: {
    readonly read: () => Effect.Effect<SessionStore>;
    readonly write: (store: SessionStore) => Effect.Effect<void>;
  };
  readonly pollIntervalMs: number;
  readonly maxWaitMs: number;
};

export type TurnOutcome = {
  readonly threadId: string;
  /** True when the capture was dropped because T3 or the provider refused it. */
  readonly captureDropped: boolean;
};

/** A turn that has reached its thread: from here the answer only streams. */
export type BegunTurn = {
  readonly threadId: string;
  readonly modelId: string;
  /** Read the thread after this position; `null` starts from its first item. */
  readonly cursor: number | null;
  /** Text already in the thread, per item position, so nothing is re-emitted. */
  readonly emitted: ReadonlyArray<readonly [number, number]>;
  /** Text that belongs before the answer, such as a note that the capture was dropped. */
  readonly preface: string;
};

const push = (emit: (text: string) => Effect.Effect<void>, text: string) =>
  text === "" ? Effect.void : emit(text);

/** A refusal that names the attachment is one the turn can survive without it. */
const isAttachmentRefusal = (error: VoiceBridgeError): boolean =>
  (error.reason === "launch" || error.reason === "send") &&
  (error.detail ?? "").toLowerCase().includes("attach");

const namedRequest = (title: string | null, text: string): string | null => {
  const source = (title ?? text).trim().split("\n")[0]?.trim() ?? "";
  if (source === "") return null;
  return source.length <= MAX_NAMED_REQUEST ? source : `${source.slice(0, MAX_NAMED_REQUEST - 1)}…`;
};

const attachmentFor = (
  deps: TurnDeps,
  captured: CapturedWindow,
): Effect.Effect<AttachmentRef, VoiceBridgeError> =>
  deps.port
    .prepareUpload({ name: captured.name, mimeType: captured.mimeType, sizeBytes: captured.sizeBytes })
    .pipe(
      Effect.flatMap((prepared) =>
        deps.port
          .uploadBytes({
            relativeUrl: prepared.relativeUrl,
            mimeType: captured.mimeType,
            bytes: captured.png,
          })
          .pipe(
            Effect.as({
              id: prepared.attachmentId,
              name: captured.name,
              mimeType: captured.mimeType,
              sizeBytes: captured.sizeBytes,
            }),
          ),
      ),
    );

/** Reads a thread from the start to its end, so a long history needs no replay. */
const readToEnd = (
  port: VoiceBridgePort,
  threadId: string,
): Effect.Effect<ThreadPage, VoiceBridgeError> =>
  Effect.gen(function* () {
    let cursor: number | undefined;
    let last: ThreadPage | null = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page: ThreadPage = yield* port.readThread(
        threadId,
        cursor === undefined ? {} : { afterPosition: cursor },
      );
      last = page;
      if (!page.hasMore) return page;
      cursor = page.lastPosition ?? page.nextPosition;
    }
    return last ?? {
      status: "idle",
      pendingRequestCount: 0,
      modelId: "",
      items: [],
      nextPosition: 0,
      lastPosition: null,
      hasMore: false,
    };
  });

/**
 * Captures what the person was looking at, then hands the ask to T3: a new thread
 * in Scratch, or the thread this conversation already has when it runs on the
 * model the picker shows. Everything that can fail before a word is streamed fails
 * here, where the caller can still answer with an error status.
 */
export const beginTurn = (
  deps: TurnDeps,
  request: TurnRequest,
): Effect.Effect<BegunTurn, VoiceBridgeError> =>
  Effect.gen(function* () {
    const decoded = decodeModelId(request.model);
    if (decoded === null) {
      return yield* new VoiceBridgeError({
        reason: "launch",
        detail: `Unknown model "${request.model}". Pick one from this bridge's model list.`,
      });
    }
    const text = lastUserText(request.messages);
    if (text === "") {
      return yield* new VoiceBridgeError({ reason: "launch", detail: "The request had no instruction." });
    }

    const captured = yield* deps.capture();
    const attachment = captured === null ? null : yield* attachmentFor(deps, captured);

    const modelId = encodeModelId(decoded.instanceId, decoded.model);
    const modelSelection = { instanceId: ProviderInstanceId.make(decoded.instanceId), model: decoded.model };
    const sessions = yield* deps.sessions.read();
    // Only a history that carries one of the bridge's own answers continues a
    // thread: a new Command session has produced nothing earlier, however
    // similar its first words are. The answer is the only part of the history
    // the bridge wrote, so it is the only part worth matching.
    const previousAnswer = lastAssistantText(request.messages);
    const stored =
      previousAnswer === null ? null : threadFor(sessions, answerSignature(previousAnswer));

    // A conversation only continues on the model the picker shows now: picking
    // another model is a different question, so it starts its own thread.
    const existing = stored === null ? null : yield* readToEnd(deps.port, stored).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const continued = existing !== null && existing.modelId === modelId ? existing : null;

    const continuingThreadId = continued === null ? null : stored;
    const dispatch = (carried: AttachmentRef | null) =>
      continuingThreadId === null
        ? deps.port.launch({
            title: threadTitle(text),
            modelSelection,
            message: turnMessage(text, carried !== null),
            ...(carried === null ? {} : { attachment: carried }),
          })
        : deps.port.send({
            threadId: continuingThreadId,
            message: turnMessage(text, carried !== null),
            ...(carried === null ? {} : { attachment: carried }),
          });

    const turn = yield* (attachment === null
      ? dispatch(null).pipe(Effect.map((result) => ({ result, captureDropped: false })))
      : dispatch(attachment).pipe(
          Effect.map((result) => ({ result, captureDropped: false })),
          // A provider that cannot carry images refuses the whole turn. The ask
          // matters more than the picture, so it goes again without it.
          Effect.catchTag("VoiceBridgeError", (error) =>
            isAttachmentRefusal(error)
              ? dispatch(null).pipe(Effect.map((result) => ({ result, captureDropped: true })))
              : Effect.fail(error),
          ),
        ));

    return {
      threadId: turn.result.threadId,
      modelId,
      cursor: continued === null ? null : continued.lastPosition,
      emitted:
        continued === null
          ? []
          : continued.items
              .filter((item) => item.type === ASSISTANT_ITEM)
              .map((item) => [item.position, item.text.length] as const),
      preface: turn.captureDropped
        ? "_The screenshot could not be attached, so this is the words only._\n\n"
        : "",
    };
  });

/**
 * Streams the answer of a turn that has reached its thread, following pages as
 * they grow, then closes with the link. A message that is still being written is
 * re-read and only its new words go out. A run that stops for a person hands the
 * wait back to T3 instead of holding the window open.
 */
export const streamTurn = (
  deps: TurnDeps,
  request: TurnRequest,
  begun: BegunTurn,
  emit: (text: string) => Effect.Effect<void>,
): Effect.Effect<TurnOutcome, VoiceBridgeError> =>
  Effect.gen(function* () {
    const emitted = new Map<number, number>(begun.emitted);
    let cursor = begun.cursor;
    let answer = begun.preface;
    let waited = 0;
    const say = (text: string) =>
      push(emit, text).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            answer += text;
          }),
        ),
      );

    while (true) {
      const page = yield* deps.port.readThread(
        begun.threadId,
        cursor === null ? {} : { afterPosition: cursor },
      );

      for (const item of page.items) {
        if (item.type !== ASSISTANT_ITEM) continue;
        const written = emitted.get(item.position) ?? 0;
        if (item.text.length > written) {
          yield* say(item.text.slice(written));
          emitted.set(item.position, item.text.length);
        }
      }
      // `afterPosition` is exclusive and the last item may still be growing, so
      // the next read starts one before it and emits only what it has gained.
      cursor =
        page.lastPosition === null
          ? cursor
          : page.lastPosition === 0
            ? null
            : page.lastPosition - 1;

      if (page.hasMore) continue;

      if (page.status === "waiting" || page.pendingRequestCount > 0) {
        const question = yield* deps.port.pendingQuestion(begun.threadId);
        const approval = question === null ? yield* deps.port.pendingApproval(begun.threadId) : null;
        const named = question ?? approval;
        const link = yield* deps.port.threadUrl(begun.threadId);
        yield* say(
          named === null
            ? `\n\nT3 is waiting on a decision in this thread. Open it to answer.\n\n${link}`
            : `\n\nT3 is waiting on “${named}”. Open the thread to answer it.\n\n${link}`,
        );
        break;
      }
      if (TERMINAL_STATUSES.includes(page.status)) {
        const link = yield* deps.port.threadUrl(begun.threadId);
        yield* say(
          page.status === "completed"
            ? `\n\n${link}`
            : `\n\nThat run ended ${page.status} in T3.\n\n${link}`,
        );
        break;
      }
      if (waited >= deps.maxWaitMs) {
        const link = yield* deps.port.threadUrl(begun.threadId);
        yield* say(
          `\n\nT3 is still working on this. It keeps going after you close this window.\n\n${link}`,
        );
        break;
      }
      yield* Effect.sleep(deps.pollIntervalMs);
      waited += deps.pollIntervalMs;
    }

    // The next turn arrives carrying this answer, so the thread is remembered
    // against the history that answer completes.
    const now = yield* Clock.currentTimeMillis;
    const sessions = yield* deps.sessions.read();
    yield* deps.sessions.write(
      pruneSessions(rememberThread(sessions, answerSignature(answer), begun.threadId, now), now),
    );

    return { threadId: begun.threadId, captureDropped: begun.preface !== "" };
  });

/** One complete ask, as a caller that does not need the split hears it. */
export const runTurn = (
  deps: TurnDeps,
  request: TurnRequest,
  emit: (text: string) => Effect.Effect<void>,
): Effect.Effect<TurnOutcome, VoiceBridgeError> =>
  Effect.gen(function* () {
    const begun = yield* beginTurn(deps, request);
    yield* push(emit, begun.preface);
    return yield* streamTurn(deps, request, begun, emit);
  });
