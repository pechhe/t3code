import { expect, it } from "@effect/vitest";
import {
  type AgentTaskBinding,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings as Settings,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Context from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as Handlers from "./handlers.ts";
import { BoundedBrowserToolkit } from "./tools.ts";
import * as BrowserLogins from "../../../secrets/BrowserLogins.ts";

const threadId = ThreadId.make("reviewer-thread");
const projectId = ProjectId.make("project");
const reviewerScope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    subagent: true,
  },
  client: undefined,
  requestNamespace: "test",
  endpointKey: "bounded-browser",
  agentRole: "reviewer",
  toolProfile: "source-reader",
  boundedBrowser: true,
};

const request = {
  requestId: "seeded-defect",
  tabId: PreviewTabId.make("tab"),
  engine: "jev" as const,
  goal: "Capture the pricing card",
  capture: { target: { role: "region", name: "Pricing" } },
  checks: [{ id: "image", kind: "artifact" as const }],
};

/**
 * A pinned reviewer granted bounded tasks: the service and broker record what reached them,
 * and the project's browsing setting and the thread's run can change between calls.
 */
const harness = Effect.gen(function* () {
  const state = { browsing: true, liveRun: true };
  const seen = {
    runs: [] as Array<Context.McpThreadInvocationScope>,
    authorizations: [] as Array<boolean>,
    cancels: 0,
    invokes: [] as Array<{ operation: string; owner: string }>,
    closes: 0,
  };
  const settings = (): Settings => ({
    ...DEFAULT_SERVER_SETTINGS,
    enableAgentBrowserAccess: state.browsing,
    agentBrowserBackends: { enabled: ["integrated"], default: "integrated" },
  });
  const deps = Layer.mergeAll(
    Layer.succeed(Context.McpInvocationContext, reviewerScope),
    Layer.mock(BrowserLogins.BrowserLogins)({
      keysFor: (url) =>
        Effect.succeed(
          BrowserLogins.originOf(url) === "https://site.test" ? ["BROWSER_LOGIN_SITE"] : [],
        ),
    }),
    Layer.mock(BrowserTaskService.BrowserTaskService)({
      run: ({ scope, authorize }) =>
        Effect.gen(function* () {
          seen.runs.push(scope);
          // The service rechecks before each dispatch; record two dispatches across a change.
          seen.authorizations.push(Exit.isSuccess(yield* Effect.exit(authorize)));
          state.browsing = false;
          seen.authorizations.push(Exit.isSuccess(yield* Effect.exit(authorize)));
          return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: "stop" });
        }),
      cancel: () =>
        Effect.sync(() => {
          seen.cancels += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: "none" })),
          ),
        ),
    }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: (input) =>
        Effect.sync(() => {
          seen.invokes.push({
            operation: input.operation,
            owner: Context.browserOwnerKey(input.scope),
          });
          return {
            available: true,
            visible: false,
            tabId: "tab",
            url: (input.input as { readonly url?: string } | undefined)?.url ?? null,
            title: null,
            loading: false,
          } as never;
        }),
      close: ({ tabId }) =>
        Effect.suspend(() => {
          seen.closes += 1;
          return tabId === "gone"
            ? Effect.fail({ _tag: "PreviewAutomationTabNotFoundError", tabId } as never)
            : Effect.void;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.sync(() => ({
          ...liveThreadShell(threadId, state.liveRun ? {} : { activeRunId: null }),
          projectId,
          lineage: {
            rootThreadId: threadId,
            parentThreadId: threadId,
            relationshipToParent: "subagent",
          },
          agentTask: {
            role: "reviewer",
            toolProfile: "source-reader",
            sourceAccess: "read-only",
            browserTasks: true,
          } as AgentTaskBinding,
        })),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(settings),
    }),
  );
  const toolkit = yield* BoundedBrowserToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(deps))),
  );
  const handle = (name: keyof typeof BoundedBrowserToolkit.tools, params: unknown) =>
    toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.exit);
  return { state, seen, handle };
});

it.effect(
  "lets a granted reviewer open its own tab and run a job that loses authority mid-run",
  () =>
    Effect.gen(function* () {
      const { seen, handle } = yield* harness;
      const opened = yield* handle("t3_browser_open", { url: "http://127.0.0.1:4173/" });
      expect(Exit.isSuccess(opened), String(Exit.isFailure(opened) ? opened.cause : "")).toBe(true);
      expect(seen.invokes[0]?.operation).toBe("open");
      const owner = seen.invokes[0]!.owner;
      expect(owner.endsWith("\u0000bounded")).toBe(true);

      yield* handle("t3_browser_task", request);
      expect(seen.runs).toHaveLength(1);
      expect(seen.runs[0]?.browserLane).toBe("bounded");
      expect(seen.runs[0]?.taskBrowser?.backend).toBe("integrated");
      // The first dispatch is authorised; after the project turns browsing off the next is not.
      expect(seen.authorizations).toEqual([true, false]);
    }),
);

it.effect("refuses effects once browsing is off, but still cancels and closes", () =>
  Effect.gen(function* () {
    const { state, seen, handle } = yield* harness;
    state.browsing = false;
    expect(Exit.isFailure(yield* handle("t3_browser_open", {}))).toBe(true);
    expect(Exit.isFailure(yield* handle("t3_browser_status", { tabId: "tab" }))).toBe(true);
    // Task failures are returned as results, so what matters is that nothing reached the service.
    yield* handle("t3_browser_task", request);
    expect(seen.invokes).toHaveLength(0);
    expect(seen.runs).toHaveLength(0);

    yield* handle("t3_browser_task_cancel", { requestId: "seeded-defect" });
    expect(seen.cancels).toBe(1);
    expect(Exit.isSuccess(yield* handle("t3_browser_close", { tabId: "tab" }))).toBe(true);
    expect(seen.closes).toBe(1);
    // Revocation closes bounded tabs itself, so closing one that is already gone succeeds.
    expect(Exit.isSuccess(yield* handle("t3_browser_close", { tabId: "gone" }))).toBe(true);
  }),
);

it.effect("refuses everything once the thread's run has ended", () =>
  Effect.gen(function* () {
    const { state, seen, handle } = yield* harness;
    state.liveRun = false;
    expect(Exit.isFailure(yield* handle("t3_browser_open", {}))).toBe(true);
    expect(Exit.isFailure(yield* handle("t3_browser_close", { tabId: "tab" }))).toBe(true);
    expect(seen.invokes).toHaveLength(0);
    expect(seen.closes).toBe(0);
  }),
);

it.effect("lists the saved login keys bound to the opened page's origin, and none elsewhere", () =>
  Effect.gen(function* () {
    const { handle } = yield* harness;
    const listed = (exit: Exit.Exit<ReadonlyArray<unknown>, unknown>) =>
      Exit.isSuccess(exit) ? JSON.stringify(exit.value) : String(exit.cause);
    const bound = yield* handle("t3_browser_open", { url: "https://site.test/login" });
    expect(listed(bound)).toContain('"logins":["BROWSER_LOGIN_SITE"]');
    const elsewhere = yield* handle("t3_browser_open", { url: "https://other.test/login" });
    expect(listed(elsewhere)).not.toContain("logins");
  }),
);
