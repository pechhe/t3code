import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentTaskBinding, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { hqAgentRole } from "./HqAgentConnections.ts";
import {
  delegation,
  hourMs,
  hqEndpoint,
  leadThread,
  makeHqHarness as makeHarness,
  makeHqHarnessAt,
  origin,
  otherDelegation,
  otherOrigin,
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

it.effect("forwarded Build writes expire display caches, excluding reads and heartbeats", () =>
  Effect.gen(function* () {
    const { connections, hq } = yield* makeHarness;
    const agent = yield* connections.connection(leadThread);
    let version = yield* connections.buildWriteVersion;
    for (const name of [
      "hq_build_read",
      "hq_build_list",
      "hq_build_waits",
      "hq_build_sessions",
      "hq_build_acceptance",
      "hq_build_attempts",
      "hq_build_heartbeat",
      "hq_build_set_status",
      "hq_build_update",
      "hq_build_bind",
      "hq_build_start_session",
      "hq_build_end_session",
      "hq_build_report",
      "hq_build_open_hold",
      "hq_build_clear_hold",
      "hq_build_relate",
      "hq_build_associate_landing",
      "hq_build_post_update",
    ]) {
      const body = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 88,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      );
      const response = yield* connections.forward({
        authorization: agent!.authorizationHeader,
        contentType: undefined,
        accept: undefined,
        protocolVersion: undefined,
        body,
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(hq.mcpCalls.at(-1)?.body, new TextDecoder().decode(body));
      if (
        ![
          "hq_build_read",
          "hq_build_list",
          "hq_build_waits",
          "hq_build_sessions",
          "hq_build_acceptance",
          "hq_build_attempts",
          "hq_build_heartbeat",
        ].includes(name)
      )
        version++;
      assert.strictEqual(yield* connections.buildWriteVersion, version);
    }
    for (const message of [JSON.stringify({ jsonrpc: "2.0", id: 89, method: "tools/list" })]) {
      yield* connections.forward({
        authorization: agent!.authorizationHeader,
        contentType: undefined,
        accept: undefined,
        protocolVersion: undefined,
        body: new TextEncoder().encode(message),
      });
      assert.strictEqual(yield* connections.buildWriteVersion, version);
    }
  }),
);

it.effect("an interrupted Build write still expires display caches", () =>
  Effect.gen(function* () {
    const { connections, hq } = yield* makeHarness;
    const agent = yield* connections.connection(leadThread);
    const version = yield* connections.buildWriteVersion;
    hq.state.toolCallsHang = true;
    const forwarding = yield* connections
      .forward({
        authorization: agent!.authorizationHeader,
        contentType: undefined,
        accept: undefined,
        protocolVersion: undefined,
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 90,
            method: "tools/call",
            params: { name: "hq_build_set_status", arguments: {} },
          }),
        ),
      })
      .pipe(Effect.forkChild);
    // HQ has the write, and may commit it, before the agent goes away.
    while (hq.toolCalls.length === 0) yield* Effect.yieldNow;
    yield* Fiber.interrupt(forwarding);
    assert.strictEqual(yield* connections.buildWriteVersion, version + 1);
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
    yield* connections.end({ threadId: reviewerThread, role: "spec-reviewer" });
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

it.effect("a thread asking HQ for a second role is refused as agent_role_conflict", () =>
  Effect.gen(function* () {
    const { connections, call, logs, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    yield* connections.prepare({
      threadId: leadThread,
      role: "implementation-worker",
      model: "claude-opus-5-5",
    });
    const refused = yield* call(leadThread);
    assert.strictEqual(refused.json.error?.data.reason, "agent_role_conflict");
    assert.include(refused.json.error?.message, "another role");
    assert.isTrue(logs.some((line) => line.includes("agent_role_conflict")));
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

it.effect("the connection read reports a delegation HQ refused, until it is replaced", () =>
  Effect.gen(function* () {
    const { connections, hq, call } = yield* makeHarness;
    yield* call(leadThread);
    assert.isFalse((yield* connections.read)?.refused);
    yield* TestClock.adjust(12 * hourMs);
    hq.state.delegationRevoked = true;
    yield* call(leadThread);
    const refused = yield* connections.read;
    assert.strictEqual(refused?.origin, origin);
    assert.isTrue(refused?.refused);
    hq.state.delegationRevoked = false;
    yield* connections.connect({ origin, delegation });
    yield* call(leadThread);
    assert.isFalse((yield* connections.read)?.refused);
  }),
);

it.effect("the delegation is kept only in the server secret store", () =>
  Effect.gen(function* () {
    const { connections, stored } = yield* makeHarness;
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.deepStrictEqual([...stored.keys()], ["hq-connection"]);
    assert.include(new TextDecoder().decode(stored.get("hq-connection")), delegation);
    yield* connections.disconnect;
    assert.strictEqual(stored.size, 0);
    assert.isNull(yield* connections.read);
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

it.effect("one connection serves every thread, and disconnecting stops them all", () =>
  Effect.gen(function* () {
    const { hq, connections, call, assertNoSecretsIn } = yield* makeHarness;
    // A thread T3 first sees after the connection was made, with no delegation of its own.
    const later = ThreadId.make("thread-later");
    yield* connections.prepare({ threadId: later, role: "lead", model: "gpt-5.5" });
    const read = yield* call(later);
    assert.isDefined(read.json.result);
    assert.deepStrictEqual(
      hq.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [{ agentRef: "environment-hq/thread-later", role: "lead" }],
    );

    yield* connections.disconnect;
    const refused = yield* call(later);
    assert.strictEqual(refused.json.error?.data.reason, "not_connected");
    const unprepared = ThreadId.make("thread-unconnected");
    yield* connections.prepare({ threadId: unprepared, role: "lead", model: "gpt-5.5" });
    assert.isUndefined(yield* connections.connection(unprepared));
    assertNoSecretsIn(read, refused);
  }),
);

it.effect(
  "a connection stored at Weave's old address is used at the current one and asks for a reconnect",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const store = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(ServerSecretStore.layerAtDirectory(directory)),
      );
      yield* store.set(
        "hq-connection",
        new TextEncoder().encode(
          JSON.stringify({ origin: "https://hq.yardsmith.co.uk", delegation }),
        ),
      );

      // Weave refuses a delegation made for the address it moved from, so the connection names the
      // current address and asks for a reconnect instead of reporting one that cannot work.
      const { connections } = yield* makeHqHarnessAt(directory);
      const moved = yield* connections.read;
      assert.strictEqual(moved?.origin, "https://weave.yardsmith.co.uk");
      assert.isTrue(moved?.refused);

      // Derived from the store, so a restart between landing and reconnecting still asks.
      const { connections: restarted } = yield* makeHqHarnessAt(directory);
      assert.strictEqual((yield* restarted.read)?.origin, "https://weave.yardsmith.co.uk");
      assert.isTrue((yield* restarted.read)?.refused);

      // Reconnecting replaces the delegation, and nothing is refused afterwards.
      yield* restarted.connect({
        origin: "https://weave.yardsmith.co.uk",
        delegation: otherDelegation,
      });
      const reconnected = yield* restarted.read;
      assert.strictEqual(reconnected?.origin, "https://weave.yardsmith.co.uk");
      assert.isFalse(reconnected?.refused);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a project's stored connection becomes the environment's, stored once", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    // What a project connection was stored as: an entry named after a hash of its project id.
    const before = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
      Effect.provide(ServerSecretStore.layerAtDirectory(directory)),
    );
    yield* before.set(
      `hq-connection-${"a".repeat(32)}`,
      new TextEncoder().encode(JSON.stringify({ origin, delegation })),
    );

    const { connections, call } = yield* makeHqHarnessAt(directory);
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.deepStrictEqual(
      (yield* fileSystem.readDirectory(directory)).filter((file) => file.startsWith("hq-")),
      ["hq-connection.bin"],
    );
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "gpt-5.5" });
    assert.isDefined((yield* call(leadThread)).json.result);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a changed model renews the same agent and records the latest model", () =>
  Effect.gen(function* () {
    const { hq, connections, call } = yield* makeHarness;
    const before = yield* call(leadThread);
    yield* connections.prepare({
      threadId: leadThread,
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
    yield* connections.connect({ origin: otherOrigin, delegation: otherDelegation });
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

const decodeAgentTask = Schema.decodeUnknownSync(AgentTaskBinding);

describe("hqAgentRole", () => {
  const lineage = (relationshipToParent: "fork" | "subagent" | null) => ({
    parentThreadId: relationshipToParent === null ? null : ThreadId.make("thread-parent"),
    relationshipToParent,
    rootThreadId: ThreadId.make("thread-parent"),
  });
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
  const recordedTask = (review?: { readonly scope: "change" | "spec" }) =>
    decodeAgentTask({
      role: "reviewer",
      taskClass: "non-ui",
      workId: "work",
      attemptId: "1",
      workspacePath: "/workspace",
      ...(review === undefined
        ? {}
        : {
            review: {
              ...review,
              baseRevision: "base",
              includedChanges: ["change"],
              coverage: "complete",
            },
          }),
      requestFingerprint: "a".repeat(64),
      policyHash: "b".repeat(64),
      policyRevision: "test",
      briefHash: "c".repeat(64),
      sourceAccess: "read-only",
      toolProfile: "source-reader",
      requested: modelSelection,
      assigned: null,
      effective: modelSelection,
    });

  it("is lead only for a top-level thread, and none for a raw child or a fork without a task", () => {
    assert.strictEqual(hqAgentRole({ lineage: lineage(null) }), "lead");
    assert.isUndefined(hqAgentRole({ lineage: lineage("subagent") }));
    assert.isUndefined(hqAgentRole({ lineage: lineage("fork") }));
  });

  it("is a recorded reviewer task's canonical role, never the retired name", () => {
    assert.strictEqual(
      hqAgentRole({ lineage: lineage("subagent"), agentTask: recordedTask() }),
      "ticket-reviewer",
    );
    assert.strictEqual(
      hqAgentRole({ lineage: lineage("subagent"), agentTask: recordedTask({ scope: "spec" }) }),
      "spec-reviewer",
    );
  });
});
