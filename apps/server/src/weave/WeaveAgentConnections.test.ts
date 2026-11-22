import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentTaskBinding, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { WeaveAgentCallRefused, weaveAgentRole } from "./WeaveAgentConnections.ts";
import {
  delegation,
  hourMs,
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
    assert.notStrictEqual(lead.value, reviewer.value);
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

it.effect("a deeply delegated thread reaches Weave under a reference it accepts", () =>
  Effect.gen(function* () {
    // Each delegated child's id escapes its parent's, so a child of a child of a child repeats
    // two levels of escaping; with the environment it outgrows Weave's 300-character reference.
    const delegatedThread = (parent: string, task: string) =>
      ThreadId.make(
        `thread:delegated-task:command%3Amcp%3A${encodeURIComponent(parent)}%3Adelegate-task%3A${task}`,
      );
    const first = delegatedThread("d779967b-b9af-44b7-881b-f7dd9d53eebe", "lead");
    const second = delegatedThread(first, "chore-storage-methods-throw");
    const third = delegatedThread(second, "review-storage-methods");
    assert.isAbove(`environment-weave/${third}`.length, 300);

    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    const read = yield* call(third, "spec-reviewer", "gpt-5.5");
    assert.isDefined(read.value);
    const ref = weave.agents.at(-1)!.agentRef;
    assert.isAtMost(ref.length, 300);
    assert.match(ref, /^environment-weave\/thread-[0-9a-f]{32}$/);

    // The reference names the thread, not the moment: a renewal and a fresh process both reuse it,
    // so ending the agent Weave holds reaches the same one.
    yield* TestClock.adjust(12 * hourMs);
    yield* call(third, "spec-reviewer", "gpt-5.5");
    assert.strictEqual(weave.agents.length, 1);
    const { weave: restartedWeave, call: callRestarted } = yield* makeHarness;
    yield* callRestarted(third, "spec-reviewer", "gpt-5.5");
    assert.strictEqual(restartedWeave.agents[0]!.agentRef, ref);
    assertNoSecretsIn(read);
  }),
);

it.effect("renewing before expiry keeps the agent", () =>
  Effect.gen(function* () {
    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs - 10 * 60 * 1_000);
    const renewed = yield* call(leadThread);
    assert.strictEqual(weave.tokens.size, 2);
    assert.strictEqual(renewed.value, first.value);
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
    assert.notStrictEqual(after.value, before.value);
  }),
);

it.effect("a revoked agent's thread is refused and T3 reports agent_revoked", () =>
  Effect.gen(function* () {
    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    weave.agents[0]!.revoked = true;
    const refused = yield* call(leadThread).pipe(Effect.flip);
    assert.instanceOf(refused, WeaveAgentCallRefused);
    assert.propertyVal(refused, "code", "agent_revoked");
    assert.strictEqual(weave.agents.length, 1);
    assertNoSecretsIn(refused);
  }),
);

it.effect("a thread asking Weave for a second role is refused as agent_role_conflict", () =>
  Effect.gen(function* () {
    const { call, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    const refused = yield* call(leadThread, "implementer").pipe(Effect.flip);
    assert.instanceOf(refused, WeaveAgentCallRefused);
    assert.propertyVal(refused, "code", "agent_role_conflict");
    assertNoSecretsIn(refused);
  }),
);

it.effect("renewal and reconnect failures report a reason and leak no credential", () =>
  Effect.gen(function* () {
    const { weave, call, assertNoSecretsIn } = yield* makeHarness;
    yield* call(leadThread);
    yield* TestClock.adjust(12 * hourMs);
    weave.state.unreachable = true;
    const unreachable = yield* call(leadThread).pipe(Effect.flip);
    assert.propertyVal(unreachable, "reason", "unavailable");
    weave.state.unreachable = false;
    weave.state.delegationRevoked = true;
    const refused = yield* call(leadThread).pipe(Effect.flip);
    assert.propertyVal(refused, "reason", "unauthorized");
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
    yield* call(leadThread).pipe(Effect.flip);
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

it.effect("one connection serves every thread, and disconnecting stops them all", () =>
  Effect.gen(function* () {
    const { weave, connections, call, assertNoSecretsIn } = yield* makeHarness;
    // A thread T3 first sees after the connection was made, with no delegation of its own.
    const later = ThreadId.make("thread-later");
    const read = yield* call(later);
    assert.isDefined(read.value);
    assert.deepStrictEqual(
      weave.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [{ agentRef: "environment-weave/thread-later", role: "lead" }],
    );

    yield* connections.disconnect;
    const refused = yield* call(later).pipe(Effect.flip);
    assert.propertyVal(refused, "reason", "not_connected");
    const unprepared = ThreadId.make("thread-unconnected");
    assert.propertyVal(yield* call(unprepared).pipe(Effect.flip), "reason", "not_connected");
    assert.lengthOf(weave.agents, 1);
    assertNoSecretsIn(read, refused);
  }),
);

it.effect("calls a tool as an idle thread that nothing has prepared in this process", () =>
  Effect.gen(function* () {
    const { weave, connections, assertNoSecretsIn } = yield* makeHarness;
    weave.tools.call = (name, args) => ({ status: "succeeded", value: { name, args } });
    // What a restart leaves behind: a thread with no Weave connection in memory.
    const idle = ThreadId.make("thread-idle");

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
    assert.isDefined((yield* call(leadThread)).value);
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
    assert.isDefined((yield* call(leadThread)).value);

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
    const { weave, call } = yield* makeHarness;
    const before = yield* call(leadThread);
    const after = yield* call(leadThread, "lead", "claude-sonnet-5-5");
    assert.strictEqual(after.value, before.value);
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
    assert.isDefined(second.value);
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
  const taskFields = {
    taskClass: "non-ui" as const,
    workId: "work",
    attemptId: "1",
    workspacePath: "/workspace",
    requestFingerprint: "a".repeat(64),
    policyHash: "b".repeat(64),
    policyRevision: "test",
    briefHash: "c".repeat(64),
    requested: modelSelection,
    assigned: null,
    effective: modelSelection,
  };
  const recordedTask = (review?: { readonly scope: "change" | "spec" }) =>
    decodeAgentTask({
      ...taskFields,
      role: "reviewer",
      sourceAccess: "read-only",
      toolProfile: "source-reader",
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
    });
  const writerTask = () =>
    decodeAgentTask({
      ...taskFields,
      role: "implementer",
      sourceAccess: "scoped-write",
      toolProfile: "implementation",
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

  it("names the merged implementer to Weave as the pre-merge writer it authorizes", () => {
    assert.strictEqual(
      weaveAgentRole({ lineage: lineage("subagent"), agentTask: writerTask() }),
      "implementation-worker",
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
    assert.isDefined((yield* call(leadThread)).value);
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
