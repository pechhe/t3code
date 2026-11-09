import { expect, it } from "@effect/vitest";
import {
  type AgentRole,
  READ_ONLY_ROLES,
  type AgentTaskBinding,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { assertDecisionCaller } from "./toolkits/decisions/handlers.ts";
import { assertBoundedBrowserCaller, boundedBrowserEligible } from "./ManagedBrowserAccess.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-bounded-browser");
const environmentId = EnvironmentId.make("environment-bounded-browser");

const task = (role: AgentRole, extra: Partial<AgentTaskBinding> = {}) =>
  ({
    role,
    toolProfile: role === "reviewer" || role === "scout" ? "source-reader" : "implementation",
    sourceAccess: READ_ONLY_ROLES.has(role) ? "read-only" : "scoped-write",
    ...extra,
  }) as AgentTaskBinding;

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  modes: Parameters<typeof liveThreadShell>[1] = {},
): OrchestrationV2ThreadShell => ({ ...liveThreadShell(threadId, modes), ...overrides });

const subagent = {
  rootThreadId: threadId,
  parentThreadId: threadId,
  relationshipToParent: "subagent",
} as const;

const scope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `thread:${threadId}`,
  thread: {
    threadId,
    providerSessionId: "provider-session-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "preview"]),
  issuedAt: 1,
  boundedBrowser: true,
  ...overrides,
});

const browsingOn = {
  enableAgentBrowserAccess: true,
  agentBrowserBackends: { enabled: ["integrated", "phi"], default: "phi" },
} as const;

const attempt = (input: {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly shell?: OrchestrationV2ThreadShell;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly checkSettings?: boolean;
}) =>
  assertBoundedBrowserCaller({ checkSettings: input.checkSettings ?? true }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.scope ?? scope()),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(input.shell ?? shell()),
        }),
        ServerSettings.layerTest(input.settings ?? browsingOn),
      ),
    ),
  );

const refusal = (effect: ReturnType<typeof attempt>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.orElseSucceed(() => "allowed"),
  );

it("grants bounded browsing only from what the server recorded about the thread", () => {
  // Ordinary threads, forks, side chats and scheduled runs carry no task record and no parent.
  expect(boundedBrowserEligible(shell())).toBe(true);
  expect(boundedBrowserEligible(shell({ agentTask: task("lead"), lineage: subagent }))).toBe(true);
  for (const role of ["chore-worker", "implementation-worker", "ui-worker"] as const)
    expect(boundedBrowserEligible(shell({ agentTask: task(role), lineage: subagent })), role).toBe(
      true,
    );
  for (const role of ["reviewer"] as const) {
    expect(boundedBrowserEligible(shell({ agentTask: task(role), lineage: subagent })), role).toBe(
      false,
    );
    expect(
      boundedBrowserEligible(
        shell({ agentTask: task(role, { browserTasks: true }), lineage: subagent }),
      ),
      role,
    ).toBe(true);
  }
  // A recorded grant cannot widen the roles that may hold one.
  for (const role of ["advisor", "scout", "researcher", "browser", "ui-verifier"] as const)
    expect(
      boundedBrowserEligible(
        shell({ agentTask: task(role, { browserTasks: true }), lineage: subagent }),
      ),
      role,
    ).toBe(false);
  // A subagent missing its task record is not an ordinary thread.
  expect(boundedBrowserEligible(shell({ lineage: subagent }))).toBe(false);
  // Work owned by an outside client or another environment is never granted it.
  expect(
    boundedBrowserEligible(
      shell({
        agentTask: task("reviewer", {
          browserTasks: true,
          externalOwner: {} as NonNullable<AgentTaskBinding["externalOwner"]>,
        }),
        lineage: subagent,
      }),
    ),
  ).toBe(false);
  expect(boundedBrowserEligible(shell({ linkOrigin: { sessionId: "peer", label: "Peer" } }))).toBe(
    false,
  );
  expect(
    boundedBrowserEligible(
      shell({ delegatedFrom: { environmentId, threadId: ThreadId.make("other"), title: "x" } }),
    ),
  ).toBe(false);
});

