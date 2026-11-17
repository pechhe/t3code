import { createMemoryHistory } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const PI = ProviderInstanceId.make("pi");
const PI_DRIVER = ProviderDriverKind.make("pi");

/** A Pi thread whose session publishes extension status text, as pi-blackhole once did. */
function piThreadWithExtensionStatus() {
  const thread = threadWithHistory("thread-pi", 1, { instanceId: PI, model: "luna" });
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread-pi"),
    driver: PI_DRIVER,
    providerInstanceId: PI,
    providerSessionId: ProviderSessionId.make("provider-session-pi"),
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver: PI_DRIVER, nativeId: "native-pi", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: { usedTokens: 274_000, maxTokens: 1_000_000 },
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  const providerSession: OrchestrationV2ProviderSession = {
    id: ProviderSessionId.make("provider-session-pi"),
    driver: PI_DRIVER,
    providerInstanceId: PI,
    status: "ready",
    cwd: "/workspace/render",
    model: "luna",
    capabilities: {
      sessions: {
        supportsMultipleProviderThreadsPerSession: true,
        supportsModelSwitchInSession: true,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: true,
        canRollbackThread: true,
        canForkThread: true,
        canForkFromTurn: true,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: true,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: false,
        supportsQueuedMessages: false,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {},
      approvals: {},
      planning: {},
      subagents: {},
      context: {},
      checkpointing: {},
      identity: {},
    } as OrchestrationV2ProviderSession["capabilities"],
    extensionStatuses: [{ key: "yard", text: "Yardsmith usage n/a" }],
    createdAt: at,
    updatedAt: at,
    lastError: null,
  };
  return { ...thread, providerThreads: [providerThread], providerSessions: [providerSession] };
}

it("keeps Pi's extension status out of the composer", async () => {
  const thread = piThreadWithExtensionStatus();
  using _environment = installFakeEnvironment([thread], { providers: [CODEX_PROVIDER] });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  expect(page.getByText(/Pi · /).query()).toBeNull();
  expect(page.getByText(/Yardsmith usage/).query()).toBeNull();
});
