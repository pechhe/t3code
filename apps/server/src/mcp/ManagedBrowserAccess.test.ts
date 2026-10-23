import { expect, it } from "@effect/vitest";
import {
  type AgentRole,
  type AgentToolProfile,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  assertManagedBrowserCaller,
  assertProjectBrowserAccess,
  drivesOwnBrowser,
} from "./ManagedBrowserAccess.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import type { Caller } from "./threadAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-managed-browser-access");
const scope = (managedBrowser: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-managed-browser-access"),
  requestNamespace: "provider-session",
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
  ...(managedBrowser ? { managedBrowser: true as const } : {}),
});
const task = (toolProfile: "phi" | "source-reader") =>
  ({ ...liveThreadShell(threadId), agentTask: { toolProfile } }) as ReturnType<
    typeof liveThreadShell
  >;
const threads = (toolProfile: "phi" | "source-reader") =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(task(toolProfile)),
  });

/** A caller as the tool declarations build it, from the thread's own task binding. */
const callerFor = (agentTask?: {
  readonly role: AgentRole;
  readonly toolProfile: AgentToolProfile;
}): Caller =>
  ({
    scope: scope(false),
    caller: {
      ...liveThreadShell(threadId),
      ...(agentTask === undefined ? {} : { agentTask }),
    },
    limits: { runtimeMode: "full-access", interactionMode: "default" },
  }) as Caller;

const projectMessage = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.orElseSucceed(() => "allowed"),
  );

const check = (input: {
  readonly managedBrowser?: boolean;
  readonly toolProfile?: "phi" | "source-reader";
  readonly checkSettings: boolean;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  assertManagedBrowserCaller({ checkSettings: input.checkSettings }).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      scope(input.managedBrowser ?? true),
    ),
    Effect.provide(
      Layer.mergeAll(threads(input.toolProfile ?? "phi"), ServerSettings.layerTest(input.settings)),
    ),
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.orElseSucceed(() => "allowed"),
  );

it.effect("lets a Phi-pinned task act while its project still allows Phi", () =>
  Effect.gen(function* () {
    expect(
      yield* check({
        checkSettings: true,
        settings: { agentBrowserBackends: { enabled: ["phi"], default: "phi" } },
      }),
    ).toBe("allowed");
    expect(
      yield* check({
        checkSettings: true,
        settings: {
          agentBrowserBackends: { enabled: ["phi", "integrated"], default: "integrated" },
        },
      }),
    ).toBe("allowed");
  }),
);

it.effect(
  "refuses a credential that is not a managed browser task's, or a thread without the pin",
  () =>
    Effect.gen(function* () {
      expect(yield* check({ managedBrowser: false, checkSettings: false })).toContain(
        "managed browser task",
      );
      expect(yield* check({ toolProfile: "source-reader", checkSettings: false })).toContain(
        "not a managed browser task",
      );
    }),
);

it.effect("recognises the roles whose own listing drives a browser", () =>
  Effect.sync(() => {
    for (const [role, toolProfile, expected] of [
      ["browser", "phi", true],
      ["ui-verifier", "phi", true],
      ["spec-reviewer", "source-reader", false],
      ["scout", "source-reader", false],
      ["implementation-worker", "implementation", false],
    ] as const) {
      expect(drivesOwnBrowser(callerFor({ role, toolProfile }))).toBe(expected);
    }
    // An ordinary thread, and a client with no thread, drive no browser of their own.
    expect(drivesOwnBrowser(callerFor())).toBe(false);
    expect(drivesOwnBrowser({ ...callerFor(), caller: undefined })).toBe(false);
  }),
);

it.effect("checks the project's browser access on every call", () =>
  Effect.gen(function* () {
    const caller = callerFor({ role: "browser", toolProfile: "phi" });
    const check = (settings: Parameters<typeof ServerSettings.layerTest>[0] | undefined) =>
      settings === undefined
        ? projectMessage(assertProjectBrowserAccess(caller))
        : projectMessage(
            assertProjectBrowserAccess(caller).pipe(
              Effect.provide(ServerSettings.layerTest(settings)),
            ),
          );

    // The project's default backend may be integrated; Phi only has to be enabled.
    expect(
      yield* check({
        enableAgentBrowserAccess: true,
        agentBrowserBackends: { enabled: ["phi"], default: "phi" },
      }),
    ).toBe("allowed");
    expect(
      yield* check({
        enableAgentBrowserAccess: true,
        agentBrowserBackends: { enabled: ["integrated", "phi"], default: "integrated" },
      }),
    ).toBe("allowed");
    expect(yield* check({ enableAgentBrowserAccess: false })).toBe(
      "Agent browser access was turned off for this project.",
    );
    expect(
      yield* check({ agentBrowserBackends: { enabled: ["integrated"], default: "integrated" } }),
    ).toBe("Phi browsing was turned off for this project.");
    expect(
      yield* check({
        projectSettingsOverrides: {
          [ProjectId.make("project:mcp-test")]: { enableAgentBrowserAccess: false },
        },
      }),
    ).toBe("Agent browser access was turned off for this project.");
    // Without a current answer it refuses rather than acting on a remembered one.
    expect(yield* check(undefined)).toBe(
      "Browser access could not be confirmed; managed browsing is paused.",
    );
  }),
);

it.effect("refuses when the project's browser settings cannot be read", () =>
  Effect.gen(function* () {
    const caller = callerFor({ role: "browser", toolProfile: "phi" });
    const message = yield* projectMessage(
      assertProjectBrowserAccess(caller).pipe(
        Effect.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
            ),
          }),
        ),
      ),
    );
    expect(message).toBe("Browser access could not be confirmed; managed browsing is paused.");
  }),
);

it.effect("refuses protected actions once access is revoked but still lets a tab close", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enableAgentBrowserAccess: false },
      { agentBrowserBackends: { enabled: ["integrated"], default: "integrated" } },
    ] as const) {
      const refused = yield* check({ checkSettings: true, settings });
      expect(refused).not.toBe("allowed");
      expect(yield* check({ checkSettings: false, settings })).toBe("allowed");
    }
  }),
);
