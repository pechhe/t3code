import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { beginTurn, runTurn, type TurnDeps, type TurnRequest } from "./Bridge.ts";
import type { CapturedWindow } from "./Capture.ts";
import type { ChatMessage } from "./Conversation.ts";
import { conversationSignature, historyBeforeInstruction, historyWithAnswer } from "./Conversation.ts";
import { EMPTY_SESSIONS, type SessionStore } from "./Sessions.ts";
import type { ThreadPage, TurnResult, VoiceBridgePort } from "./T3Port.ts";
import { VoiceBridgeError } from "./T3Port.ts";

const MESSAGES: ReadonlyArray<ChatMessage> = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "compare these three plans" },
];

const CAPTURE: CapturedWindow = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  name: "SnapShot-Safari.png",
  mimeType: "image/png",
  sizeBytes: 4,
  appName: "Safari",
};

const MODEL = "codex/gpt-6.1-sol";

type PageItem = ThreadPage["items"][number];

const assistantItem = (position: number, text: string): PageItem => ({
  position,
  type: "assistant_message",
  title: null,
  text,
});

const page = (over: Partial<ThreadPage> = {}): ThreadPage => {
  const items = over.items ?? [];
  return {
    status: "completed",
    pendingRequestCount: 0,
    modelId: MODEL,
    nextPosition: (items.at(-1)?.position ?? -1) + 1,
    lastPosition: items.at(-1)?.position ?? null,
    hasMore: false,
    ...over,
    items,
  };
};

type Harness = {
  readonly deps: TurnDeps;
  readonly launched: Ref.Ref<ReadonlyArray<Record<string, unknown>>>;
  readonly sent: Ref.Ref<ReadonlyArray<Record<string, unknown>>>;
  readonly uploads: Ref.Ref<number>;
  readonly saved: Ref.Ref<SessionStore>;
};

/** A port whose reads answer in the order the test scripted them. */
const makeHarness = (options: {
  readonly pages: ReadonlyArray<ThreadPage>;
  readonly capture?: CapturedWindow | null;
  readonly sessions?: SessionStore;
  readonly question?: string | null;
  readonly approval?: string | null;
  readonly failOnceWith?: VoiceBridgeError;
}) =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
    const sent = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
    const uploads = yield* Ref.make(0);
    const saved = yield* Ref.make<SessionStore>(EMPTY_SESSIONS);
    const readIndex = yield* Ref.make(0);
    const sendCount = yield* Ref.make(0);
    const fallback = page();

    const port: VoiceBridgePort = {
      capabilities: () => Effect.succeed({ environmentId: "env-1", providers: [] }),
      prepareUpload: () => Effect.succeed({ attachmentId: "attachment-1", relativeUrl: "/upload" }),
      uploadBytes: () => Ref.update(uploads, (count) => count + 1),
      launch: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(launched, (all) => [...all, input as unknown as Record<string, unknown>]);
          return { threadId: "thread-new", runId: "run-1", status: "starting" } satisfies TurnResult;
        }),
      send: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sent, (all) => [...all, input as unknown as Record<string, unknown>]);
          const count = yield* Ref.updateAndGet(sendCount, (value) => value + 1);
          if (count === 1 && options.failOnceWith !== undefined) {
            return yield* Effect.fail(options.failOnceWith);
          }
          return { threadId: input.threadId, runId: "run-2", status: "starting" } satisfies TurnResult;
        }),
      readThread: (_threadId, readOptions) =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(readIndex, (value) => value + 1);
          const scripted = options.pages[index - 1] ?? fallback;
          // `afterPosition` is exclusive in T3's projection, so the fake is too:
          // a test that hides that would hide a lost message.
          const after = readOptions?.afterPosition;
          if (after === undefined) return scripted;
          return { ...scripted, items: scripted.items.filter((item) => item.position > after) };
        }),
      pendingQuestion: () => Effect.succeed(options.question ?? null),
      pendingApproval: () => Effect.succeed(options.approval ?? null),
      threadUrl: (threadId) => Effect.succeed(`http://127.0.0.1:3773/env-1/${threadId}`),
    };

    const deps: TurnDeps = {
      port,
      capture: () => Effect.succeed(options.capture ?? null),
      sessions: {
        read: () => Effect.succeed(options.sessions ?? EMPTY_SESSIONS),
        write: (store) => Ref.set(saved, store),
      },
      pollIntervalMs: 0,
      maxWaitMs: 50,
    };

    return { deps, launched, sent, uploads, saved } satisfies Harness;
  });

