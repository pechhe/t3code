import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  delegation,
  hourMs,
  makeWeaveHarness as makeHarness,
  makeWeaveHarnessAt,
  origin,
  otherDelegation,
  otherOrigin,
} from "./WeaveAgentConnections.testkit.ts";

it.effect("T3 asks Weave for no identity but its own observer (WV-71)", () =>
  Effect.gen(function* () {
    const { weave, connections, read, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* read();
    yield* read();
    yield* connections.decide({ body: { action: "home" } });
    yield* connections.disconnect;
    // Every exchange is the environment's observer, which runs no model: never a thread's agent.
    assert.deepStrictEqual(weave.exchanges, [
      { action: "exchange", agentRef: "environment-weave", role: "observer", harness: "t3" },
      { action: "end", agentRef: "environment-weave", role: "observer" },
    ]);
    assert.isTrue(weave.mcpCalls.every((mcpCall) => mcpCall.agentId === first.value));
    assertNoSecretsIn(first);
  }),
);

it.effect("renewing before expiry keeps the observer", () =>
  Effect.gen(function* () {
    const { weave, read, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* read();
    yield* TestClock.adjust(12 * hourMs - 10 * 60 * 1_000);
    const renewed = yield* read();
    assert.strictEqual(weave.tokens.size, 2);
    assert.strictEqual(renewed.value, first.value);
    assert.notStrictEqual(weave.mcpCalls[0]!.token, weave.mcpCalls[1]!.token);
    assert.isTrue(weave.mcpCalls.every((mcpCall) => mcpCall.agentId !== undefined));
    assertNoSecretsIn(first, renewed);
  }),
);

it.effect("a revoked observer's reads are refused", () =>
  Effect.gen(function* () {
    const { weave, read, assertNoSecretsIn } = yield* makeHarness;
    yield* read();
    weave.agents[0]!.revoked = true;
    yield* TestClock.adjust(12 * hourMs);
    const refused = yield* read().pipe(Effect.flip);
    assert.propertyVal(refused, "reason", "refused");
    assert.strictEqual(weave.agents.length, 1);
    assertNoSecretsIn(refused);
  }),
);

it.effect("renewal and reconnect failures report a reason and leak no credential", () =>
  Effect.gen(function* () {
    const { weave, read, assertNoSecretsIn } = yield* makeHarness;
    yield* read();
    yield* TestClock.adjust(12 * hourMs);
    weave.state.unreachable = true;
    const unreachable = yield* read().pipe(Effect.flip);
    assert.propertyVal(unreachable, "reason", "unavailable");
    weave.state.unreachable = false;
    weave.state.delegationRevoked = true;
    const refused = yield* read().pipe(Effect.flip);
    assert.propertyVal(refused, "reason", "refused");
    assertNoSecretsIn(unreachable, refused);
  }),
);

it.effect("the connection read reports a delegation Weave refused, until it is replaced", () =>
  Effect.gen(function* () {
    const { connections, weave, read } = yield* makeHarness;
    yield* read();
    assert.isFalse((yield* connections.read)?.refused);
    yield* TestClock.adjust(12 * hourMs);
    weave.state.delegationRevoked = true;
    yield* read().pipe(Effect.flip);
    const refused = yield* connections.read;
    assert.strictEqual(refused?.origin, origin);
    assert.isTrue(refused?.refused);
    weave.state.delegationRevoked = false;
    yield* connections.connect({ origin, delegation });
    yield* read();
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

it.effect("disconnecting stops every read", () =>
  Effect.gen(function* () {
    const { weave, connections, read } = yield* makeHarness;
    yield* read();
    yield* connections.disconnect;
    assert.propertyVal(yield* read().pipe(Effect.flip), "reason", "not_connected");
    assert.lengthOf(weave.agents, 1);
    assert.isTrue(weave.agents[0]!.ended);
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

    const { connections, read } = yield* makeWeaveHarnessAt(directory);
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.deepStrictEqual(
      (yield* fileSystem.readDirectory(directory)).filter((file) => /^(hq|weave)-/.test(file)),
      ["weave-connection.bin"],
    );
    assert.isDefined((yield* read()).value);
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
    const { connections, read } = yield* makeWeaveHarnessAt(directory).pipe(
      Effect.provide(logLayer),
    );
    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.isDefined((yield* read()).value);

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

it.effect("reconnecting to another Weave never presents one Weave's token to the other", () =>
  Effect.gen(function* () {
    const { weave, connections, read, assertNoSecretsIn } = yield* makeHarness;
    const first = yield* read();
    yield* connections.connect({ origin: otherOrigin, delegation: otherDelegation });
    const second = yield* read();
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

    const { connections, read } = yield* makeWeaveHarnessAt(directory);

    assert.strictEqual((yield* connections.read)?.origin, origin);
    assert.isDefined((yield* read()).value);
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
