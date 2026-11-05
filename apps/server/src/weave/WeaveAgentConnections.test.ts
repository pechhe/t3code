import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentTaskBinding, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { WeaveAgentCallRefused, weaveAgentRole } from "./WeaveAgentConnections.ts";
import {
  agentMcpServersFor,
  delegation,
  hourMs,
  weaveEndpoint,
  leadThread,
  makeWeaveHarness as makeHarness,
  makeWeaveHarnessAt,
  origin,
  otherDelegation,
  otherOrigin,
  reviewerThread,
} from "./WeaveAgentConnections.testkit.ts";

it.effect("a lead and its spec-reviewer reach Weave as two different agents", () =>
  Effect.gen(function* () {
    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    const lead = yield* call(leadThread);
    const reviewer = yield* call(reviewerThread);
    assert.notStrictEqual(lead.json.result?.agent, reviewer.json.result?.agent);
    assert.deepStrictEqual(
      weave.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [
        { agentRef: "environment-weave/thread-lead", role: "lead" },
        { agentRef: "environment-weave/thread-reviewer", role: "spec-reviewer" },
      ],
    );
    assertNoSecretsIn(lead, reviewer);
  }),
);

it.effect("forwarded Forge writes expire display caches, excluding reads and heartbeats", () =>
  Effect.gen(function* () {
    const { connections, weave } = yield* makeHarness;
    const agent = yield* connections.connection(leadThread);
    let version = yield* connections.buildWriteVersion;
    for (const prefix of ["weave_forge_"]) {
      for (const suffix of [
        "read",
        "list",
        "waits",
        "sessions",
        "acceptance",
        "attempts",
        "heartbeat",
        "set_status",
        "update",
        "bind",
        "start_session",
        "end_session",
        "report",
        "open_hold",
        "clear_hold",
        "relate",
        "associate_landing",
        "post_update",
      ]) {
        const name = `${prefix}${suffix}`;
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
        assert.strictEqual(weave.mcpCalls.at(-1)?.body, new TextDecoder().decode(body));
        if (
          !["read", "list", "waits", "sessions", "acceptance", "attempts", "heartbeat"].includes(
            suffix,
          )
        )
          version++;
        assert.strictEqual(yield* connections.buildWriteVersion, version);
      }
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

it.effect("an interrupted Forge write still expires display caches", () =>
  Effect.gen(function* () {
    const { connections, weave } = yield* makeHarness;
    const agent = yield* connections.connection(leadThread);
    const version = yield* connections.buildWriteVersion;
    weave.state.toolCallsHang = true;
    const received = yield* Deferred.make<void>();
    weave.tools.onCall = Deferred.succeed(received, undefined).pipe(Effect.asVoid);
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
            params: { name: "weave_forge_set_status", arguments: {} },
          }),
        ),
      })
      .pipe(Effect.forkChild);
    // Weave has the write, and may commit it, before the agent goes away.
    yield* Deferred.await(received);
    yield* Fiber.interrupt(forwarding);
    assert.strictEqual(yield* connections.buildWriteVersion, version + 1);
  }),
);

it.effect("renewing before expiry keeps the agent", () =>
  Effect.gen(function* () {
    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs - 10 * 60 * 1_000);
    const renewed = yield* call(leadThread);
    assert.strictEqual(weave.tokens.size, 2);
    assert.strictEqual(renewed.json.result?.agent, first.json.result?.agent);
    assert.notStrictEqual(weave.mcpCalls[0]!.token, weave.mcpCalls[1]!.token);
    assert.isTrue(weave.mcpCalls.every((mcpCall) => mcpCall.agentId !== undefined));
    assertNoSecretsIn(first, renewed);
  }),
);

it.effect("ending a finished agent makes the resumed thread a new agent", () =>
  Effect.gen(function* () {
    const { weave, connections, call } = yield* makeHarness;
    const before = yield* call(reviewerThread);
    yield* connections.end({ threadId: reviewerThread, role: "spec-reviewer" });
    assert.isTrue(weave.agents[0]!.ended);
    assert.isFalse(weave.agents[0]!.revoked);
    const after = yield* call(reviewerThread);
    assert.notStrictEqual(after.json.result?.agent, before.json.result?.agent);
  }),
);

