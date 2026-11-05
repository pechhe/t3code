import { expect, it } from "@effect/vitest";
import {
  DecisionError,
  canUseDecisions,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  isToolListedForSession,
  type AgentRole,
  type AgentToolProfile,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import { request } from "../../../decisions/decisions.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { DecisionToolkit } from "./tools.ts";

const scope = (
  toolProfile?: AgentToolProfile,
  agentRole?: AgentRole,
): Context.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(),
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("test"),
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "test",
  ...(toolProfile === undefined ? {} : { toolProfile }),
  ...(agentRole === undefined ? {} : { agentRole }),
});
const run = (invocation: Context.McpInvocationScope, inactive = false) =>
  Effect.gen(function* () {
    let calls = 0;
    const deps = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, invocation),
      Layer.succeed(DecisionService.DecisionService, {
        decide: () => {
          calls++;
          return Effect.fail(new DecisionError({ code: "unavailable" }));
        },
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(liveThreadShell(id, inactive ? { activeRunId: null } : {})),
      }),
    );
    const toolkit = yield* DecisionToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(deps))),
    );
    const result = yield* toolkit
      .handle("t3_decide", request())
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.exit);
    return { calls, result };
  });
it.effect.each([
  scope("source-reader", "scout"),
  scope("source-reader", "advisor"),
  scope("source-reader", "reviewer"),
  scope("web-research", "researcher"),
  { ...scope(), thread: undefined },
  {
    ...scope(),
    thread: undefined,
    client: { sessionId: "test", label: "test", access: "read-only" as const },
  },
  {
    ...scope(),
    thread: undefined,
    client: { sessionId: "test", label: "test", access: "peer-threads" as const },
  },
])("denies guessed invocations without calling the decision service", (invocation) =>
  Effect.gen(function* () {
    const { calls, result } = yield* run(invocation);
    expect(calls).toBe(0);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result))
      expect(result.value.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }),
);
it.effect("denies stale thread invocations", () =>
  Effect.gen(function* () {
    expect((yield* run(scope(), true)).calls).toBe(0);
  }),
);
it.effect.each([
  scope(),
  scope("implementation", "implementation-worker"),
  scope("implementation-phi", "ui-worker"),
  scope("phi", "browser"),
  scope("phi", "ui-verifier"),
])("authorizes ordinary and managed implementation/browser calls", (invocation) =>
  Effect.gen(function* () {
    expect((yield* run(invocation)).calls).toBe(1);
  }),
);
it("explicitly assigns discovery to decision, excluding source-only and research roles", () => {
  expect(isToolListedForSession("t3_decide", undefined)).toBe(true);
  for (const [toolProfile, agentRole] of [
    ["source-reader", "scout"],
    ["web-research", "researcher"],
    ["implementation", "reviewer"],
  ] as const) {
    expect(canUseDecisions({ toolProfile, agentRole })).toBe(false);
    expect(isToolListedForSession("t3_decide", { toolProfile, agentRole, delegated: true })).toBe(
      false,
    );
  }
  for (const [toolProfile, agentRole] of [
    ["implementation", "implementation-worker"],
    ["phi", "browser"],
  ] as const) {
    expect(isToolListedForSession("t3_decide", { toolProfile, agentRole, delegated: true })).toBe(
      true,
    );
  }
});
