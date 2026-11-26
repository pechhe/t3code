import { DecisionToolkit } from "./toolkits/decisions/tools.ts";
import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import * as BrowserTaskService from "../browserTasks/BrowserTaskService.ts";
import * as ContextServerSettingsService from "../serverSettings.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import { MANAGED_BROWSER_TOOL_NAMES } from "./toolkits/browser/toolNames.ts";
import { BrowserSnapshotToolkit, BrowserToolkit } from "./toolkits/browser/tools.ts";
import * as BrowserLogins from "../secrets/BrowserLogins.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { DeviceStandardToolkit } from "./toolkits/device/tools.ts";
import { BrowserRunSnapshotToolkit, BrowserRunToolkit } from "./toolkits/browserRun/tools.ts";
import * as BrowserRuns from "../browserRuns/BrowserRuns.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";

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
const tokens = {
  managed: "managedTokenWithoutDots",
  general: "generalTokenWithoutDots",
  bounded: "boundedTokenWithoutDots",
  device: "deviceTokenWithoutDots",
  run: "browserRunTokenWithoutDots",
  owner: "ownerClientTokenWithoutDots",
};
const registry = Layer.mock(McpSessionRegistry.McpSessionRegistry)({
  resolve: (presented) =>
    Effect.succeed(
      presented === tokens.managed
        ? scopeFor(true)
        : presented === tokens.general
          ? scopeFor(false)
          : presented === tokens.bounded
            ? { ...scopeFor(true), boundedBrowser: true as const }
            : presented === tokens.device
              ? { ...scopeFor(true), capabilities: new Set(["preview", "device"] as const) }
              : presented === tokens.run
                ? {
                    ...scopeFor(false),
                    capabilities: new Set(["preview"] as const),
                    boundedBrowser: true as const,
                    browserRunCredential: true as const,
                  }
                : presented === tokens.owner
                  ? {
                      ...scopeFor(false),
                      // The registry types its scopes as thread scopes; a client's has none.
                      ...({ thread: undefined } as unknown as Pick<
                        ReturnType<typeof scopeFor>,
                        "thread"
                      >),
                      capabilities: new Set(["preview"] as const),
                      client: {
                        sessionId: "owner-session",
                        label: "t3 browser run cli",
                        access: "full-access" as const,
                      },
                    }
                  : undefined,
    ),
});
const services = Layer.mergeAll(
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(PreviewManager)({}),
  PreviewAutomationBroker.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-browser-test-" }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`;
const accept = "application/json, text/event-stream";

/** The first JSON-RPC message in a response, whether the server sent JSON or an event stream. */
const message = (text: string) =>
  decodeJson(
    text.trimStart().startsWith("{")
      ? text
      : (text.split("\n").find((line) => line.startsWith("data:")) ?? "data:{}").slice(5),
  ) as {
    readonly result?: {
      readonly tools?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
    };
  };

const openSession = (path: string, token: string) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    );
    const opened = yield* http.post(path, {
      headers: { accept },
      body: HttpBody.text(initialize, "application/json"),
    });
    const sessionId = opened.headers["mcp-session-id"]!;
    yield* http.post(path, {
      headers: { accept, "mcp-session-id": sessionId },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
        "application/json",
      ),
    });
    return (body: string) =>
      http
        .post(path, {
          headers: { accept, "mcp-session-id": sessionId },
          body: HttpBody.text(body, "application/json"),
        })
        .pipe(Effect.flatMap((response) => response.text));
  });

const listTools = (path: string, token: string) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    );
    const opened = yield* http.post(path, {
      headers: { accept },
      body: HttpBody.text(initialize, "application/json"),
    });
    if (opened.status !== 200)
      return { status: opened.status, names: [] as Array<string>, descriptions: new Map() };
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
    const tools = body.result?.tools ?? [];
    return {
      status: listed.status,
      names: tools.map((tool) => tool.name),
      descriptions: new Map(tools.map((tool) => [tool.name, tool.description ?? ""])),
    };
  });

it("lists exactly the managed browser tools the adapters pre-approve", () => {
  const toolkit = [
    ...Object.keys(DecisionToolkit.tools),
    ...Object.keys(BrowserToolkit.tools).filter((name) => name !== "browser_task"),
    ...Object.keys(BrowserSnapshotToolkit.tools),
    ...Object.keys(DeviceStandardToolkit.tools),
    "device_screenshot",
  ];
  expect([...toolkit].sort()).toEqual([...MANAGED_BROWSER_TOOL_NAMES].sort());
  // Nothing that shells out or reaches T3 state is among them; page code is refused per step.
  for (const forbidden of ["preview_evaluate", "preview_upload", "delegate_task", "t3_thread_send"])
    expect(MANAGED_BROWSER_TOOL_NAMES).not.toContain(forbidden);
});