it.effect("a revoked agent's thread is refused and T3 reports agent_revoked", () =>
  Effect.gen(function* () {
    const { weave, call, logs, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    weave.agents[0]!.revoked = true;
    const refused = yield* call(leadThread);
    assert.strictEqual(refused.status, 200);
    assert.strictEqual(refused.json.error?.data.reason, "agent_revoked");
    assert.include(refused.json.error?.message, "revoked");
    assert.isTrue(logs.some((line) => line.includes("agent_revoked")));
    assert.strictEqual(weave.agents.length, 1);
    assertNoSecretsIn(refused);
  }),
);

it.effect("a thread asking Weave for a second role is refused as agent_role_conflict", () =>
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
    const { weave, call, logs, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs);
    weave.state.unreachable = true;
    const unreachable = yield* call(leadThread);
    assert.strictEqual(unreachable.json.error?.data.reason, "unavailable");
    weave.state.unreachable = false;
    weave.state.delegationRevoked = true;
    const refused = yield* call(leadThread);
    assert.strictEqual(refused.json.error?.data.reason, "invalid_delegation");
    assert.isAtLeast(logs.length, 2);
    assertNoSecretsIn(unreachable, refused);
  }),
);

it.effect("the connection read reports a delegation Weave refused, until it is replaced", () =>
  Effect.gen(function* () {
    const { connections, weave, call } = yield* makeHarness;
    yield* call(leadThread);
    assert.isFalse((yield* connections.read)?.refused);
    yield* TestClock.adjust(12 * hourMs);
    weave.state.delegationRevoked = true;
    yield* call(leadThread);
    const refused = yield* connections.read;
    assert.strictEqual(refused?.origin, origin);
    assert.isTrue(refused?.refused);
    weave.state.delegationRevoked = false;
    yield* connections.connect({ origin, delegation });
    yield* call(leadThread);
    assert.isFalse((yield* connections.read)?.refused);
  }),
);

it.effect("the delegation is kept only in the server secret store", () =>
  Effect.gen(function* () {
    const { connections, stored } = yield* makeHarness;
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.deepStrictEqual([...stored.keys()], ["weave-connection"]);
    assert.include(new TextDecoder().decode(stored.get("weave-connection")), delegation);
    yield* connections.disconnect;
    assert.strictEqual(stored.size, 0);
    assert.isNull(yield* connections.read);
  }),
);

it.effect(
  "fresh adapters advertise one canonical Weave server, retaining legacy registrations on request",
  () =>
    Effect.gen(function* () {
      const { connections, call, assertNoSecretsIn } = yield* makeHarness;
      yield* call(reviewerThread);
      const readAgentServers = (threadId: ThreadId, registration?: "canonical" | "legacy") =>
        AgentMcpServers.AgentMcpServers.use((servers) => servers.read(threadId, registration)).pipe(
          Effect.provide(agentMcpServersFor(connections)),
        );
      const agentServers = yield* readAgentServers(reviewerThread);
      assert.deepStrictEqual(
        agentServers.map(({ name, url }) => ({ name, url })),
        [{ name: "weave", url: weaveEndpoint }],
      );
      const legacyServers = yield* readAgentServers(reviewerThread, "legacy");
      assert.deepStrictEqual(
        legacyServers.map(({ name }) => name),
        ["weave", "yardsmith-hq"],
      );
      assert.strictEqual(
        legacyServers[0]!.authorizationHeader,
        legacyServers[1]!.authorizationHeader,
      );
      // A thread Weave never prepared, such as a raw delegated child, gets no server.
      assert.deepStrictEqual(yield* readAgentServers(ThreadId.make("thread-raw-child")), []);
      // A managed reviewer is a leaf: no t3-code, but Weave's role-limited tools.
      const claude = claudeMcpQueryOverrides({
        mcpSession: undefined,
        agentServers,
        readOnlySandbox: true,
        managedAgent: true,
      });
      const codex = codexThreadRuntimeParams({
        mcpSession: undefined,
        agentServers,
        runtimePolicy: {
          managedAgent: true,
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        },
      });
      assert.deepStrictEqual(Object.keys(claude.mcpServers ?? {}), ["weave"]);
      assert.notInclude(claude.allowedTools ?? [], "mcp__yardsmith-hq__*");
      assert.include(claude.allowedTools ?? [], "mcp__weave__*");
      const codexServers = codex.config.mcp_servers as Record<
        string,
        { url: string; default_tools_approval_mode?: string }
      >;
      assert.deepStrictEqual(Object.keys(codexServers), ["weave"]);
      assert.strictEqual(codexServers["weave"]!.url, weaveEndpoint);
      assert.strictEqual(codexServers["weave"]!.default_tools_approval_mode, "approve");
      // Codex denies an unapproved MCP tool under `approval_policy: never`, so its Weave server
      // must pre-approve like Claude's wildcard or a reviewer cannot record its review.
      assertNoSecretsIn(agentServers, claude, codex);
    }),
);

