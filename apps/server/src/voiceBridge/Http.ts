import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { beginTurn, streamTurn, type TurnDeps } from "./Bridge.ts";
import { modelsFromCapabilities } from "./Catalog.ts";
import { roleChunk, SSE_DONE, sseEvent, stopChunk, textChunk } from "./Sse.ts";

/** The parts of a FluidVoice Command request this bridge reads. */
const ChatContentPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

const ChatMessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(ChatContentPart)]),
});

const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessageSchema),
  stream: Schema.optional(Schema.Boolean),
});

const openAiError = (message: string, type: string) => ({ error: { message, type } });

const completionId = (now: number) => `chatcmpl-${now.toString(36)}`;

export type BridgeRoutes = {
  readonly deps: TurnDeps;
};

/**
 * The OpenAI-compatible surface FluidVoice talks to as a provider: a model list,
 * a chat completion (streamed or not), and a health answer that also says
 * whether this bridge is still signed in to T3.
 *
 * A turn is dispatched before the response starts, so a refusal to start it is an
 * error status the provider reports, not an assistant message that looks like an
 * answer. Only the answer itself streams after that.
 */
export const routes = ({ deps }: BridgeRoutes) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const health = Effect.fnUntraced(function* () {
        const now = yield* Clock.currentTimeMillis;
        const capabilities = yield* deps
          .port
          .capabilities()
          .pipe(
            Effect.map((value) => ({
              paired: true,
              models: modelsFromCapabilities(value, now).length,
            })),
            Effect.catch(() => Effect.succeed({ paired: false, models: 0 })),
          );
        return yield* HttpServerResponse.json({ status: "ok", ...capabilities });
      });

      const listModels = Effect.fnUntraced(function* () {
        const now = yield* Clock.currentTimeMillis;
        const capabilities = yield* deps.port.capabilities();
        return yield* HttpServerResponse.json({
          object: "list",
          data: modelsFromCapabilities(capabilities, now),
        });
      });

      const complete = Effect.fnUntraced(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.mapError(() =>
            openAiError("The request body was not JSON.", "invalid_request_error"),
          ),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(ChatRequest)(value).pipe(
              Effect.mapError(() =>
                openAiError("The request needs a model and messages.", "invalid_request_error"),
              ),
            ),
          ),
        );
        const created = yield* Clock.currentTimeMillis;
        const id = completionId(created);

        const begunResult = yield* Effect.result(beginTurn(deps, body));
        if (Result.isFailure(begunResult)) {
          return yield* HttpServerResponse.json(
            openAiError(begunResult.failure.message, "bridge_error"),
            { status: 502 },
          );
        }
        const begun = begunResult.success;

        if (body.stream === false) {
          const collected: Array<string> = [];
          yield* streamTurn(deps, body, begun, (text) =>
            Effect.sync(() => {
              collected.push(text);
            }),
          );
          return yield* HttpServerResponse.json({
            id,
            object: "chat.completion",
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: collected.join("") },
                finish_reason: "stop",
              },
            ],
          });
        }

        // The producer lives in the response stream's scope, so it runs while
        // the body is being consumed and stops when the consumer is gone.
        const deltas = Stream.unwrap(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<string>();
            const offer = (event: string) => Queue.offer(events, event).pipe(Effect.asVoid);
            yield* Effect.forkScoped(
              streamTurn(deps, body, begun, (text) =>
                offer(sseEvent(textChunk(id, created, body.model, text))),
              ).pipe(
                Effect.andThen(offer(sseEvent(stopChunk(id, created, body.model)))),
                // A failure after the answer started is part of what the person
                // is reading: the transport already succeeded.
                Effect.catch((error) =>
                  offer(sseEvent(textChunk(id, created, body.model, `\n\n${error.message}\n\n`))),
                ),
                Effect.ensuring(offer(SSE_DONE)),
              ),
            );
            return Stream.fromQueue(events).pipe(
              Stream.takeUntil((event) => event === SSE_DONE),
            );
          }),
        );

        const head = [
          sseEvent(roleChunk(id, created, body.model)),
          ...(begun.preface === "" ? [] : [sseEvent(textChunk(id, created, body.model, begun.preface))]),
        ];
        return HttpServerResponse.stream(
          Stream.concat(Stream.fromIterable(head), deltas).pipe(Stream.encodeText),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          },
        );
      });

      yield* router.add("GET", "/health", health);
      yield* router.add("GET", "/v1/models", listModels);
      yield* router.add("POST", "/v1/chat/completions", complete);
    }),
  );
