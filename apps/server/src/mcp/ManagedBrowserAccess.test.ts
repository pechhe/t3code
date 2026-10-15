import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { assertManagedBrowserCaller } from "./ManagedBrowserAccess.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
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