it.effect("one connection serves every thread, and disconnecting stops them all", () =>
  Effect.gen(function* () {
    const { weave, connections, call, assertNoSecretsIn } = yield* makeHarness;
    // A thread T3 first sees after the connection was made, with no delegation of its own.
    const later = ThreadId.make("thread-later");
    yield* connections.prepare({ threadId: later, role: "lead", model: "gpt-5.5" });
    const read = yield* call(later);
    assert.isDefined(read.json.result);
    assert.deepStrictEqual(
      weave.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [{ agentRef: "environment-weave/thread-later", role: "lead" }],
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

it.effect("calls a tool as an idle thread that nothing has prepared in this process", () =>
  Effect.gen(function* () {
    const { weave, connections, assertNoSecretsIn } = yield* makeHarness;
    weave.tools.call = (name, args) => ({ status: "succeeded", value: { name, args } });
    // What a restart leaves behind: a thread with no Weave connection in memory.
    const idle = ThreadId.make("thread-idle");
    assert.isUndefined(yield* connections.connection(idle));

    const result = yield* connections.callAs(
      { threadId: idle, role: "lead", model: "gpt-5.5" },
      "weave_forge_record_usage",
      { inputTokens: 3 },
    );

    assert.deepStrictEqual(result.value, {
      name: "weave_forge_record_usage",
      args: { inputTokens: 3 },
    });
    // The call was made as that thread's own new agent, not as a lead's or an observer's.
    assert.deepStrictEqual(
      weave.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [{ agentRef: "environment-weave/thread-idle", role: "lead" }],
    );
    assert.isDefined(yield* connections.connection(idle));
    assertNoSecretsIn(result);
  }),
);

it.effect("tells Weave's refusal from an unreachable Weave and from a record it already has", () =>
  Effect.gen(function* () {
    const { weave, connections } = yield* makeHarness;
    const agent = { threadId: leadThread, role: "lead", model: "gpt-5.5" };
    weave.tools.call = () => ({ status: "failed", code: "validation_error" });
    const refused = yield* connections
      .callAs(agent, "weave_forge_record_usage", {})
      .pipe(Effect.flip);
    assert.isTrue(isCallRefused(refused));
    if (!isCallRefused(refused)) return;
    assert.strictEqual(refused.code, "validation_error");

    // Weave answering `duplicate` already has the record: the call reached its goal.
    weave.tools.call = () => ({ status: "duplicate", value: { recorded: true } });
    assert.deepStrictEqual(
      (yield* connections.callAs(agent, "weave_forge_record_usage", {})).value,
      {
        recorded: true,
      },
    );

    weave.state.unreachable = true;
    const unavailable = yield* connections
      .callAs(agent, "weave_forge_record_usage", {})
      .pipe(Effect.flip);
    assert.strictEqual(unavailable._tag, "WeaveAgentCallUnavailable");
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
      const { connections } = yield* makeWeaveHarnessAt(directory);
      const moved = yield* connections.read;
      assert.strictEqual(moved?.origin, "https://weave.yardsmith.co.uk");
      assert.isTrue(moved?.refused);

      // Derived from the store, so a restart between landing and reconnecting still asks.
      const { connections: restarted } = yield* makeWeaveHarnessAt(directory);
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
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeCrypto.layer)),
    ),
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

    const { connections, call } = yield* makeWeaveHarnessAt(directory);
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.deepStrictEqual(
      (yield* fileSystem.readDirectory(directory)).filter((file) => /^(hq|weave)-/.test(file)),
      ["weave-connection.bin"],
    );
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "gpt-5.5" });
    assert.isDefined((yield* call(leadThread)).json.result);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeCrypto.layer)),
  ),
);

