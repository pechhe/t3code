import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  delegation,
  hourMs,
  hqEndpoint,
  leadThread,
  makeHqHarness as makeHarness,
  origin,
  otherDelegation,
  otherOrigin,
  projectId,
  reviewerThread,
} from "./HqAgentConnections.testkit.ts";

it.effect("a lead and its spec-reviewer reach HQ as two different agents", () =>
  Effect.gen(function* () {
    const { hq, call, assertNoSecretsIn } = yield* makeHarness;
    const lead = yield* call(leadThread);
    const reviewer = yield* call(reviewerThread);
    assert.notStrictEqual(lead.json.result?.agent, reviewer.json.result?.agent);
    assert.deepStrictEqual(
      hq.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [
        { agentRef: "environment-hq/thread-lead", role: "lead" },
        { agentRef: "environment-hq/thread-reviewer", role: "spec-reviewer" },
      ],
    );
    assertNoSecretsIn(lead, reviewer);
  }),
);

it.effect("renewing before expiry keeps the agent", () =>
  Effect.gen(function* () {
    const { hq, call, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs - 10 * 60 * 1_000);
    const renewed = yield* call(leadThread);
    assert.strictEqual(hq.tokens.size, 2);
    assert.strictEqual(renewed.json.result?.agent, first.json.result?.agent);
    assert.notStrictEqual(hq.mcpCalls[0]!.token, hq.mcpCalls[1]!.token);
    assert.isTrue(hq.mcpCalls.every((mcpCall) => mcpCall.agentId !== undefined));
    assertNoSecretsIn(first, renewed);
  }),
);

it.effect("ending a finished agent makes the resumed thread a new agent", () =>
  Effect.gen(function* () {
    const { hq, connections, call } = yield* makeHarness;
    const before = yield* call(reviewerThread);
    yield* connections.end({ threadId: reviewerThread, projectId, role: "spec-reviewer" });
    assert.isTrue(hq.agents[0]!.ended);
    assert.isFalse(hq.agents[0]!.revoked);
    const after = yield* call(reviewerThread);
    assert.notStrictEqual(after.json.result?.agent, before.json.result?.agent);
  }),
);

it.effect("a revoked agent's thread is refused and T3 reports agent_revoked", () =>
  Effect.gen(function* () {
    const { hq, call, logs, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    hq.agents[0]!.revoked = true;
    const refused = yield* call(leadThread);
    assert.strictEqual(refused.status, 200);
    assert.strictEqual(refused.json.error?.data.reason, "agent_revoked");
    assert.include(refused.json.error?.message, "revoked");
    assert.isTrue(logs.some((line) => line.includes("agent_revoked")));
    assert.strictEqual(hq.agents.length, 1);
    assertNoSecretsIn(refused);
  }),
);

it.effect("renewal and reconnect failures report a reason and leak no credential", () =>
  Effect.gen(function* () {
    const { hq, call, logs, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs);
    hq.state.unreachable = true;
    const unreachable = yield* call(leadThread);
    assert.strictEqual(unreachable.json.error?.data.reason, "unavailable");
    hq.state.unreachable = false;
    hq.state.delegationRevoked = true;
    const refused = yield* call(leadThread);
    assert.strictEqual(refused.json.error?.data.reason, "invalid_delegation");
    assert.isAtLeast(logs.length, 2);
    assertNoSecretsIn(unreachable, refused);
  }),
);

it.effect("the delegation is kept only in the server secret store", () =>
  Effect.gen(function* () {
    const { connections, stored } = yield* makeHarness;
    assert.deepStrictEqual(yield* connections.read(projectId), { origin });
    const [entry] = [...stored.values()];
    assert.include(new TextDecoder().decode(entry), delegation);
    yield* connections.disconnect(projectId);
    assert.strictEqual(stored.size, 0);
    assert.isNull(yield* connections.read(projectId));
  }),
);

it.effect("Claude and Codex get a yardsmith-hq server that carries no HQ credential", () =>
  Effect.gen(function* () {
    const { connections, call, assertNoSecretsIn } = yield* makeHarness;
    yield* call(reviewerThread);
    const hqConnection = yield* connections.connection(reviewerThread);
    // A managed reviewer is a leaf: no t3-code, but HQ's role-limited tools.
    const claude = claudeMcpQueryOverrides({
      mcpSession: undefined,
      hqConnection,
      readOnlySandbox: true,
      managedAgent: true,
    });
    const codex = codexThreadRuntimeParams({
      mcpSession: undefined,
      hqConnection,
      runtimePolicy: {
        managedAgent: true,
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      },
    });
    assert.deepStrictEqual(Object.keys(claude.mcpServers ?? {}), ["yardsmith-hq"]);
    assert.include(claude.allowedTools ?? [], "mcp__yardsmith-hq__*");
    const codexServers = codex.config.mcp_servers as Record<string, { url: string }>;
    assert.deepStrictEqual(Object.keys(codexServers), ["yardsmith-hq"]);
    assert.strictEqual(codexServers["yardsmith-hq"]!.url, hqEndpoint);
    assertNoSecretsIn(claude, codex);
  }),
);

it.effect("a project not connected to HQ gives its threads no connection", () =>
  Effect.gen(function* () {
    const { connections } = yield* makeHarness;
    const other = ThreadId.make("thread-elsewhere");
    yield* connections.prepare({
      threadId: other,
      projectId: ProjectId.make("project-other"),
      role: "lead",
      model: "gpt-5.5",
    });
    assert.isUndefined(yield* connections.connection(other));
  }),
);

it.effect("a changed model renews the same agent and records the latest model", () =>
  Effect.gen(function* () {
    const { hq, connections, call } = yield* makeHarness;
    const before = yield* call(leadThread);
    yield* connections.prepare({
      threadId: leadThread,
      projectId,
      role: "lead",
      model: "claude-sonnet-5-5",
    });
    const after = yield* call(leadThread);
    assert.strictEqual(after.json.result?.agent, before.json.result?.agent);
    assert.strictEqual(hq.tokens.size, 2);
    assert.strictEqual(hq.agents[0]!.model, "claude-sonnet-5-5");
  }),
);

it.effect("reconnecting to another HQ never presents one HQ's token to the other", () =>
  Effect.gen(function* () {
    const { hq, connections, call, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* call(leadThread);
    yield* connections.connect({ projectId, origin: otherOrigin, delegation: otherDelegation });
    const second = yield* call(leadThread);
    assert.isDefined(second.json.result);
    assert.deepStrictEqual(
      hq.mcpCalls.map((mcpCall) => mcpCall.origin),
      [origin, otherOrigin],
    );
    for (const mcpCall of hq.mcpCalls)
      assert.strictEqual(hq.tokens.get(mcpCall.token)?.origin, mcpCall.origin);
    assertNoSecretsIn(first, second);
  }),
);
