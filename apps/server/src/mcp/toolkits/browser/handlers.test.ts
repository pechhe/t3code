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
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as BrowserLogins from "../../../secrets/BrowserLogins.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Context from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewManager } from "../../../preview/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Handlers from "./handlers.ts";
import { BrowserToolkit } from "./tools.ts";

const threadId = ThreadId.make("browser-thread");
const projectId = ProjectId.make("project");
const baseScope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "test",
  boundedBrowser: true,
};
const reviewerScope: Context.McpInvocationScope = {
  ...baseScope,
  endpointKey: "reader",
  agentRole: "reviewer",
  toolProfile: "source-reader",
};
const editorScope: Context.McpInvocationScope = { ...baseScope, endpointKey: "editor" };
const { boundedBrowser: _, ...unboundedScope } = baseScope;
const phiTaskScope: Context.McpInvocationScope = {
  ...unboundedScope,
  managedBrowser: true,
  taskBrowser: { backend: "phi", phiLane: "agents" },
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
 * A pinned reviewer granted bounded tasks, or an ordinary editor thread: the service and broker
 * record what reached them, and the project's browsing setting and the run can change between calls.
 */
// Tab ids stay unique across tests, as the server's do: the handlers remember tabs by id.
let opened = 0;
const harness = (as: "reviewer" | "editor" | "phiTask") =>
  Effect.gen(function* () {
    const state = { browsing: true, liveRun: true, tabs: 0 };
    const seen = {
      runs: [] as Array<Context.McpThreadInvocationScope>,
      authorizations: [] as Array<boolean>,
      cancels: 0,
      invokes: [] as Array<{ operation: string; owner: string; input: unknown; tabId?: string }>,
      closes: 0,
    };
    const settings = (): Settings => ({
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentBrowserAccess: state.browsing,
      agentBrowserBackends: { enabled: ["integrated", "phi"], default: "integrated" },
    });
    const deps = Layer.mergeAll(
      Layer.succeed(
        Context.McpInvocationContext,
        { reviewer: reviewerScope, editor: editorScope, phiTask: phiTaskScope }[as],
      ),
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
          Effect.suspend(() => {
            seen.invokes.push({
              operation: input.operation,
              owner: Context.browserOwnerKey(input.scope),
              input: input.input,
              ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
            });
            const fields = input.input as { readonly url?: string; readonly locator?: string };
            if (input.operation === "click" && fields.locator === "missing")
              return Effect.fail({
                _tag: "PreviewAutomationExecutionError",
                message: "No element matches missing.",
              } as never);
            const tabId =
              input.operation === "open"
                ? `tab-${(opened += 1)}`
                : (input.tabId ?? `current-${state.tabs}`);
            // Another session's open moves the current tab.
            if (input.operation === "status" && input.tabId === undefined) state.tabs += 1;
            return Effect.succeed({
              available: true,
              visible: false,
              tabId,
              url: fields.url ?? null,
              title: null,
              loading: false,
            } as never);
          }),
        list: (input) =>
          Effect.sync(() => {
            seen.invokes.push({
              operation: "list",
              owner: Context.browserOwnerKey(input.scope),
              input: {},
            });
            return { sessions: [], serverEpoch: "epoch", revision: 0, nextCursor: null } as never;
          }),
        close: ({ tabId }) =>
          Effect.suspend(() => {
            seen.closes += 1;
            return tabId === "gone"
              ? Effect.fail({ _tag: "PreviewAutomationTabNotFoundError", tabId } as never)
              : Effect.void;
          }),
      }),
      Layer.mock(PreviewManager)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.sync(() => ({
            ...liveThreadShell(threadId, state.liveRun ? {} : { activeRunId: null }),
            projectId,
            ...(as === "reviewer"
              ? {
                  lineage: {
                    rootThreadId: threadId,
                    parentThreadId: threadId,
                    relationshipToParent: "subagent" as const,
                  },
                  agentTask: {
                    role: "reviewer",
                    toolProfile: "source-reader",
                    sourceAccess: "read-only",
                    browserTasks: true,
                  } as AgentTaskBinding,
                }
              : {}),
          })),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(settings),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-handlers-test-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const toolkit = yield* BrowserToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(deps))),
    );
    const handle = (name: keyof typeof BrowserToolkit.tools, params: unknown) =>
      toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.exit);
    return { state, seen, handle };
  });

const json = (exit: Exit.Exit<ReadonlyArray<unknown>, unknown>) =>
  Exit.isSuccess(exit) ? JSON.stringify(exit.value) : String(exit.cause);

/** The tool's own result, from a call that succeeded. */
const resultOf = <A>(exit: Exit.Exit<ReadonlyArray<unknown>, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause));
  return (exit.value[0] as { readonly result: A }).result;
};