it.effect("projects with different Weave origins keep one and report the other dropped", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const before = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
      Effect.provide(ServerSecretStore.layerAtDirectory(directory)),
    );
    yield* before.set(
      `hq-connection-${"a".repeat(32)}`,
      new TextEncoder().encode(JSON.stringify({ origin, delegation })),
    );
    yield* before.set(
      `hq-connection-${"b".repeat(32)}`,
      new TextEncoder().encode(
        JSON.stringify({ origin: otherOrigin, delegation: otherDelegation }),
      ),
    );
    const logs: Array<string> = [];
    const logLayer = Logger.layer(
      [Logger.make(({ message }) => void logs.push(NodeUtil.inspect(message, { depth: 10 })))],
      { mergeWithExisting: false },
    );

    // One connection per environment: the first project's in sorted order is kept and usable.
    const { connections, call } = yield* makeWeaveHarnessAt(directory).pipe(
      Effect.provide(logLayer),
    );
    assert.strictEqual((yield* connections.read)?.origin, origin);
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "gpt-5.5" });
    assert.isDefined((yield* call(leadThread)).json.result);

    // The origin that could not be kept is named alongside the one that was.
    const report = logs.find((line) => line.includes(otherOrigin));
    assert.isDefined(report, "the dropped Weave origin is reported");
    assert.include(report, origin);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeCrypto.layer)),
  ),
);

it.effect("a changed model renews the same agent and records the latest model", () =>
  Effect.gen(function* () {
    const { weave, connections, call } = yield* makeHarness;
    const before = yield* call(leadThread);
    yield* connections.prepare({
      threadId: leadThread,
      role: "lead",
      model: "claude-sonnet-5-5",
    });
    const after = yield* call(leadThread);
    assert.strictEqual(after.json.result?.agent, before.json.result?.agent);
    assert.strictEqual(weave.tokens.size, 2);
    assert.strictEqual(weave.agents[0]!.model, "claude-sonnet-5-5");
  }),
);

it.effect("reconnecting to another Weave never presents one Weave's token to the other", () =>
  Effect.gen(function* () {
    const { weave, connections, call, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* call(leadThread);
    yield* connections.connect({ origin: otherOrigin, delegation: otherDelegation });
    const second = yield* call(leadThread);
    assert.isDefined(second.json.result);
    assert.deepStrictEqual(
      weave.mcpCalls.map((mcpCall) => mcpCall.origin),
      [origin, otherOrigin],
    );
    for (const mcpCall of weave.mcpCalls)
      assert.strictEqual(weave.tokens.get(mcpCall.token)?.origin, mcpCall.origin);
    assertNoSecretsIn(first, second);
  }),
);

const decodeAgentTask = Schema.decodeUnknownSync(AgentTaskBinding);
const isCallRefused = Schema.is(WeaveAgentCallRefused);

describe("weaveAgentRole", () => {
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
    assert.strictEqual(weaveAgentRole({ lineage: lineage(null) }), "lead");
    assert.isUndefined(weaveAgentRole({ lineage: lineage("subagent") }));
    assert.isUndefined(weaveAgentRole({ lineage: lineage("fork") }));
  });

  it("maps the merged reviewer to the Forge role for its recorded scope", () => {
    assert.strictEqual(
      weaveAgentRole({ lineage: lineage("subagent"), agentTask: recordedTask() }),
      "ticket-reviewer",
    );
    assert.strictEqual(
      weaveAgentRole({ lineage: lineage("subagent"), agentTask: recordedTask({ scope: "spec" }) }),
      "spec-reviewer",
    );
  });
});

it.effect("a connection stored under the old name moves to the current one at start", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const store = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
      Effect.provide(ServerSecretStore.layerAtDirectory(directory)),
    );
    yield* store.set(
      "hq-connection",
      new TextEncoder().encode(JSON.stringify({ origin, delegation })),
    );

    const { connections, call } = yield* makeWeaveHarnessAt(directory);

    assert.strictEqual((yield* connections.read)?.origin, origin);
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "gpt-5.5" });
    assert.isDefined((yield* call(leadThread)).json.result);
    assert.isTrue(Option.isSome(yield* store.get("weave-connection")));
    assert.isTrue(Option.isNone(yield* store.get("hq-connection")));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeCrypto.layer)),
  ),
);

it.effect("the current connection wins over a leftover one under the old name", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const store = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
      Effect.provide(ServerSecretStore.layerAtDirectory(directory)),
    );
    yield* store.set(
      "weave-connection",
      new TextEncoder().encode(JSON.stringify({ origin, delegation })),
    );
    yield* store.set(
      "hq-connection",
      new TextEncoder().encode(
        JSON.stringify({ origin: otherOrigin, delegation: otherDelegation }),
      ),
    );

    const { connections } = yield* makeWeaveHarnessAt(directory);

    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.isTrue(Option.isNone(yield* store.get("hq-connection")));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeCrypto.layer)),
  ),
);

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        agent: Schema.optional(Schema.String),
        tools: Schema.optional(Schema.Array(Schema.Unknown)),
        instructions: Schema.optional(Schema.String),
        content: Schema.optional(Schema.Array(Schema.Unknown)),
        structuredContent: Schema.optional(Schema.Unknown),
      }),
    }),
  ),
);

