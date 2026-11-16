import { RunSetupComposedPrompt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ByteSize from "effect/ByteSize";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as RunSetupRecorder from "../agents/RunSetupRecorder.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const services = HttpRouter.middleware<{ provides: RunSetupRecorder.ComposedRunSetupRecorder }>()(
  Effect.gen(function* () {
    const recorder = yield* RunSetupRecorder.ComposedRunSetupRecorder;
    return (effect) =>
      Effect.provideService(effect, RunSetupRecorder.ComposedRunSetupRecorder, recorder);
  }),
).layer.pipe(
  Layer.provide(RunSetupRecorder.composedLayer.pipe(Layer.provide(ProjectionStore.layer))),
);

const decode = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.Number,
    method: Schema.Literal("t3/run-setup"),
    params: RunSetupComposedPrompt,
  }),
);

export const layer = HttpRouter.add(
  "POST",
  "/mcp/run-setup",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const scope = yield* registry.resolve(parseBearerToken(request) ?? "");
    if (scope?.thread === undefined || scope.client !== undefined)
      return HttpServerResponse.empty({ status: 401 });
    const input = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(256 * 1024)),
      Effect.flatMap(decode),
      Effect.option,
    );
    if (Option.isNone(input)) return HttpServerResponse.empty({ status: 400 });
    const recorder = yield* RunSetupRecorder.ComposedRunSetupRecorder;
    return yield* recorder.report(scope.thread, input.value.params).pipe(
      Effect.as(HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: input.value.id, result: {} })),
      Effect.catchTags({
        RunSetupStoreError: () => Effect.succeed(HttpServerResponse.empty({ status: 500 })),
      }),
    );
  }),
).pipe(Layer.provide(services));