it.effect("acts on the thread's own bounded lane: integrated, fresh storage, no profile", () =>
  Effect.gen(function* () {
    const allowed = yield* attempt({});
    expect(allowed.scope.browserLane).toBe("bounded");
    expect(allowed.scope.managedBrowser).toBe(true);
    expect(allowed.scope.taskBrowser).toEqual({ backend: "integrated" });
    expect(allowed.scope.browserBackends).toEqual({
      enabled: ["integrated"],
      default: "integrated",
    });
    expect(allowed.scope.managedProjectId).toBe(shell().projectId);
    expect([...allowed.scope.capabilities]).toEqual(["preview"]);
    // Another provider session of the same thread, or the session's own preview tools, own other tabs.
    const own = McpInvocationContext.browserOwnerKey(allowed.scope);
    expect(own).not.toBe(
      McpInvocationContext.browserOwnerKey({
        ...allowed.scope,
        thread: { ...allowed.scope.thread, providerSessionId: "provider-session-b" },
      }),
    );
    const { browserLane: _lane, ...previewLane } = allowed.scope;
    expect(own).not.toBe(McpInvocationContext.browserOwnerKey(previewLane));
  }),
);

it.effect("refuses callers the credential or live thread does not entitle", () =>
  Effect.gen(function* () {
    const { boundedBrowser: _grant, ...ungranted } = scope();
    expect(yield* refusal(attempt({ scope: ungranted }))).toContain(
      "not available to this session",
    );
    // An outside OAuth client has no thread of its own.
    expect(
      yield* refusal(
        attempt({
          scope: scope({
            thread: undefined,
            client: { sessionId: "client", label: "Client", access: "full-access" },
          }),
        }),
      ),
    ).toContain("not available to this session");
    expect(yield* refusal(attempt({ shell: shell({}, { activeRunId: null }) }))).toContain(
      "no longer owns an active thread run",
    );
    // A credential minted for a reviewer cannot act for a thread whose live task differs.
    expect(
      yield* refusal(
        attempt({
          scope: scope({ agentRole: "reviewer" }),
          shell: shell({ agentTask: task("lead"), lineage: subagent }),
        }),
      ),
    ).toContain("may not run bounded browser tasks");
    expect(
      yield* refusal(
        attempt({
          scope: scope({ agentRole: "scout" }),
          shell: shell({ agentTask: task("scout", { browserTasks: true }), lineage: subagent }),
        }),
      ),
    ).toContain("may not run bounded browser tasks");
    expect(
      yield* refusal(
        attempt({
          scope: scope({ agentRole: "reviewer" }),
          shell: shell({
            agentTask: task("reviewer", { browserTasks: true }),
            lineage: subagent,
          }),
        }),
      ),
    ).toBe("allowed");
  }),
);

it.effect("rechecks the project's integrated browsing on every effect, but not on cleanup", () =>
  Effect.gen(function* () {
    const off = { enableAgentBrowserAccess: false };
    const phiOnly = { agentBrowserBackends: { enabled: ["phi"], default: "phi" } } as const;
    expect(yield* refusal(attempt({ settings: off }))).toContain("turned off");
    expect(yield* refusal(attempt({ settings: phiOnly }))).toContain("turned off");
    expect(yield* refusal(attempt({ settings: off, checkSettings: false }))).toBe("allowed");
    const unreadable = assertBoundedBrowserCaller({ checkSettings: true }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope()),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell()),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
            ),
          }),
        ),
      ),
    );
    expect((yield* Effect.flip(unreadable)).message).toContain("could not be confirmed");
  }),
);

it.effect("gives a reviewer's bounded grant no general decision access", () =>
  Effect.gen(function* () {
    const reviewer = scope({ agentRole: "reviewer", toolProfile: "source-reader" });
    const denied = yield* assertDecisionCaller.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, reviewer),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed(
              shell({ agentTask: task("reviewer", { browserTasks: true }), lineage: subagent }),
            ),
        }),
      ),
      Effect.flip,
    );
    expect(denied.message).toContain("decision-enabled");
  }),
);