const run = (deps: TurnDeps, request: TurnRequest) =>
  Effect.gen(function* () {
    const emitted = yield* Ref.make<ReadonlyArray<string>>([]);
    const outcome = yield* runTurn(deps, request, (text) => Ref.update(emitted, (all) => [...all, text]));
    return { outcome, texts: yield* Ref.get(emitted) };
  });

const sessionsFor = (messages: ReadonlyArray<ChatMessage>, threadId: string): SessionStore => ({
  version: 1,
  entries: { [conversationSignature(messages)]: { threadId, updatedAt: 1 } },
});

/** The history a conversation carries once the bridge has answered it. */
const ANSWERED: ReadonlyArray<ChatMessage> = [
  ...MESSAGES,
  { role: "assistant", content: "First answer.\n\nhttp://127.0.0.1:3773/env-1/thread-old" },
];

/** A conversation that already carries one answer, so the next ask continues it. */
const FOLLOW_UP: ReadonlyArray<ChatMessage> = [
  ...ANSWERED,
  { role: "user", content: "and the last one?" },
];

it.effect("a new ask starts a scratch thread with the words, its title and the capture", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      capture: CAPTURE,
      pages: [
        page({ status: "running", items: [assistantItem(1, "Three plans")], nextPosition: 2 }),
        page({
          items: [assistantItem(2, ", and the middle one.")],
          nextPosition: 3,
        }),
      ],
    });
    const { outcome, texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });

    const launches = yield* Ref.get(harness.launched);
    assert.lengthOf(launches, 1);
    assert.strictEqual(launches[0]?.title, "compare these three plans");
    assert.include(String(launches[0]?.message), "The attached screenshot");
    assert.deepStrictEqual(launches[0]?.attachment, {
      id: "attachment-1",
      name: "SnapShot-Safari.png",
      mimeType: "image/png",
      sizeBytes: 4,
    });
    assert.strictEqual(yield* Ref.get(harness.uploads), 1);
    assert.strictEqual(outcome.captureDropped, false);
    assert.deepStrictEqual(texts, [
      "Three plans",
      ", and the middle one.",
      "\n\nhttp://127.0.0.1:3773/env-1/thread-new",
    ]);
  }),
);

it.effect("a follow-up continues its thread, streams only what is new, and saves the next history", () =>
  Effect.gen(function* () {
    const followUp = FOLLOW_UP;
    const harness = yield* makeHarness({
      sessions: sessionsFor(historyBeforeInstruction(followUp), "thread-old"),
      // The baseline read proves the thread's model before the ask is sent.
      pages: [
        // The baseline read that also proves the thread's model.
        page({ modelId: MODEL, nextPosition: 3 }),
        page({
          items: [assistantItem(3, "Second answer.")],
          nextPosition: 4,
        }),
      ],
    });
    const { outcome, texts } = yield* run(harness.deps, { model: MODEL, messages: followUp });

    assert.strictEqual(outcome.threadId, "thread-old");
    assert.lengthOf(yield* Ref.get(harness.sent), 1);
    assert.lengthOf(yield* Ref.get(harness.launched), 0);
    assert.deepStrictEqual(texts, ["Second answer.", "\n\nhttp://127.0.0.1:3773/env-1/thread-old"]);
    const saved = yield* Ref.get(harness.saved);
    assert.strictEqual(
      saved.entries[conversationSignature(historyWithAnswer(followUp, texts.join("")))]?.threadId,
      "thread-old",
    );
  }),
);

it.effect("picking another model starts a new thread rather than answering on the old one", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      sessions: sessionsFor(ANSWERED, "thread-old"),
      pages: [
        page({ modelId: "claudeAgent/claude-sonnet-5-5", nextPosition: 3 }),
        page({ items: [assistantItem(1, "Fresh.")], nextPosition: 2 }),
      ],
    });
    const { outcome } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.strictEqual(outcome.threadId, "thread-new");
    assert.lengthOf(yield* Ref.get(harness.launched), 1);
    assert.lengthOf(yield* Ref.get(harness.sent), 0);
  }),
);

it.effect("follows pages until the thread has more to give", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      pages: [
        page({
          status: "running",
          items: [assistantItem(1, "A".repeat(4))],
          nextPosition: 2,
          hasMore: true,
        }),
        page({
          items: [assistantItem(2, "B".repeat(4))],
          nextPosition: 3,
        }),
      ],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.deepStrictEqual(texts, ["AAAA", "BBBB", "\n\nhttp://127.0.0.1:3773/env-1/thread-new"]);
  }),
);

