import * as ContextPreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off - Real local HTTP fixtures and Chromium verify the managed browser service boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  PreviewTabId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationRecordingArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("managed-integration"),
  requestNamespace: "managed-integration",
  thread: {
    threadId: ThreadId.make("managed-integration"),
    providerSessionId: "task-one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("project-managed-integration"),
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
};
const dependencies = Layer.mergeAll(
  Broker.layer.pipe(Layer.provideMerge(Manager.layer)),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(chromium.executablePath()),
    installed: Effect.succeedSome(chromium.executablePath()),
  }),
  Layer.mock(DesktopChannel.DesktopBrowserChannel)({
    available: false,
    attached: Stream.empty,
    detached: Stream.empty,
    isShown: () => false,
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-integrated-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.each(["access", "backend", "allow-list"] as const)(
  "isolates ownership and storage, captures evidence and closes contexts on %s revocation",
  (revocation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/dev/login?next=%2F") {
            response.writeHead(302, {
              location: "/",
              "set-cookie": "preview-auth=owner; Path=/; HttpOnly",
            });
            response.end();
            return;
          }
          if (request.url === "/" && !request.headers.cookie?.includes("preview-auth=owner")) {
            response.writeHead(401);
            response.end("Sign in first");
            return;
          }
          if (request.url === "/bad-status") {
            response.writeHead(503);
            response.end("unavailable");
            return;
          }
          if (request.url === "/failed-request") {
            response.destroy();
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(
            `<title>Managed fixture</title><button onclick="document.cookie='task=one';localStorage.setItem('task','one');document.querySelector('output').textContent='saved'">Save</button><output>${request.headers.cookie ?? "no cookies"}</output><p id="storage"></p><p id="network"></p><p id="appearance"></p><script>const media=matchMedia('(prefers-color-scheme: dark)');const appearance=()=>document.querySelector('#appearance').textContent=media.matches?'dark mode':'light mode';appearance();media.addEventListener('change',appearance);document.querySelector('#storage').textContent=localStorage.getItem('task')??'no storage';${request.url === "/clean" ? "" : "console.error('fixture console error');Promise.allSettled([fetch('/bad-status'),fetch('/failed-request')]).then(()=>document.querySelector('#network').textContent='network settled');"}</script>`,
          );
        });
        yield* Effect.promise(async () => {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject);
              resolve();
            });
          });
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
        );
        const port = (server.address() as NodeNet.AddressInfo).port;
        const settingsLayer = Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            const base = yield* ServerSettings.ServerSettingsService;
            const changes = yield* PubSub.unbounded<import("@t3tools/contracts").ServerSettings>();
            return {
              ...base,
              updateSettings: (patch: import("@t3tools/contracts").ServerSettingsPatch) =>
                base
                  .updateSettings(patch)
                  .pipe(Effect.tap((settings) => PubSub.publish(changes, settings))),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
            };
          }),
        ).pipe(
          Layer.provide(
            ServerSettings.layerTest({ agentBrowserLoopbackAllow: [`127.0.0.1:${port}`] }),
          ),
        );
        const runtime = ServerBrowser.layer.pipe(
          Layer.provideMerge(dependencies),
          Layer.provideMerge(settingsLayer),
        );
        yield* Effect.gen(function* () {
          yield* ServerBrowser.ServerBrowser;
          const broker = yield* Broker.PreviewAutomationBroker;
          const manager = yield* Manager.PreviewManager;
          yield* Effect.yieldNow;
          const { managedBrowser: _managed, ...ordinary } = scope;
          const ordinaryScope = {
            ...ordinary,
            thread: { ...scope.thread, providerSessionId: "ordinary-profile" },
          };
          const ordinaryTab = yield* broker.invoke<PreviewAutomationStatus>({
            scope: ordinaryScope,
            operation: "open",
            input: { profileId: "default", url: `http://127.0.0.1:${port}/clean` },
          });
          yield* broker.invoke({
            scope: ordinaryScope,
            tabId: PreviewTabId.make(ordinaryTab.tabId!),
            operation: "click",
            input: { selector: "button" },
          });
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { url: `http://127.0.0.1:${port}/dev/login?next=%2F` },
          });
          const tabId = PreviewTabId.make(opened.tabId!);
          const invoke = <A>(
            operation: Parameters<typeof broker.invoke>[0]["operation"],
            input: unknown = {},
          ) => broker.invoke<A>({ scope, tabId, operation, input });
          yield* invoke("waitFor", { text: "network settled" });
          const snapshot = yield* invoke<PreviewAutomationSnapshot>("snapshot");
          expect(snapshot.url).toBe(`http://127.0.0.1:${port}/`);
          expect(snapshot.visibleText).toContain("preview-auth=owner");
          expect(snapshot.visibleText).not.toContain("task=one");
          expect(snapshot.visibleText).toContain("no storage");
          expect(snapshot.networkEntries).toContainEqual(
            expect.objectContaining({
              url: `http://127.0.0.1:${port}/bad-status`,
              status: 503,
              failed: true,
            }),
          );
          expect(snapshot.networkEntries).toContainEqual(
            expect.objectContaining({
              url: `http://127.0.0.1:${port}/failed-request`,
              status: null,
              failed: true,
            }),
          );
          expect(snapshot.networkEntries).toContainEqual(
            expect.objectContaining({ status: 200, failed: false }),
          );
          expect(snapshot.interactiveElements.length).toBeGreaterThan(0);
          expect(snapshot.accessibilityTree).toBeTruthy();
          expect(snapshot.captureStatus).toEqual({
            console: true,
            network: true,
            actionTimeline: true,
          });
          expect(snapshot.consoleEntries).toContainEqual(
            expect.objectContaining({ level: "error", text: "fixture console error" }),
          );
          expect(snapshot.screenshot!.data.length).toBeGreaterThan(0);
          yield* invoke("click", { selector: "button" });
          yield* invoke("waitFor", { text: "saved" });
          yield* invoke("resize", { mode: "freeform", width: 375, height: 667 });
          const phone = yield* invoke<PreviewAutomationSnapshot>("snapshot");
          expect(phone.screenshot!.width).toBe(750);
          yield* invoke("setColorScheme", { colorScheme: "dark" });
          yield* invoke("waitFor", { text: "dark mode" });
          yield* invoke("recordingStart");
          yield* invoke("snapshot");
          const recording = yield* invoke<PreviewAutomationRecordingArtifact>("recordingStop");
          const recordingFs = yield* FileSystem.FileSystem;
          expect(yield* recordingFs.exists(recording.path)).toBe(true);
          for (let attempt = 0; attempt < 2; attempt++) {
            const refused = yield* invoke<PreviewAutomationStatus>("navigate", {
              url: `http://localhost:${port}/blocked`,
            }).pipe(Effect.flip);
            expect(refused.message).toContain(`blocked address localhost:${port}`);
          }
          yield* invoke("navigate", { url: `http://127.0.0.1:${port}/` });
          const second: McpThreadInvocationScope = {
            ...scope,
            thread: { ...scope.thread, providerSessionId: "task-two" },
          };
          const other = yield* broker.invoke<PreviewAutomationStatus>({
            scope: second,
            operation: "open",
            input: { url: `http://127.0.0.1:${port}/clean` },
          });
          const secondSnapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
            scope: second,
            tabId: PreviewTabId.make(other.tabId!),
            operation: "snapshot",
            input: {},
          });
          expect(secondSnapshot.visibleText).toContain("no cookies");
          expect(secondSnapshot.visibleText).toContain("no storage");
          expect(secondSnapshot.consoleEntries.filter((entry) => entry.level === "error")).toEqual(
            [],
          );
          expect(secondSnapshot.networkEntries.filter((entry) => entry.failed)).toEqual([]);
          expect(secondSnapshot.networkEntries.length).toBeGreaterThan(0);
          for (const operation of ["status", "snapshot", "click", "close"] as const) {
            const failure = yield* broker
              .invoke<PreviewAutomationStatus>({ scope: second, tabId, operation, input: {} })
              .pipe(Effect.flip);
            expect(failure._tag).toBe("PreviewAutomationBackendError");
          }
          expect((yield* broker.list({ scope: second })).sessions.map((tab) => tab.tabId)).toEqual([
            other.tabId,
          ]);
          expect(
            (yield* broker
              .invoke<PreviewAutomationStatus>({
                scope,
                operation: "open",
                input: { profileId: "default" },
              })
              .pipe(Effect.flip))._tag,
          ).toBe("PreviewAutomationBackendError");
          yield* invoke("recordingStart");
          const events = yield* manager.subscribeEvents;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings(
            revocation === "access"
              ? { enableAgentBrowserAccess: false }
              : revocation === "backend"
                ? { agentBrowserBackends: { enabled: ["phi"], default: "phi" } }
                : { agentBrowserLoopbackAllow: [] },
          );
          const closed = yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "closed"),
            Stream.take(2),
            Stream.runCollect,
          );
          expect(closed).toHaveLength(2);
          expect(
            (yield* manager.list({ threadId: scope.thread.threadId })).sessions.map(
              (tab) => tab.tabId,
            ),
          ).toEqual([ordinaryTab.tabId]);
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const artifacts = yield* fs
            .readDirectory(config.browserArtifactsDir)
            .pipe(Effect.orElseSucceed(() => []));
          expect(artifacts).toEqual([]);
        }).pipe(Effect.provide(runtime));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer).pipe(
          Layer.provideMerge(Layer.mergeAll(ContextPreviewAgentActivity.layer)),
        ),
      ),
    ),
);