it.effect(
  "lets a granted reviewer open its own headless tab and run a job that loses authority mid-run",
  () =>
    Effect.gen(function* () {
      const { seen, handle } = yield* harness("reviewer");
      const opened = yield* handle("browser_open", { url: "http://127.0.0.1:4173/" });
      expect(Exit.isSuccess(opened), json(opened)).toBe(true);
      expect(seen.invokes[0]?.operation).toBe("open");
      expect(seen.invokes[0]!.owner.endsWith("\u0000bounded")).toBe(true);

      yield* handle("browser_task", request);
      expect(seen.runs).toHaveLength(1);
      expect(seen.runs[0]?.browserLane).toBe("bounded");
      expect(seen.runs[0]?.taskBrowser?.backend).toBe("integrated");
      // The first dispatch is authorised; after the project turns browsing off the next is not.
      expect(seen.authorizations).toEqual([true, false]);
    }),
);

it.effect("refuses effects once browsing is off, but still stops tasks and closes tabs", () =>
  Effect.gen(function* () {
    const { state, seen, handle } = yield* harness("reviewer");
    state.browsing = false;
    expect(Exit.isFailure(yield* handle("browser_open", {}))).toBe(true);
    expect(Exit.isFailure(yield* handle("browser_status", { tabId: "tab" }))).toBe(true);
    // Task failures are returned as results, so what matters is that nothing reached the service.
    yield* handle("browser_task", request);
    expect(seen.invokes).toHaveLength(0);
    expect(seen.runs).toHaveLength(0);

    yield* handle("browser_close", { requestId: "seeded-defect" });
    expect(seen.cancels).toBe(1);
    expect(Exit.isSuccess(yield* handle("browser_close", { tabId: "tab" }))).toBe(true);
    expect(seen.closes).toBe(1);
    // Revocation closes bounded tabs itself, so closing one that is already gone succeeds.
    expect(Exit.isSuccess(yield* handle("browser_close", { tabId: "gone" }))).toBe(true);
  }),
);

it.effect("refuses everything once the thread's run has ended", () =>
  Effect.gen(function* () {
    const { state, seen, handle } = yield* harness("reviewer");
    state.liveRun = false;
    expect(Exit.isFailure(yield* handle("browser_open", {}))).toBe(true);
    expect(Exit.isFailure(yield* handle("browser_close", { tabId: "tab" }))).toBe(true);
    expect(seen.invokes).toHaveLength(0);
    expect(seen.closes).toBe(0);
  }),
);

it.effect("lists the saved login keys bound to the opened page's origin, and none elsewhere", () =>
  Effect.gen(function* () {
    const { handle } = yield* harness("reviewer");
    const bound = yield* handle("browser_open", { url: "https://site.test/login" });
    expect(json(bound)).toContain('"logins":["BROWSER_LOGIN_SITE"]');
    const elsewhere = yield* handle("browser_open", { url: "https://other.test/login" });
    expect(json(elsewhere)).not.toContain("logins");
  }),
);

it.effect("keeps a reviewer's browser headless, its batches short and free of page code", () =>
  Effect.gen(function* () {
    const { seen, handle } = yield* harness("reviewer");
    expect(json(yield* handle("browser_open", { backend: "phi" }))).toContain("headless only");
    const click = { action: "click", locator: "role=button" };
    expect(
      json(
        yield* handle("browser_act", {
          tabId: "tab",
          steps: Array.from({ length: 11 }, () => click),
        }),
      ),
    ).toContain("at most 10 steps");
    expect(
      json(
        yield* handle("browser_act", {
          tabId: "tab",
          steps: [click, { action: "evaluate", expression: "document.title" }],
        }),
      ),
    ).toContain("nothing ran");
    expect(seen.invokes).toHaveLength(0);
  }),
);

it.effect("runs steps in order and stops at the first that fails, reporting what happened", () =>
  Effect.gen(function* () {
    const { seen, handle } = yield* harness("reviewer");
    const ran = yield* handle("browser_act", {
      tabId: "tab",
      steps: [
        { action: "navigate", url: "http://127.0.0.1:4173/form" },
        { action: "type", locator: "role=textbox", text: "hello" },
        { action: "click", locator: "missing" },
        { action: "click", locator: "role=button" },
      ],
    });
    const result = resultOf<{
      readonly completed: number;
      readonly failed?: {
        readonly step: number;
        readonly action: string;
        readonly message: string;
      };
    }>(ran);
    expect(result.completed).toBe(2);
    expect(result.failed).toMatchObject({ step: 2, action: "click" });
    // Each action is followed by a status read for the activity icon.
    const actions = () =>
      seen.invokes.map(({ operation }) => operation).filter((operation) => operation !== "status");
    expect(actions()).toEqual(["navigate", "type", "click"]);
    // A step's fields are checked against its action before anything runs for it.
    const strict = yield* handle("browser_act", {
      tabId: "tab",
      steps: [{ action: "press", key: "Enter", text: "stray" }],
    });
    expect(resultOf(strict)).toMatchObject({ completed: 0, failed: { step: 0 } });
    expect(actions()).toHaveLength(3);
  }),
);