it.effect("a text-only ask carries no attachment and still starts a thread", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      capture: null,
      pages: [page({ items: [assistantItem(1, "Done.")] })],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });

    assert.notProperty((yield* Ref.get(harness.launched))[0] ?? {}, "attachment");
    assert.strictEqual(yield* Ref.get(harness.uploads), 0);
    assert.deepStrictEqual(texts, ["Done.", "\n\nhttp://127.0.0.1:3773/env-1/thread-new"]);
  }),
);

it.effect("drops the capture and says so when the provider cannot carry it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      capture: CAPTURE,
      sessions: sessionsFor(ANSWERED, "thread-old"),
      failOnceWith: new VoiceBridgeError({ reason: "send", detail: "attachments are unsupported" }),
      pages: [
        page({ nextPosition: 3 }),
        page({ items: [assistantItem(3, "Answer.")], nextPosition: 4 }),
      ],
    });
    const { outcome, texts } = yield* run(harness.deps, { model: MODEL, messages: FOLLOW_UP });

    const sent = yield* Ref.get(harness.sent);
    assert.lengthOf(sent, 2);
    assert.notProperty(sent[1] ?? {}, "attachment");
    assert.strictEqual(outcome.captureDropped, true);
    assert.deepStrictEqual(texts, [
      "_The screenshot could not be attached, so this is the words only._\n\n",
      "Answer.",
      "\n\nhttp://127.0.0.1:3773/env-1/thread-old",
    ]);
  }),
);

it.effect("a refusal that is not about the capture is reported, not retried", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      capture: CAPTURE,
      sessions: sessionsFor(ANSWERED, "thread-old"),
      failOnceWith: new VoiceBridgeError({ reason: "send", detail: "the provider is offline" }),
      pages: [page({ nextPosition: 3 })],
    });
    const failure = yield* run(harness.deps, { model: MODEL, messages: FOLLOW_UP }).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "send");
    assert.lengthOf(yield* Ref.get(harness.sent), 1);
  }),
);

it.effect("names the question T3 is waiting on, instead of holding the window open", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      question: "Which environment?",
      pages: [
        page({ status: "running", items: [assistantItem(1, "I need to ask.")] }),
        page({ status: "waiting", pendingRequestCount: 1 }),
      ],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    const last = texts.at(-1) ?? "";
    assert.include(last, "Which environment?");
    assert.include(last, "http://127.0.0.1:3773/env-1/thread-new");
  }),
);

it.effect("says a wait is a decision when T3 names no question", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      question: null,
      pages: [page({ status: "waiting", pendingRequestCount: 1 })],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.include(texts.at(-1) ?? "", "waiting on a decision");
  }),
);

it.effect("re-reads a message that is still being written and emits only its new words", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      pages: [
        page({ status: "running", items: [assistantItem(1, "Hello")] }),
        page({ status: "completed", items: [assistantItem(1, "Hello world")] }),
      ],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.deepStrictEqual(texts, ["Hello", " world", "\n\nhttp://127.0.0.1:3773/env-1/thread-new"]);
  }),
);

it.effect("names an approval T3 is waiting on", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      question: null,
      approval: "Run the tests?",
      pages: [page({ status: "waiting", pendingRequestCount: 1 })],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.include(texts.at(-1) ?? "", "Run the tests?");
  }),
);

it.effect("says how a run that failed ended", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      pages: [
        page({
          status: "failed",
          items: [assistantItem(1, "Half an answer.")],
        }),
      ],
    });
    const { texts } = yield* run(harness.deps, { model: MODEL, messages: MESSAGES });
    assert.deepStrictEqual(texts, [
      "Half an answer.",
      "\n\nThat run ended failed in T3.\n\nhttp://127.0.0.1:3773/env-1/thread-new",
    ]);
  }),
);

it.effect("refuses a model it did not offer, and creates nothing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ pages: [] });
    const failure = yield* beginTurn(harness.deps, { model: "nonsense", messages: MESSAGES }).pipe(
      Effect.flip,
    );
    assert.strictEqual(failure.reason, "launch");
    assert.lengthOf(yield* Ref.get(harness.launched), 0);
  }),
);

it.effect("refuses a request that says nothing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ pages: [] });
    const failure = yield* beginTurn(harness.deps, {
      model: MODEL,
      messages: [{ role: "system", content: "only a system prompt" }],
    }).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "launch");
  }),
);

it.effect("stamps the session with the clock", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ capture: null, pages: [page()] });
    const before = yield* Clock.currentTimeMillis;
    yield* runTurn(harness.deps, { model: MODEL, messages: MESSAGES }, () => Effect.void);
    const entry = Object.values((yield* Ref.get(harness.saved)).entries)[0];
    assert.isAtLeast(entry?.updatedAt ?? 0, before);
  }),
);
