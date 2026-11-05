import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
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
import * as Handlers from "./handlers.ts";
import { ManagedBrowserTaskToolkit } from "./tools.ts";

const threadId = ThreadId.make("task-thread");
const scope = (managedBrowser: boolean): Context.McpInvocationScope => ({
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
  taskBrowser: { backend: "integrated" },
  ...(managedBrowser ? { managedBrowser: true as const } : {}),
});

const input = {
  requestId: "one",
  tabId: PreviewTabId.make("tab"),
  engine: "jev" as const,
  goal: "Do it",
  checks: [{ id: "here", kind: "url" as const, includes: "/" }],
};

const call = (options: {
  readonly managedBrowser?: boolean;
  readonly toolProfile?: "phi" | "source-reader";
  readonly role?: "browser" | "reviewer";
  readonly enableAgentBrowserAccess?: boolean;
}) =>
  Effect.gen(function* () {
    let runs = 0;
    let authority: Exit.Exit<void, { readonly message: string }> | undefined;
    const deps = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, scope(options.managedBrowser ?? true)),
      Layer.mock(BrowserTaskService.BrowserTaskService)({
        run: ({ authorize }) =>
          Effect.gen(function* () {
            runs += 1;
            authority = yield* Effect.exit(authorize);
            return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: "stop" });
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            ...liveThreadShell(threadId),
            projectId: ProjectId.make("project"),
            agentTask: {
              toolProfile: options.toolProfile ?? "phi",
              role: options.role ?? "browser",
            },
          } as ReturnType<typeof liveThreadShell>),
      }),
      ServerSettings.layerTest({
        enableAgentBrowserAccess: options.enableAgentBrowserAccess ?? true,
      }),
    );
    const toolkit = yield* ManagedBrowserTaskToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layerTask).pipe(Layer.provide(deps)),
      ),
    );
    const result = yield* toolkit
      .handle("preview_task", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.exit);
    return { runs, authority, result };
  });

it.effect("reaches the task service only for a managed browser task, with live authority", () =>
  Effect.gen(function* () {
    const allowed = yield* call({});
    expect(allowed.runs).toBe(1);
    expect(allowed.authority === undefined ? false : Exit.isSuccess(allowed.authority)).toBe(true);

    const ordinary = yield* call({ managedBrowser: false });
    expect(ordinary.runs).toBe(0);
    const reader = yield* call({ toolProfile: "source-reader" });
    expect(reader.runs).toBe(0);
    const accessOff = yield* call({ enableAgentBrowserAccess: false });
    expect(accessOff.runs).toBe(0);
  }),
);
