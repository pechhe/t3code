// @effect-diagnostics nodeBuiltinImport:off - A real local page and Chromium exercise the page-tools boundary.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import { pinnedBrowser } from "../testUtils/pinnedBrowser.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PageTools from "./PageTools.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const registered = (name: string, frameId = "main") => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  annotations: { readOnly: true },
  frameId,
});

/** A CDP session that registers `tools` when WebMCP is enabled, as a page's replay does. */
const fakeSession = (options: {
  readonly tools?: ReadonlyArray<ReturnType<typeof registered>>;
  readonly respond?: (events: NodeEvents.EventEmitter, invocationId: string) => void;
}) => {
  const events = new NodeEvents.EventEmitter();
  let invocations = 0;
  const sent: Array<{ method: string; params?: object }> = [];
  const session = {
    on: (event: string, listener: (payload: never) => void) => events.on(event, listener as never),
    send: async (method: string, params?: object) => {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "WebMCP.enable") {
        if (options.tools)
          queueMicrotask(() => events.emit("WebMCP.toolsAdded", { tools: options.tools }));
        return {};
      }
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main", url: "http://localhost/page" } } };
      if (method === "WebMCP.invokeTool") {
        const invocationId = `call-${++invocations}`;
        queueMicrotask(() => options.respond?.(events, invocationId));
        return { invocationId };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { session, events, sent };
};
// A deadline in `performance.now()` terms: far off, or already past.
const later = Number.MAX_SAFE_INTEGER;
const now = 0;

it("lists the tools a page registers, and only the main frame's", async () => {
  const { session } = fakeSession({ tools: [registered("a"), registered("b", "child")] });
  const listing = await PageTools.listPageTools(session, { deadlineMs: later });
  expect(listing.tools.map((tool) => tool.name)).toEqual(["a"]);
  expect(listing.tools[0]).toMatchObject({
    description: "a tool",
    annotations: { readOnly: true },
  });
});

it("reports a page with no tools once the wait ends", async () => {
  const { session } = fakeSession({});
  const listing = await PageTools.listPageTools(session, {
    deadlineMs: later,
    waitMs: 20,
  });
  expect(listing.tools).toEqual([]);
  expect(listing.note).toContain("no tools");
});

it("clears a frame's tools when it navigates", async () => {
  const { session, events } = fakeSession({ tools: [registered("a")] });
  await PageTools.listPageTools(session, { deadlineMs: later });
  events.emit("Page.frameNavigated", { frame: { id: "main" } });
  const listing = await PageTools.listPageTools(session, {
    deadlineMs: later,
    waitMs: 20,
  });
  expect(listing.tools).toEqual([]);
});

it("returns the output of the invocation it started, even when the page answers at once", async () => {
  const { session, sent } = fakeSession({
    tools: [registered("echo")],
    respond: (events, invocationId) =>
      events.emit("WebMCP.toolResponded", { invocationId, status: "Completed", output: { ok: 1 } }),
  });
  const result = await PageTools.invokePageTool(
    session,
    { name: "echo", input: { x: 1 } },
    { deadlineMs: later },
  );
  expect(result).toEqual({ name: "echo", status: "Completed", output: { ok: 1 } });
  expect(sent.find((call) => call.method === "WebMCP.invokeTool")?.params).toMatchObject({
    frameId: "main",
    toolName: "echo",
    input: { x: 1 },
  });
});

it("names the registered tools when asked for one the page lacks", async () => {
  const { session } = fakeSession({ tools: [registered("echo")] });
  await expect(
    PageTools.invokePageTool(session, { name: "nope" }, { deadlineMs: later, waitMs: 20 }),
  ).rejects.toMatchObject({ message: expect.stringContaining("Registered: echo") });
});

it("times out a tool that never responds and fails one that errors", async () => {
  const hung = fakeSession({ tools: [registered("slow")] });
  await expect(
    PageTools.invokePageTool(hung.session, { name: "slow" }, { deadlineMs: now }),
  ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
  const failing = fakeSession({
    tools: [registered("bad")],
    respond: (events, invocationId) =>
      events.emit("WebMCP.toolResponded", { invocationId, status: "Error", errorText: "boom" }),
  });
  await expect(
    PageTools.invokePageTool(failing.session, { name: "bad" }, { deadlineMs: later }),
  ).rejects.toMatchObject({
    tag: "PreviewAutomationExecutionError",
    message: expect.stringContaining("boom"),
  });
});

it("caps output and tool lists, saying what it cut", () => {
  const big = PageTools.capPageToolsReply({
    name: "x",
    status: "Completed",
    output: "é".repeat(30_000),
  });
  expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(
    PageTools.MAX_PAGE_TOOLS_OUTPUT_BYTES,
  );
  expect(big).toMatchObject({ truncated: true, note: expect.stringContaining("cut") });
  const many = PageTools.capPageToolsReply({
    tools: Array.from({ length: 400 }, (_, index) => ({
      name: `tool-${index}`,
      description: "d".repeat(100),
    })),
  });
  expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(
    PageTools.MAX_PAGE_TOOLS_OUTPUT_BYTES,
  );
  expect(many).toMatchObject({ truncated: true, note: expect.stringContaining("tools left out") });
  const small = { tools: [{ name: "a" }] };
  expect(PageTools.capPageToolsReply(small)).toBe(small);
});

// The remaining case runs a real browser, so it runs only when T3's pinned shell resolved.
const browserPath = await pinnedBrowser();

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("page-tools"),
  requestNamespace: "page-tools",
  thread: {
    threadId: ThreadId.make("page-tools"),
    providerSessionId: "task-one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("project-page-tools"),
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
};

const page = `<title>Tools</title><script>
const text = (value) => ({ content: [{ type: "text", text: value }] });
const tools = {
  echo: { description: "Echo", annotations: { readOnlyHint: true }, execute: async (input) => text("hi " + input.who) },
  secret: { description: "Leak", execute: async () => text("the password is fixture-password-value") },
  big: { description: "Big", execute: async () => text("x".repeat(50000)) },
  hang: { description: "Hang", execute: () => new Promise(() => {}) },
};
for (const [name, tool] of Object.entries(tools))
  document.modelContext.registerTool({ name, inputSchema: { type: "object" }, ...tool });
</script>`;

it.live.skipIf(browserPath === null)(
  "lists and runs a real page's tools through the broker, redacting held logins and refusing a driven tab",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = NodeHttp.createServer((request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(request.url === "/plain" ? "<title>Plain</title>" : page);
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.closeAllConnections();
            server.close();
          }),
        );
        const port = (server.address() as NodeNet.AddressInfo).port;
        const origin = `http://127.0.0.1:${port}`;
        const dependencies = Layer.mergeAll(
          Broker.layer.pipe(Layer.provideMerge(Manager.layer)),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(scope.environmentId),
            getDescriptor: Effect.die("unused"),
          }),
          Layer.succeed(PreviewBrowser.PreviewBrowser, {
            executable: Effect.succeed(browserPath!),
            installed: Effect.succeedSome(browserPath!),
          }),
          Layer.mock(DesktopChannel.DesktopBrowserChannel)({
            available: false,
            loadFailure: () => undefined,
            attached: Stream.empty,
            detached: Stream.empty,
            isShown: () => false,
          }),
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-page-tools-" })),
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, PreviewAgentActivity.layer),
          ),
        );
        const runtime = ServerBrowser.layer.pipe(
          Layer.provideMerge(dependencies),
          Layer.provideMerge(
            ServerSettings.layerTest({
              projectSettingsOverrides: {
                [scope.managedProjectId!]: { agentBrowserLoopbackAllow: [`127.0.0.1:${port}`] },
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const browser = yield* ServerBrowser.ServerBrowser;
          const broker = yield* Broker.PreviewAutomationBroker;
          yield* Effect.yieldNow;
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { url: `${origin}/`, reuseExistingTab: false },
          });
          const tabId = PreviewTabId.make(opened.tabId!);
          const call = (
            operation: "pageToolList" | "pageToolInvoke",
            input: object,
            timeoutMs?: number,
          ) =>
            broker.invoke<Record<string, unknown>>({
              scope,
              tabId,
              operation,
              input,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            });

          const listing = yield* call("pageToolList", {});
          expect(
            (listing.tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
          ).toEqual(["big", "echo", "hang", "secret"]);
          expect(
            yield* call("pageToolInvoke", { name: "echo", input: { who: "you" } }),
          ).toMatchObject({
            status: "Completed",
            output: { content: [{ type: "text", text: "hi you" }] },
          });

          yield* browser.holdTaskLogin({
            threadId: scope.thread.threadId,
            tabId,
            agentSessionId: Broker.hostAssignmentKey(scope),
            key: "BROWSER_LOGIN_FIXTURE",
            value: "fixture-password-value",
            origins: [origin],
          });
          const leaked = yield* call("pageToolInvoke", { name: "secret", input: {} });
          expect(JSON.stringify(leaked)).not.toContain("fixture-password-value");

          const hung = yield* call("pageToolInvoke", { name: "hang", input: {} }, 1_500).pipe(
            Effect.flip,
          );
          expect(hung._tag).toBe("PreviewAutomationTimeoutError");

          // A navigation drops the old page's tools.
          yield* broker.invoke({
            scope,
            tabId,
            operation: "navigate",
            input: { url: `${origin}/plain` },
          });
          const none = yield* call("pageToolList", {}, 800);
          expect(none.tools).toEqual([]);

          // A tab a person drives may be read, but no page tool runs through it.
          const manager = yield* Manager.PreviewManager;
          const shared = {
            ...scope,
            managedBrowser: undefined,
            managedProjectId: undefined,
            taskBrowser: undefined,
          } as unknown as McpThreadInvocationScope;
          const mine = yield* manager.open({
            threadId: scope.thread.threadId,
            url: `http://localhost:${port}/`,
            runtime: "server",
          });
          const mineId = PreviewTabId.make(mine.tabId);
          yield* browser.attachViewer({
            threadId: scope.thread.threadId,
            tabId: mineId,
            canOperate: true,
            maxWidth: 1280,
            maxHeight: 800,
            quality: 70,
          });
          const read = yield* broker.invoke<{ tools: Array<{ name: string }> }>({
            scope: shared,
            tabId: mineId,
            operation: "pageToolList",
            input: {},
          });
          expect(read.tools.map((tool) => tool.name)).toContain("echo");
          const refused = yield* broker
            .invoke<void>({
              scope: shared,
              tabId: mineId,
              operation: "pageToolInvoke",
              input: { name: "echo", input: {} },
            })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ reason: "humanControl" });
        }).pipe(Effect.provide(runtime));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, PreviewAgentActivity.layer),
      ),
    ),
);
