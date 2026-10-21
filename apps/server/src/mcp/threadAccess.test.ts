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
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  ThreadAccess.readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("keeps the plain message for an id that matches nothing", () =>
  Effect.gen(function* () {
    const error = yield* readBare([]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe("The thread was not found.");
  }),
);
