import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off - Real local HTTP fixtures and Chromium verify the managed browser service boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  PreviewTabId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { pinnedBrowser } from "../testUtils/pinnedBrowser.ts";

// This suite launches a real browser, so it runs only when T3's pinned shell resolved; a host
// that cannot install it skips rather than launching Playwright's own copy.
const browserPath = await pinnedBrowser();

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
  taskBrowser: { backend: "integrated", persona: "planner" },
  browserLane: "run",
  browserRunId: "sign-in-run",
  browserBackends: { enabled: ["integrated"], default: "integrated" },
};
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-integrated-" })),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, PreviewAgentActivity.layer),
  ),
);

it.live.skipIf(browserPath === null)(
  "signs in on open and navigate, retries failed sign-ins, and shares the successful session within a run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signIns: Array<string | null> = [];
        const failures = [401, 404, 500, 503];
        const server = NodeHttp.createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (url.pathname === "/dev/agent-login") {
            const persona = url.searchParams.get("as");
            signIns.push(persona);
            const status = failures.shift();
            if (status !== undefined) {
              response.writeHead(status).end();
              return;
            }
            response
              .writeHead(303, {
                location: url.searchParams.get("next") ?? "/",
                "set-cookie": `agent=${persona}; Path=/; HttpOnly`,
              })
              .end();
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(
            `<title>Sign-in fixture</title><output>${request.headers.cookie ?? "no cookies"}</output>`,
          );
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
        const runtime = ServerBrowser.layer.pipe(
          Layer.provideMerge(dependencies),
          Layer.provideMerge(
            ServerSettings.layerTest({
              projectSettingsOverrides: {
                [scope.managedProjectId!]: {
                  agentBrowserLoopbackAllow: [`127.0.0.1:${port}`, `localhost:${port}`],
                  agentBrowserSignIn: {
                    path: "/dev/agent-login?as={persona}&next={next}",
                    defaultPersona: "admin",
                  },
                },
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const broker = yield* Broker.PreviewAutomationBroker;
          yield* Effect.yieldNow;
          const open = (taskScope: McpThreadInvocationScope, url?: string, persona?: string) =>
            broker.invoke<PreviewAutomationStatus>({
              scope: taskScope,
              operation: "open",
              input: {
                url,
                ...(persona === undefined ? {} : { persona }),
                reuseExistingTab: false,
              },
            });
          const text = (taskScope: McpThreadInvocationScope, tabId: PreviewTabId) =>
            broker
              .invoke<PreviewAutomationSnapshot>({
                scope: taskScope,
                tabId,
                operation: "snapshot",
                input: {},
              })
              .pipe(Effect.map((snapshot) => snapshot.visibleText));
          const blank = yield* open(scope);
          const tabId = PreviewTabId.make(blank.tabId!);
          const navigate = (url: string) =>
            broker.invoke<PreviewAutomationStatus>({
              scope,
              tabId,
              operation: "navigate",
              input: { url, readiness: "none" },
            });

          const openFailure = yield* open(scope, `${origin}/report`).pipe(Effect.flip);
          expect(openFailure.message).toContain("failed with HTTP 401.");
          for (const status of [404, 500, 503]) {
            const failed = yield* navigate(`${origin}/report`).pipe(Effect.flip);
            expect(failed.message).toContain(`failed with HTTP ${status}.`);
          }
          const loaded = yield* navigate(`${origin}/report?view=full#totals`);
          expect(loaded.url).toBe(`${origin}/report?view=full#totals`);

          const sibling = yield* open(scope, `${origin}/another`);
          expect(yield* text(scope, PreviewTabId.make(sibling.tabId!))).toContain("agent=planner");
          const conflict = yield* open(scope, `${origin}/another`, "colleague").pipe(Effect.flip);
          expect(conflict.message).toContain(`already signed into ${origin} as "planner"`);
          expect(signIns).toEqual(Array.from({ length: 5 }, () => "planner"));

          const secondOrigin = `http://localhost:${port}`;
          yield* navigate(`${secondOrigin}/another-origin`);
          expect(yield* text(scope, tabId)).toContain("agent=planner");
          expect(signIns).toHaveLength(6);

          const otherRun = { ...scope, browserRunId: "other-run" };
          const signedOut = yield* open(otherRun, `${origin}/`, "none");
          expect(yield* text(otherRun, PreviewTabId.make(signedOut.tabId!))).toContain(
            "no cookies",
          );
          const override = yield* open(otherRun, `${origin}/`, "colleague");
          expect(yield* text(otherRun, PreviewTabId.make(override.tabId!))).toContain(
            "agent=colleague",
          );
          const inherited = yield* open(otherRun, `${origin}/`);
          expect(yield* text(otherRun, PreviewTabId.make(inherited.tabId!))).toContain(
            "agent=colleague",
          );
          yield* open(otherRun, `${origin}/`, "colleague");
          const optedOut = yield* open(otherRun, `${origin}/`, "none");
          expect(yield* text(otherRun, PreviewTabId.make(optedOut.tabId!))).toContain(
            "agent=colleague",
          );
          expect(signIns.slice(6)).toEqual(["colleague"]);

          const explicitRun = { ...scope, browserRunId: "explicit-run" };
          yield* open(explicitRun, `${origin}/dev/agent-login?as=explicit&next=%2F`);
          const after = yield* open(explicitRun, `${origin}/report`);
          expect(yield* text(explicitRun, PreviewTabId.make(after.tabId!))).toContain(
            "agent=explicit",
          );
          const unknown = yield* open(explicitRun, `${origin}/`, "explicit").pipe(Effect.flip);
          expect(unknown.message).toContain(`already signed into ${origin} as an unknown persona`);
          expect(signIns.slice(7)).toEqual(["explicit"]);
        }).pipe(Effect.provide(runtime));
      }),
    ),
);