it.effect(
  "one registration retains every upstream capability, instructions and permission denial",
  () =>
    Effect.gen(function* () {
      const { connections, weave } = yield* makeHarness;
      weave.tools.catalog = Array.from({ length: 504 }, (_, index) => ({
        name: `weave_fixture_capability_${String(index).padStart(3, "0")}`,
        description: `Fixture capability ${index}`,
        inputSchema: { type: "object", properties: { ref: { type: "string" } } },
      }));
      weave.tools.instructions =
        "Use the session endpoint catalogue. Calls retain the agent’s role and grants.";
      weave.tools.call = (name) => ({ status: "failed", code: "forbidden", name });
      const read = (registration: "canonical" | "legacy") =>
        AgentMcpServers.AgentMcpServers.use((servers) =>
          servers.read(reviewerThread, registration),
        ).pipe(Effect.provide(agentMcpServersFor(connections)));
      const before = yield* read("legacy");
      const after = yield* read("canonical");
      for (const servers of [before, after]) {
        const claude = claudeMcpQueryOverrides({
          mcpSession: undefined,
          agentServers: servers,
          managedAgent: true,
          readOnlySandbox: true,
        });
        const codex = codexThreadRuntimeParams({
          mcpSession: undefined,
          agentServers: servers,
          runtimePolicy: {
            managedAgent: true,
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/fixture",
          },
        });
        assert.deepStrictEqual(
          Object.keys(claude.mcpServers ?? {}),
          servers.map((server) => server.name),
        );
        assert.deepStrictEqual(
          Object.keys(codex.config.mcp_servers as object),
          servers.map((server) => server.name),
        );
        for (const server of servers)
          assert.include(claude.allowedTools ?? [], `mcp__${server.name}__*`);
      }
      const request = (server: AgentMcpServers.AgentMcpServer, method: string, params?: unknown) =>
        connections
          .forward({
            authorization: server.authorizationHeader,
            contentType: undefined,
            accept: undefined,
            protocolVersion: undefined,
            body: new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                ...(params === undefined ? {} : { params }),
              }),
            ),
          })
          .pipe(
            Effect.map(
              (response) => decodeResponse(new TextDecoder().decode(response.body)).result,
            ),
          );
      for (const server of [...before, ...after]) {
        assert.deepStrictEqual((yield* request(server, "tools/list")).tools, weave.tools.catalog);
        assert.strictEqual(
          (yield* request(server, "initialize")).instructions,
          weave.tools.instructions,
        );
        assert.deepStrictEqual(
          yield* request(server, "tools/call", {
            name: weave.tools.catalog[0]!.name,
            arguments: {},
          }),
          {
            content: [],
            structuredContent: {
              status: "failed",
              code: "forbidden",
              name: weave.tools.catalog[0]!.name,
            },
          },
        );
      }
      assert.strictEqual(new Set(weave.mcpCalls.map((call) => call.agentId)).size, 1);
      const material = (servers: ReadonlyArray<AgentMcpServers.AgentMcpServer>) => {
        const names = servers
          .flatMap((server) =>
            weave.tools.catalog.map((tool) => `mcp__${server.name}__${tool.name}`),
          )
          .join("\n");
        const instructions = servers.map(() => weave.tools.instructions).join("\n");
        const schemas = servers.flatMap(() => weave.tools.catalog.map((tool) => tool.inputSchema));
        return {
          servers: servers.length,
          names: servers.length * weave.tools.catalog.length,
          nameChars: names.length,
          nameBytes: new TextEncoder().encode(names).length,
          instructionChars: instructions.length,
          instructionBytes: new TextEncoder().encode(instructions).length,
          schemaChars: JSON.stringify(schemas).length,
          schemaBytes: new TextEncoder().encode(JSON.stringify(schemas)).length,
        };
      };
      assert.deepStrictEqual(material(before), {
        servers: 2,
        names: 1008,
        nameChars: 44855,
        nameBytes: 44855,
        instructionChars: 155,
        instructionBytes: 159,
        schemaChars: 57457,
        schemaBytes: 57457,
      });
      assert.deepStrictEqual(material(after), {
        servers: 1,
        names: 504,
        nameChars: 20663,
        nameBytes: 20663,
        instructionChars: 77,
        instructionBytes: 79,
        schemaChars: 28729,
        schemaBytes: 28729,
      });
    }),
);
