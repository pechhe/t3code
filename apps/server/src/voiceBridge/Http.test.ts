import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";

import type { TurnDeps } from "./Bridge.ts";
import type { ChatMessage } from "./Conversation.ts";
import { routes } from "./Http.ts";
import { EMPTY_SESSIONS, type SessionStore } from "./Sessions.ts";
import type { ThreadPage, VoiceBridgePort } from "./T3Port.ts";
import { VoiceBridgeError } from "./T3Port.ts";

const MESSAGES: ReadonlyArray<ChatMessage> = [{ role: "user", content: "summarise this page" }];
const MODEL = "codex/gpt-6.1-sol";

const capabilities = {
  providers: [
    {
      providerInstanceId: "codex",
      displayName: "Codex",
      models: [{ id: "gpt-6.1-sol", label: "Sol" }],
      constraints: [],
    },
    {
      providerInstanceId: "cursor",
      displayName: "Cursor",
      models: [{ id: "cursor-fast" }],
      constraints: ["Provider instance is disabled."],
    },
  ],
};

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

type Counts = {
  readonly launches: Ref.Ref<number>;
  readonly sessions: Ref.Ref<SessionStore>;
};

/**
 * The routes over a port that never reaches a real server, so the test reads the
 * HTTP contract: what a provider sees, and what it costs in threads.
 */
const withServer = <A, E>(
  options: {
    readonly paired?: boolean;
    readonly pages?: ReadonlyArray<ThreadPage>;
    readonly launchFailure?: VoiceBridgeError;
  },
  run: (http: HttpClient.HttpClient, counts: Counts) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launches = yield* Ref.make(0);
      const sessions = yield* Ref.make<SessionStore>(EMPTY_SESSIONS);
      const readIndex = yield* Ref.make(0);
      const pages = options.pages ?? [
        page({ items: [{ position: 1, type: "assistant_message", title: null, text: "It is a pricing page." }] }),
      ];

      const port: VoiceBridgePort = {
        capabilities: () =>
          options.paired === false
            ? Effect.fail(new VoiceBridgeError({ reason: "unauthorized", detail: "not signed in" }))
            : Effect.succeed(capabilities),
        prepareUpload: () => Effect.die("this test never captures"),
        uploadBytes: () => Effect.die("this test never captures"),
        launch: (input) =>
          Effect.gen(function* () {
            if (options.launchFailure !== undefined) return yield* Effect.fail(options.launchFailure);
            yield* Ref.update(launches, (count) => count + 1);
            return { threadId: `thread-${input.title.length}`, runId: "run-1", status: "starting" };
          }),
        send: () => Effect.die("this test starts threads only"),
        readThread: () =>
          Effect.gen(function* () {
            const index = yield* Ref.updateAndGet(readIndex, (value) => value + 1);
            return pages[index - 1] ?? pages[pages.length - 1]!;
          }),
        pendingQuestion: () => Effect.succeed(null),
        pendingApproval: () => Effect.succeed(null),
      };
      const deps: TurnDeps = {
        port,
        capture: () => Effect.succeed(null),
        sessions: {
          read: () => Effect.succeed(EMPTY_SESSIONS),
          write: (store) => Ref.set(sessions, store),
        },
        pollIntervalMs: 0,
        maxWaitMs: 50,
      };

      const services = yield* Layer.build(
        HttpRouter.serve(routes({ deps }), { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const http = Context.get(services, HttpClient.HttpClient);
      return yield* run(http, { launches, sessions });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const ModelsResponse = Schema.Struct({
  object: Schema.String,
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const CompletionResponse = Schema.Struct({
  object: Schema.String,
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
});

const HealthResponse = Schema.Struct({ status: Schema.String, paired: Schema.Boolean });

it.effect("lists T3's usable models in the shape a provider expects", () =>
  withServer({}, (http, counts) =>
    Effect.gen(function* () {
      const response = yield* http.execute(HttpClientRequest.get("/v1/models"));
      const body = yield* HttpClientResponse.schemaBodyJson(ModelsResponse)(response);
      assert.strictEqual(body.object, "list");
      assert.deepStrictEqual(
        body.data.map((model) => model.id),
        ["codex/gpt-6.1-sol"],
      );
      assert.strictEqual(body.data[0]?.name, "Codex · Sol");
      assert.strictEqual(yield* Ref.get(counts.launches), 0, "listing models starts no thread");
    }),
  ),
);

it.effect("streams the answer as chat-completion deltas, ending with the thread link", () =>
  withServer(
    {
      pages: [
        page({ status: "running", items: [{ position: 1, type: "assistant_message", title: null, text: "It is" }] }),
        page({
          status: "completed",
          items: [{ position: 2, type: "assistant_message", title: null, text: " a pricing page." }],
        }),
      ],
    },
    (http, counts) =>
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post("/v1/chat/completions").pipe(
            HttpClientRequest.bodyJsonUnsafe({ model: MODEL, messages: MESSAGES, stream: true }),
          ),
        );
        const body = yield* response.text;
        assert.strictEqual(response.status, 200);
        assert.include(body, '"role":"assistant"');
        assert.include(body, "It is");
        assert.include(body, " a pricing page.");
        assert.include(body, "t3-thread://v1/");
        assert.include(body, '"finish_reason":"stop"');
        assert.include(body, "data: [DONE]");
        assert.strictEqual(yield* Ref.get(counts.launches), 1, "one ask starts one thread");
      }),
  ),
);

it.effect("answers a non-streaming completion with the thread's text and a link", () =>
  withServer({}, (http, counts) =>
    Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.post("/v1/chat/completions").pipe(
          HttpClientRequest.bodyJsonUnsafe({ model: MODEL, messages: MESSAGES, stream: false }),
        ),
      );
      const body = yield* HttpClientResponse.schemaBodyJson(CompletionResponse)(response);
      const content = body.choices[0]?.message.content ?? "";
      assert.include(content, "It is a pricing page.");
      assert.include(content, "t3-thread://v1/");
      assert.strictEqual(yield* Ref.get(counts.launches), 1);
    }),
  ),
);

it.effect("reports a thread it could not start as a provider error, not an answer", () =>
  withServer(
    {
      launchFailure: new VoiceBridgeError({ reason: "unauthorized", detail: "the bridge is not signed in" }),
    },
    (http) =>
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post("/v1/chat/completions").pipe(
            HttpClientRequest.bodyJsonUnsafe({ model: MODEL, messages: MESSAGES, stream: true }),
          ),
        );
        assert.strictEqual(response.status, 502);
        const body = yield* response.text;
        assert.include(body, "not signed in");
      }),
  ),
);

it.effect("reports an unpaired bridge without failing the health check", () =>
  withServer({ paired: false }, (http) =>
    Effect.gen(function* () {
      const response = yield* http.execute(HttpClientRequest.get("/health"));
      const body = yield* HttpClientResponse.schemaBodyJson(HealthResponse)(response);
      assert.strictEqual(body.status, "ok");
      assert.strictEqual(body.paired, false);
    }),
  ),
);

it.effect("answers a request with no model as an error, and creates nothing", () =>
  withServer({}, (http, counts) =>
    Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.post("/v1/chat/completions").pipe(
          HttpClientRequest.bodyJsonUnsafe({ messages: MESSAGES }),
        ),
      );
      assert.isAtLeast(response.status, 400);
      assert.strictEqual(yield* Ref.get(counts.launches), 0);
    }),
  ),
);
