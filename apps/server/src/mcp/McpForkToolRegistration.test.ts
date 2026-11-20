import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { MCP_PROGRESS_HEARTBEAT_INTERVAL } from "./McpProgressHeartbeat.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as ServerSettings from "../serverSettings.ts";

const token = "providerTokenWithoutDots";
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-test"),
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-provider"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const SlowToolkit = Toolkit.make(
  Tool.make("slow", {
    description: "Waits for the test to release it.",
    success: Schema.Struct({
      ok: Schema.Boolean,
      detail: Schema.optional(Schema.Struct({ note: Schema.String })),
    }),
  }),
);

const accept = "application/json, text/event-stream";

const setup = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const layerServer = McpHttpServer.layerMcpTransport(
    McpHttpServer.toolkitRegistration(
      SlowToolkit,
      McpToolAccess.toLayer(SlowToolkit, {
        slow: McpToolAccess.reads(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ ok: true }),
          ),
        ),
      }),
    ),
  ).pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (presented) =>
          Effect.succeed(
            presented === token
              ? (scope as McpInvocationContext.McpThreadInvocationScope)
              : undefined,
          ),
      }),
    ),
  );
  yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  );
  const initialized = yield* client.post("/mcp", {
    headers: { accept },
    body: HttpBody.text(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-test", version: "1.0.0" },
        },
      }),
      "application/json",
    ),
  });
  const sessionId = initialized.headers["mcp-session-id"]!;
  yield* client.post("/mcp", {
    headers: { accept, "mcp-session-id": sessionId },
    body: HttpBody.text(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "application/json",
    ),
  });
  const callSlow = (progressToken?: string) =>
    client.post("/mcp", {
      headers: { accept, "mcp-session-id": sessionId },
      body: HttpBody.text(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "slow",
            arguments: {},
            ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
          },
        }),
        "application/json",
      ),
    });
  const listTools = client.post("/mcp", {
    headers: { accept, "mcp-session-id": sessionId },
    body: HttpBody.text(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      "application/json",
    ),
  });
  return { callSlow, listTools, started, release };
});

it.effect(
  "streams progress notifications before the result when the call has a progress token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { callSlow, started, release } = yield* setup;
        const call = yield* Effect.forkChild(callSlow("probe-token"));
        yield* Deferred.await(started);
        yield* TestClock.adjust(MCP_PROGRESS_HEARTBEAT_INTERVAL);
        // Headers arrive while the handler is still blocked: the heartbeat flushed the response.
        const response = yield* Fiber.join(call);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        yield* TestClock.adjust(MCP_PROGRESS_HEARTBEAT_INTERVAL);
        yield* Deferred.succeed(release, undefined);
        const body = yield* Stream.runCollect(response.stream.pipe(Stream.decodeText())).pipe(
          Effect.map((chunks) => chunks.join("")),
        );
        const messages = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, any>);
        const progress = messages.filter((m) => m.method === "notifications/progress");
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(progress.every((m) => m.params.progressToken === "probe-token")).toBe(true);
        const values = progress.map((m) => m.params.progress as number);
        expect(values).toEqual([...values].toSorted((a, b) => a - b));
        expect(new Set(values).size).toBe(values.length);
        const result = messages.find((m) => m.id === 2);
        expect(result?.result.structuredContent).toEqual({ ok: true });
        expect(messages.indexOf(result!)).toBe(messages.length - 1);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("answers a call without a progress token with plain JSON", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { callSlow, started, release } = yield* setup;
      const call = yield* Effect.forkChild(callSlow());
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.times(MCP_PROGRESS_HEARTBEAT_INTERVAL, 3));
      yield* Deferred.succeed(release, undefined);
      const response = yield* Fiber.join(call);
      expect(response.headers["content-type"]).toContain("application/json");
      const body = (yield* response.json) as { result: { structuredContent: unknown } };
      expect(body.result.structuredContent).toEqual({ ok: true });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("advertises each tool's result schema with its top-level fields only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { listTools } = yield* setup;
      const response = yield* listTools;
      const body = (yield* response.json) as {
        result: { tools: Array<{ name: string; outputSchema?: unknown }> };
      };
      expect(body.result.tools.find((tool) => tool.name === "slow")?.outputSchema).toEqual({
        type: "object",
        properties: { ok: { type: "boolean" }, detail: {} },
        required: ["ok"],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
