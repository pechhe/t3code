import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import { PreviewManager } from "../preview/Manager.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { MANAGED_BROWSER_TOOL_NAMES } from "./toolkits/managedBrowser/toolNames.ts";
import {
  ManagedBrowserSnapshotToolkit,
  ManagedBrowserToolkit,
} from "./toolkits/managedBrowser/tools.ts";

const environmentId = EnvironmentId.make("environment-managed-browser");
const scopeFor = (managedBrowser: boolean): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-managed-browser"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(managedBrowser ? ["preview"] : ["preview", "orchestration"]),
  issuedAt: 1,
  ...(managedBrowser ? { managedBrowser: true as const } : {}),
});
const tokens = { managed: "managedTokenWithoutDots", general: "generalTokenWithoutDots" };
const registry = Layer.mock(McpSessionRegistry.McpSessionRegistry)({
  resolve: (presented) =>
    Effect.succeed(
      presented === tokens.managed
        ? scopeFor(true)
        : presented === tokens.general
          ? scopeFor(false)
          : undefined,
    ),
});
const services = Layer.mergeAll(
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(PreviewManager)({}),
  PreviewAutomationBroker.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-browser-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`;
const accept = "application/json, text/event-stream";

/** The first JSON-RPC message in a response, whether the server sent JSON or an event stream. */
const message = (text: string) =>
  decodeJson(
    text.trimStart().startsWith("{")
      ? text
      : (text.split("\n").find((line) => line.startsWith("data:")) ?? "data:{}").slice(5),
  ) as { readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> } };

const listTools = (path: string, token: string) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    );
    const opened = yield* http.post(path, {
      headers: { accept },
      body: HttpBody.text(initialize, "application/json"),
    });
    if (opened.status !== 200) return { status: opened.status, names: [] as Array<string> };
    const sessionId = opened.headers["mcp-session-id"]!;
    yield* http.post(path, {
      headers: { accept, "mcp-session-id": sessionId },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
        "application/json",
      ),
    });
    const listed = yield* http.post(path, {
      headers: { accept, "mcp-session-id": sessionId },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
        "application/json",
      ),
    });
    const body = message(yield* listed.text);
    return { status: listed.status, names: (body.result?.tools ?? []).map((tool) => tool.name) };
  });

it("lists exactly the managed browser tools the adapters pre-approve", () => {
  const toolkit = [
    ...Object.keys(ManagedBrowserToolkit.tools),
    ...Object.keys(ManagedBrowserSnapshotToolkit.tools),
  ];
  expect([...toolkit].sort()).toEqual([...MANAGED_BROWSER_TOOL_NAMES].sort());
  // Nothing that runs page code, shells out, or reaches T3 state is among them.
  for (const forbidden of [
    "preview_evaluate",
    "preview_upload",
    "preview_recording_start",
    "delegate_task",
    "t3_thread_send",
  ])
    expect(MANAGED_BROWSER_TOOL_NAMES).not.toContain(forbidden);
});

it.effect("serves a managed browser task only the narrow endpoint, and only its own token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Composed as the server composes them: the endpoints must not share one tool registry.
      const both = Layer.mergeAll(
        McpHttpServer.layerManagedBrowserToolkit,
        McpHttpServer.layerPreviewToolkit,
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(registry),
        Layer.provide(services),
      );
      yield* HttpRouter.serve(both, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );

      const mine = yield* listTools("/mcp/browser", tokens.managed);
      expect(mine.status).toBe(200);
      expect([...mine.names].sort()).toEqual([...MANAGED_BROWSER_TOOL_NAMES].sort());

      const general = yield* listTools("/mcp", tokens.general);
      expect(general.status).toBe(200);
      expect(general.names).toContain("preview_evaluate");

      // A general credential cannot reach the managed endpoint, nor a managed one the general.
      expect((yield* listTools("/mcp/browser", tokens.general)).status).toBe(401);
      expect((yield* listTools("/mcp", tokens.managed)).status).toBe(401);
      expect((yield* listTools("/mcp/browser", "unknownTokenWithoutDots")).status).toBe(401);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