it.effect("serves a managed browser task only the narrow endpoint, and only its own token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Composed as the server composes them: the endpoints must not share one tool registry.
      const both = Layer.mergeAll(
        McpHttpServer.layerManagedBrowserToolkit.pipe(
          Layer.provide(Layer.mock(DecisionRouter.DecisionRouter)({})),
          Layer.provide(Layer.mock(BrowserTaskService.BrowserTaskService)({})),
          Layer.provide(Layer.mock(BrowserLogins.BrowserLogins)({})),
          Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        ),
        McpHttpServer.layerBrowserRunToolkit.pipe(
          Layer.provide(Layer.mock(BrowserRuns.BrowserRuns)({})),
          Layer.provide(Layer.mock(ServerBrowser.ServerBrowser)({})),
          Layer.provide(Layer.mock(BrowserLogins.BrowserLogins)({})),
          Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        ),
        McpHttpServer.layerMcpTransport(McpHttpServer.layerPreviewToolkit),
      ).pipe(Layer.provide(registry), Layer.provide(services));
      yield* HttpRouter.serve(both, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );

      const deviceTools = MANAGED_BROWSER_TOOL_NAMES.filter((name) => name.startsWith("device_"));
      const withoutDevices = MANAGED_BROWSER_TOOL_NAMES.filter(
        (name) => !name.startsWith("device_"),
      );
      const withDevices = yield* listTools("/mcp/browser", tokens.device);
      expect(withDevices.status).toBe(200);
      expect([...withDevices.names].sort()).toEqual([...MANAGED_BROWSER_TOOL_NAMES].sort());

      // Without agent device access the device tools are not listed at all.
      const mine = yield* listTools("/mcp/browser", tokens.managed);
      expect(mine.status).toBe(200);
      expect([...mine.names].sort()).toEqual([...withoutDevices].sort());
      expect(deviceTools).toHaveLength(4);

      // Outside the session endpoints, `/mcp` keeps upstream's preview tools.
      const general = yield* listTools("/mcp", tokens.general);
      expect(general.status).toBe(200);
      expect(general.names).toContain("preview_evaluate");

      // A general credential cannot reach the managed endpoint, nor a managed one the general.
      expect((yield* listTools("/mcp/browser", tokens.general)).status).toBe(401);
      expect((yield* listTools("/mcp", tokens.managed)).status).toBe(401);
      expect((yield* listTools("/mcp/browser", "unknownTokenWithoutDots")).status).toBe(401);

      // A browser-run credential reaches only its own endpoint, and no other credential reaches it.
      const runs = yield* listTools("/mcp/browser-run", tokens.run);
      expect(runs.status).toBe(200);
      expect([...runs.names].sort()).toEqual(
        [
          ...Object.keys(BrowserRunToolkit.tools),
          ...Object.keys(BrowserRunSnapshotToolkit.tools),
        ].sort(),
      );
      // `t3 browser run` outside a thread signs in as a client with no thread and lists the same set.
      const owner = yield* listTools("/mcp/browser-run", tokens.owner);
      expect(owner.status).toBe(200);
      expect([...owner.names].sort()).toEqual([...runs.names].sort());
      const ownerCall = yield* openSession("/mcp/browser-run", tokens.owner);
      const opened = yield* ownerCall(
        `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"preview_open","arguments":{}}}`,
      );
      expect(opened).not.toMatch(/not found|Unknown tool/i);
      expect((yield* listTools("/mcp", tokens.run)).status).toBe(401);
      expect((yield* listTools("/mcp/browser", tokens.run)).status).toBe(401);
      for (const other of [tokens.general, tokens.managed, tokens.bounded])
        expect((yield* listTools("/mcp/browser-run", other)).status).toBe(401);

      // A browser task granted bounded tasks lists them beside its own browser, and nothing else.
      const bounded = yield* listTools("/mcp/browser", tokens.bounded);
      expect([...bounded.names].sort()).toEqual([...withoutDevices, "browser_task"].sort());
      expect(mine.names).not.toContain("browser_task");
      expect(bounded.descriptions.get("browser_open")).toContain(
        McpToolAccessTestkit.HEADLESS_OPEN,
      );

      // A tool listed earlier is refused when called without the grant: listing grants nothing.
      const call = yield* openSession("/mcp/browser", tokens.managed);
      const refused = yield* call(
        `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_task","arguments":{}}}`,
      );
      expect(refused).not.toContain('"tabId"');
      expect(refused).toMatch(/not available to this session|not found|Unknown tool/i);
    }),
  ).pipe(
    Effect.provide(
      NodeHttpServer.layerTest.pipe(
        Layer.provideMerge(Layer.mergeAll(ContextServerSettingsService.layerTest())),
      ),
    ),
  ),
);
