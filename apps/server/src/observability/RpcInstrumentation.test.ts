import { assert, describe, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";

import * as Tracer from "effect/Tracer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import {
  RPC_SERVER_TRACING_OPTIONS,
  RpcInstrumentation,
  rpcInstrumentationLayer,
} from "./RpcInstrumentation.ts";

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

const groupOf = <const Tags extends ReadonlyArray<WsRpcMethod>>(...tags: Tags) =>
  WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsRpcMethod, Tags[number]> =>
        !(tags as ReadonlyArray<string>).includes(tag),
    ),
  ).middleware(RpcInstrumentation);

const connectionMiddleware = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.merge(RpcAuthorization.layer(scopes), rpcInstrumentationLayer);
const readOnlyConnection = connectionMiddleware([AuthOrchestrationReadScope]);

// RpcTest's in-memory client and server, with the server traced as ws.ts traces it.
const makeClient = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
) {
  let client!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never>>>;
  const server = yield* RpcServer.makeNoSerialization(group, {
    ...RPC_SERVER_TRACING_OPTIONS,
    onFromServer: (response) => client.write(response),
  });
  client = yield* RpcClient.makeNoSerialization(group, {
    supportsAck: true,
    onFromClient: ({ message }) => server.write(0, message),
  });
  return client.client;
});

const withTelemetry = <A, E, R>(
  test: (ended: ReadonlyArray<Tracer.NativeSpan>) => Effect.Effect<A, E, R>,
) => {
  const ended: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        ended.push(span);
      };
      return span;
    },
  });
  return test(ended).pipe(
    Effect.scoped,
    Effect.withTracer(tracer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
};

const rpcSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => span.name.startsWith("ws.rpc."));

const serverSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => span.kind !== "client");

const parentSpanId = (span: Tracer.NativeSpan | undefined) =>
  span?.parent._tag === "Some" ? span.parent.value.spanId : undefined;

const requestCount = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  method: string,
  outcome: string,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Counter" }> =>
      snapshot.type === "Counter" &&
      snapshot.id === "t3_rpc_requests_total" &&
      snapshot.attributes?.["method"] === method &&
      snapshot.attributes?.["outcome"] === outcome,
  )?.state;

describe("WS RPC instrumentation middleware", () => {
  it.effect("parents the server span on the client's span for the same request", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const group = groupOf(WS_METHODS.serverProbe);
        const client = yield* makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
              readOnlyConnection,
            ),
          ),
        );

        yield* client[WS_METHODS.serverProbe]({});

        const clientSpan = ended.find((span) => span.kind === "client");
        const [serverSpan] = rpcSpans(ended);
        assert.isDefined(clientSpan);
        assert.equal(serverSpan?.traceId, clientSpan?.traceId);
        assert.equal(parentSpanId(serverSpan), clientSpan?.spanId);
      }),
    ),
  );

  it.effect("records metrics and only the request span for methods with tracing disabled", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const group = groupOf(WS_METHODS.serverSignalProcess);
        const client = yield* makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverSignalProcess, (input) =>
                Effect.succeed({
                  pid: input.pid,
                  signal: input.signal,
                  signaled: true,
                  message: Option.none(),
                }).pipe(Effect.withSpan("signalProcess.child")),
              ),
              connectionMiddleware([AuthOrchestrationReadScope, AuthEnvironmentMaintainScope]),
            ),
          ),
        );

        const input = { pid: 4242, startTimeMs: 0, signal: "SIGINT" } as const;
        assert.equal((yield* client[WS_METHODS.serverSignalProcess](input)).signaled, true);

        assert.deepStrictEqual(
          serverSpans(ended).map((span) => span.name),
          ["ws.rpc.server.signalProcess"],
        );
        const snapshots = yield* Metric.snapshot;
        assert.equal(requestCount(snapshots, WS_METHODS.serverSignalProcess, "success")?.count, 1);
      }),
    ),
  );
});