it.live(
  "closes the tab, context and recording of an integrated task whose credential expires",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = NodeHttp.createServer((_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end("<title>Expiry fixture</title><p>still here</p>");
        });
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.listen(0, "127.0.0.1", () => resolve());
            }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.closeAllConnections();
            server.close();
          }),
        );
        const port = (server.address() as NodeNet.AddressInfo).port;
        // Keep the real implementations; remember what the task opened so its closing can be observed.
        const managedContexts: Array<BrowserContext> = [];
        const encoderPages: Array<Page> = [];
        const managedContext = ServerBrowserContexts.prototype.managedContext;
        const scratchPage = ServerBrowserContexts.prototype.scratchPage;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            vi.spyOn(ServerBrowserContexts.prototype, "managedContext").mockImplementation(
              async function (this: ServerBrowserContexts, options) {
                const context = await managedContext.call(this, options);
                managedContexts.push(context);
                return context;
              },
            );
            vi.spyOn(ServerBrowserContexts.prototype, "scratchPage").mockImplementation(
              async function (this: ServerBrowserContexts) {
                const page = await scratchPage.call(this);
                encoderPages.push(page);
                return page;
              },
            );
          }),
          () => Effect.sync(() => vi.restoreAllMocks()),
        );
        const runtime = ServerBrowser.layer.pipe(
          Layer.provideMerge(dependencies),
          Layer.provideMerge(
            ServerSettings.layerTest({ agentBrowserLoopbackAllow: [`127.0.0.1:${port}`] }),
          ),
        );
        yield* Effect.gen(function* () {
          yield* ServerBrowser.ServerBrowser;
          const broker = yield* Broker.PreviewAutomationBroker;
          const manager = yield* Manager.PreviewManager;
          yield* Effect.yieldNow;
          let timestamp = 1000;
          const registry = yield* McpSessionRegistry.__testing
            .make({ now: () => timestamp, livenessWindowMs: 100 })
            .pipe(
              Effect.provideService(
                HttpServer.HttpServer,
                HttpServer.HttpServer.of({
                  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
                }),
              ),
            );
          const issued = yield* registry.issue({
            threadId: ThreadId.make("expiry-thread"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            managedBrowser: true,
          });
          const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
          const issuedScope = yield* registry.resolve(token);
          expect(issuedScope?.managedBrowser).toBe(true);
          // The provider session manager adds the project once it has resolved it.
          const taskScope = {
            ...issuedScope!,
            managedProjectId: ProjectId.make("project-managed-integration"),
          };
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope: taskScope,
            operation: "open",
            input: { url: `http://127.0.0.1:${port}/` },
          });
          const tabId = PreviewTabId.make(opened.tabId!);
          yield* broker.invoke({ scope: taskScope, tabId, operation: "recordingStart", input: {} });
          expect(
            (yield* manager.list({ threadId: taskScope.thread.threadId })).sessions.map(
              (tab) => tab.tabId,
            ),
          ).toEqual([opened.tabId]);
          const events = yield* manager.subscribeEvents;
          // The credential's session stops showing signs of life.
          timestamp += 101;
          expect(yield* registry.resolve(token)).toBeUndefined();
          expect(managedContexts).toHaveLength(1);
          expect(encoderPages).toHaveLength(1);
          const [context] = managedContexts;
          const [encoder] = encoderPages;
          const closed = yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "closed"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(closed).toHaveLength(1);
          expect((yield* manager.list({ threadId: taskScope.thread.threadId })).sessions).toEqual(
            [],
          );
          // The task's own browser and its recording encoder must really be gone, not just announced.
          yield* Effect.promise(() =>
            vi.waitFor(
              () => {
                expect(context!.browser()?.isConnected() ?? false).toBe(false);
                expect(encoder!.isClosed()).toBe(true);
              },
              { timeout: 10_000, interval: 50 },
            ),
          );
        }).pipe(Effect.provide(runtime));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, ContextPreviewAgentActivity.layer),
      ),
    ),
);