it.effect("pins a batch without a tabId to the tab that was current when it started", () =>
  Effect.gen(function* () {
    const { seen, handle } = yield* harness("editor");
    const ran = resultOf<{ readonly tabId: string }>(
      yield* handle("browser_act", {
        steps: [
          { action: "navigate", url: "http://127.0.0.1:4173/" },
          { action: "click", locator: "role=button" },
        ],
      }),
    );
    const targets = seen.invokes
      .filter(({ operation }) => operation === "navigate" || operation === "click")
      .map((invoke) => invoke.tabId);
    expect(targets).toEqual([ran.tabId, ran.tabId]);
  }),
);

it.effect("sends an untargeted batch to the tab the editor opened last, on its lane", () =>
  Effect.gen(function* () {
    const { seen, handle } = yield* harness("editor");
    yield* handle("browser_open", { backend: "phi", phiLane: "shadow" });
    const headless = resultOf<{ readonly tabId: string }>(yield* handle("browser_open", {}));
    yield* handle("browser_act", { steps: [{ action: "scroll", deltaY: 200 }] });
    const scroll = seen.invokes.find(({ operation }) => operation === "scroll")!;
    expect(scroll.tabId).toBe(headless.tabId);
    expect(scroll.owner.endsWith("\u0000bounded")).toBe(true);
    // Listing the panel's tabs is not about the last-opened tab.
    const listed = yield* handle("browser_status", { list: true });
    expect(Exit.isSuccess(listed), json(listed)).toBe(true);
    const list = seen.invokes.find(({ operation }) => operation === "list")!;
    expect(list.owner.endsWith("\u0000bounded")).toBe(false);
  }),
);

it.effect("keeps a Phi browser task on the lane it was delegated", () =>
  Effect.gen(function* () {
    const { seen, handle } = yield* harness("phiTask");
    expect(json(yield* handle("browser_open", { backend: "phi", phiLane: "shadow" }))).toContain(
      "Phi lane is agents",
    );
    expect(json(yield* handle("browser_open", { persona: "planner" }))).toContain(
      "persona applies only to managed headless tabs, not Phi.",
    );
    expect(seen.invokes).toHaveLength(0);
  }),
);

it.effect(
  "gives an editor headless tabs by default and Phi only when asked, each on its lane",
  () =>
    Effect.gen(function* () {
      const { seen, handle } = yield* harness("editor");
      const headless = resultOf<{ readonly tabId: string }>(yield* handle("browser_open", {}));
      expect(json(yield* handle("browser_open", { backend: "phi", persona: "none" }))).toContain(
        "persona applies only to managed headless tabs, not Phi.",
      );
      const phi = resultOf<{ readonly tabId: string }>(
        yield* handle("browser_open", { backend: "phi", phiLane: "shadow" }),
      );
      expect(seen.invokes[0]!.owner.endsWith("\u0000bounded")).toBe(true);
      expect(seen.invokes[1]!.owner.endsWith("\u0000bounded")).toBe(false);
      expect(seen.invokes[1]!.input).toMatchObject({
        backend: "phi",
        phiLane: "shadow",
        open: false,
      });
      expect(seen.invokes[1]!.input).not.toHaveProperty("persona");

      yield* handle("browser_act", {
        tabId: headless.tabId,
        steps: [{ action: "scroll", deltaY: 200 }],
      });
      yield* handle("browser_act", {
        tabId: phi.tabId,
        steps: [{ action: "scroll", deltaY: 200 }],
      });
      const [bounded, shared] = seen.invokes.filter(({ operation }) => operation === "scroll");
      expect(bounded!.owner.endsWith("\u0000bounded")).toBe(true);
      expect(shared!.owner.endsWith("\u0000bounded")).toBe(false);
      // Page code is refused on the headless tab before it runs, and runs on the shared one.
      expect(
        json(
          yield* handle("browser_act", {
            tabId: headless.tabId,
            steps: [{ action: "evaluate", expression: "1" }],
          }),
        ),
      ).toContain("nothing ran");
      expect(
        json(
          yield* handle("browser_act", {
            tabId: phi.tabId,
            steps: [{ action: "evaluate", expression: "1" }],
          }),
        ),
      ).toContain('"completed":1');
    }),
);
