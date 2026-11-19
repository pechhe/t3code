import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertTargetWithinLimits } from "./threadAccess.ts";
import * as ThreadAccess from "./threadAccess.ts";

const environmentId = EnvironmentId.make("environment:external-work-read");
const threadId = ThreadId.make("thread:external-work-owned");
const projectId = ProjectId.make("project:external-work-owned");
const owningSessionId = "mcp-session:external-work-owner";

const pendingRequest = {
  id: "turn-item:pending-request",
  type: "user_input_request",
  status: "pending",
  question: "May I continue with the deployment?",
};

const invocation = (sessionId?: string): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: `client:${sessionId ?? "legacy"}`,
  thread: undefined,
  client:
    sessionId === undefined
      ? undefined
      : { sessionId, label: "External agent", access: "full-access" },
});

const shell = (ownerSessionId?: string) =>
  ({
    id: threadId,
    projectId,
    deletedAt: null,
    ...(ownerSessionId === undefined
      ? {}
      : {
          agentTask: {
            externalOwner: {
              environmentId,
              clientSessionId: ownerSessionId,
              externalSessionKey: "a".repeat(64),
              projectId,
              ceiling: "full-access",
            },
          },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

const threadManagementLayer = (ownerSessionId: string | undefined, recordReads: Ref.Ref<number>) =>
  Layer.succeed(
    ThreadManagement.ThreadManagementService,
    ThreadManagement.ThreadManagementService.of({
      getThreadShell: () => Effect.succeed(shell(ownerSessionId)),
      getProjectThreadRecords: () =>
        Ref.update(recordReads, (count) => count + 1).pipe(
          Effect.as({ turnItems: [pendingRequest] } as never),
        ),
    } as unknown as ThreadManagement.ThreadManagementService["Service"]),
  );

const read = (ownerSessionId: string | undefined, callerSessionId?: string) =>
  Effect.gen(function* () {
    const recordReads = yield* Ref.make(0);
    const result = yield* ThreadAccess.readThread(threadId, ["turnItems"]).pipe(
      Effect.provide(threadManagementLayer(ownerSessionId, recordReads)),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        callerSessionId === undefined
          ? {
              ...invocation(),
              thread: {
                threadId,
                providerSessionId: "provider-session:legacy",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            }
          : invocation(callerSessionId),
      ),
    );
    return { result, recordReads };
  });

it.effect("external work owner can read its pending question evidence", () =>
  Effect.gen(function* () {
    const { result, recordReads } = yield* read(owningSessionId, owningSessionId);
    expect(result.projection.turnItems).toEqual([pendingRequest]);
    expect(yield* Ref.get(recordReads)).toBe(1);
  }),
);

it.effect("a different OAuth session cannot load external work pending question evidence", () =>
  Effect.gen(function* () {
    const recordReads = yield* Ref.make(0);
    const failure = yield* ThreadAccess.readThread(threadId, ["turnItems"]).pipe(
      Effect.provide(threadManagementLayer(owningSessionId, recordReads)),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation("mcp-session:foreign-client"),
      ),
      Effect.flip,
    );

    expect(failure).toBeInstanceOf(OrchestratorMcpFailure);
    expect(failure).toMatchObject({ code: "task_not_found" });
    expect(yield* Ref.get(recordReads)).toBe(0);
  }),
);

it.effect("ordinary legacy thread reads remain available to a public thread caller", () =>
  Effect.gen(function* () {
    const recordReads = yield* Ref.make(0);
    const result = yield* ThreadAccess.readThread(threadId, ["turnItems"]).pipe(
      Effect.provide(threadManagementLayer(undefined, recordReads)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation(),
        thread: {
          threadId,
          providerSessionId: "provider-session:legacy",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
    );

    expect(result.projection.turnItems).toEqual([pendingRequest]);
    expect(yield* Ref.get(recordReads)).toBe(1);
  }),
);

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const claudeCode: McpInvocationContext.McpClientCaller = {
  sessionId: "thread-access",
  label: "Claude Code",
  access: "full-access",
};
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: claudeCode,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const linksHint =
  "Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";

const readBare = (
  existing: ReadonlyArray<OrchestrationV2ThreadShell | ThreadId>,
  scope: McpInvocationContext.McpInvocationScope = client,
  threadId: ThreadId = bareId,
) => {
  const shells = existing.map((shell) =>
    typeof shell === "string" ? liveThreadShell(shell) : shell,
  );
  return ThreadAccess.readThread(threadId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
      }),
    ),
  );
};

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(
      `The thread was not found. Did you mean \`mcp:${bareId}\`? ${linksHint}`,
    );
  }),
);

it.effect("tells a caller with linked environments that the thread may be on one of them", () =>
  Effect.gen(function* () {
    const error = yield* readBare([], { ...client, linkedEnvironments: true });

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain("t3_environment_links");
    expect(error.message).toContain("environmentId");

    const linksOff = yield* readBare([], { ...client, linkedEnvironments: false });
    expect(linksOff.message).toBe("The thread was not found.");
    const peerLink = yield* readBare([], {
      ...client,
      linkedEnvironments: true,
      client: { ...claudeCode, linked: true },
    });
    expect(peerLink.message).toBe("The thread was not found.");

    // A thread a fenced link started may not use this environment's links.
    const fencedThread = ThreadId.make("thread:started-by-fenced-link");
    const fenced = yield* readBare(
      [
        {
          ...liveThreadShell(fencedThread),
          linkOrigin: { sessionId: "peer-session", label: "Laptop", access: "auto" },
        },
      ],
      {
        ...client,
        linkedEnvironments: true,
        client: undefined,
        thread: {
          threadId: fencedThread,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    );
    expect(fenced.message).toBe("The thread was not found.");
  }),
);

it.effect("points an unencoded delegated-task id at the encoded thread it belongs to", () =>
  Effect.gen(function* () {
    const commandId = `command:mcp:${bareId}:delegate-task:0e7d2c41-6b9a-4f3e-8d15-a2c4b6e8f019`;
    const encoded = ThreadId.make(`thread:delegated-task:${encodeURIComponent(commandId)}`);
    const error = yield* readBare(
      [encoded],
      client,
      ThreadId.make(`thread:delegated-task:${commandId}`),
    );

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain(`\`${encoded}\``);
  }),
);

it.effect("identifies the target and effective caller ceiling when a thread write is refused", () =>
  Effect.gen(function* () {
    for (const [runtimeMode, interactionMode, code] of [
      ["approval-required", "default", "runtime_mode_escalation_denied"],
      ["full-access", "plan", "interaction_mode_escalation_denied"],
      ["approval-required", "plan", "runtime_mode_escalation_denied"],
    ] as const) {
      const target = liveThreadShell(bareId, { runtimeMode: "full-access" });
      const error = yield* assertTargetWithinLimits({ runtimeMode, interactionMode }, target).pipe(
        Effect.flip,
      );

      expect(error.code).toBe(code);
      expect(error.message).toContain(bareId);
      expect(error.message).toContain("full-access/default");
      expect(error.message).toContain(`${runtimeMode}/${interactionMode}`);
      expect(error.message).not.toMatch(/child|parent mode/i);
    }
  }),
);
